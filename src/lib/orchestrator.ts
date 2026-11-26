import { readFileSync } from 'node:fs';
import path from 'node:path';
import { CONFIG_DIR, PKG_ROOT } from './paths.js';
import { loadModelsConfig, type ModelsConfig } from '../llm/config.js';
import { Budget, RoleLlm } from '../llm/factory.js';
import type { ReviewerLlm } from '../llm/types.js';
import { runAgent } from '../agents/base.js';
import { consolidate, type ConsolidatedFinding } from '../agents/consolidator.js';
import { gapCheckUncoveredFiles } from '../agents/gap.js';
import { mergeCloseFindings } from './dedupe.js';
import { describeFixes, fixProse } from './prose.js';
import { buildSummaryComment, computeVerdict } from './summary.js';
import { countTiers, prScoreOf, renderReport } from './output.js';
import { shouldTeach, teachScoringConfig, DEFAULT_TEACH_BELOW } from './scoring.js';
import { teach, teachStats } from '../agents/teach.js';
import {
  heimdallPriorBuckets,
  humanThreadFor,
  inlineBody,
  lineBucket,
  postInlineReview,
  postSummary,
  replyInThread,
  whoami,
  type PostResult,
} from './post.js';
import { createGh, type GhRunner } from './gh.js';
import { writeRun, type RunArtifact } from './runs.js';
import type {
  AgentResult,
  CoverageRow,
  GapCheckResult,
  ReviewContext,
  RunSummary,
  TeachRunRecord,
} from './types.js';
import { AGENT_NAMES } from './types.js';
import { mapWithConcurrency } from './util.js';
import type { ReviewSource } from '../sources/source.js';

export interface OrchestratorOptions {
  source: ReviewSource;
  preset?: string;
  post: boolean;
  issueFlag?: number;
  runsDir?: string;
  gh?: GhRunner;
  fetchImpl?: typeof fetch;
  log?: (msg: string) => void;
  /** injectable for eval + tests (ScriptedLlm or a real RoleLlm) */
  llmFactory?: (cfg: ModelsConfig, budget: Budget, fetchImpl: typeof globalThis.fetch) => ReviewerLlm;
  /**
   * Explain the findings that scored low, after consolidation. Off by default:
   * a run without it is byte-identical to a run without this feature.
   */
  teach?: boolean;
  /** normalized 0-100 bar for this run; beats the repo manifest and the config */
  teachBelow?: number;
}

export interface OrchestratorResult {
  summary: RunSummary;
  report: string;
  consolidated: ConsolidatedFinding[];
  posted?: PostResult;
  artifactPath?: string;
}

export async function runReview(opts: OrchestratorOptions): Promise<OrchestratorResult> {
  const log = opts.log ?? ((m) => process.stderr.write(`  ${m}\n`));
  const ctx = await opts.source.buildContext(opts.issueFlag);
  log(`PR #${ctx.prNumber} "${ctx.pr.title}" — ${ctx.files.length} file(s) in scope, ${ctx.skipped.length} skipped`);
  if (ctx.ticket) log(`ticket #${ctx.ticket.number} via ${ctx.ticketSource}`);
  else log('no linked ticket — requirements UNVERIFIED (declared, not guessed)');

  const instructionPaths = (ctx.agentInstructions ?? []).map((f) => f.path);
  log(instructionPaths.length ? `agent instructions: ${instructionPaths.join(', ')}` : 'agent instructions: none detected');

  const cfg = loadModelsConfig(path.join(CONFIG_DIR, 'models.json'));
  if (opts.preset) cfg.preset = opts.preset;
  else if (ctx.manifest.preset) cfg.preset = ctx.manifest.preset;

  const budget = new Budget(ctx.manifest.budgetUsd);
  const fetchImpl = opts.fetchImpl ?? fetch;
  const llm = opts.llmFactory
    ? opts.llmFactory(cfg, budget, fetchImpl)
    : new RoleLlm(cfg, budget, fetchImpl);

  const scoring = JSON.parse(readFileSync(path.join(CONFIG_DIR, 'scoring.json'), 'utf8')) as import('./scoring.js').ScoringConfig;

  const enabled = AGENT_NAMES.filter((a) => ctx.manifest.agents[a].enabled);
  log(`specialists: ${enabled.join(', ')} | preset=${cfg.preset} budget=$${ctx.manifest.budgetUsd}`);

  // STEP 2 — specialists in parallel, each with its own mandatory second pass.
  const t0 = Date.now();
  const results = await mapWithConcurrency(enabled, enabled.length, (a) =>
    runAgent(a, ctx, {
      llm,
      resolve: (r) => llm.describe(r),
      scoring,
      log,
    }),
  );
  const agentResults = results.filter(Boolean) as AgentResult[];
  log(`specialists done in ${((Date.now() - t0) / 1000).toFixed(1)}s`);

  const rawFindings = agentResults.flatMap((r) => r.findings);
  const totalDropped = agentResults.reduce((s, r) => s + r.dropped, 0);
  log(`${rawFindings.length} survived, ${totalDropped} dropped by pass-2 verification`);

  // STEP 3 — consolidate: dedupe close findings, gap-check silent files, merge voice.
  const merged = mergeCloseFindings(rawFindings);
  const flagged = new Set(merged.map((f) => f.file));
  let gaps: GapCheckResult[] = [];
  if (ctx.files.some((f) => !flagged.has(f.path))) {
    log('gap-checking files no specialist flagged…');
    gaps = await gapCheckUncoveredFiles(ctx, flagged, llm, log);
  }

  let consolidated: ConsolidatedFinding[] = [];
  if (merged.length) {
    log('consolidating + normalizing voice…');
    consolidated = await consolidate(merged, llm, log);
  }

  // STEP 3b — teach mode. Deliberately last: pass 1, the pass-2 verifier, the
  // dedupe, the gap-check and the consolidator all read the terse findings they
  // read without the flag, so teaching cannot move a verdict.
  let teachRecord: TeachRunRecord | undefined;
  if (opts.teach) {
    // Only the teaching bar moves: the weights and tiers stay the map the
    // specialists and the verifier were scored against.
    const override = opts.teachBelow ?? ctx.manifest.teach?.below;
    const teachScoring = teachScoringConfig(scoring, override === undefined ? undefined : { below: override });
    const below = teachScoring.teach?.below ?? DEFAULT_TEACH_BELOW;
    const eligible = consolidated.filter((c) => shouldTeach(c.finding, teachScoring)).length;
    log(`teach mode: explaining findings under ${below}/100 — ${eligible} of ${consolidated.length} qualify`);
    const before = consolidated;
    if (eligible) consolidated = await teach(before, ctx, llm, { scoring: teachScoring }, log);
    const { taught, fallback } = teachStats(before, consolidated, teachScoring);
    teachRecord = { below, eligible, taught, fallback };
    if (fallback) log(`teach mode: ${fallback} finding(s) kept the terse comment (reason declared above)`);
  }

  const finalFindings = consolidated.map((c) => c.finding);
  const counts = countTiers(finalFindings);
  const modelsUsed = [...llm.used.values()];
  const coverage: CoverageRow[] = agentResults.map((r) => ({
    agent: r.agent,
    status: r.status,
    model: r.model,
    capability: r.capability,
    findings: r.findings.length,
    dropped: r.dropped,
  }));

  const pr = prScoreOf(counts);
  // A clean PR scores 100 — that is the point. Only a run where NO specialist
  // completed may not claim a number.
  const allAgentsFailed = agentResults.length > 0 && agentResults.every((r) => r.status === 'failed');
  const summary: RunSummary = {
    verdict: computeVerdict(counts),
    prScore: allAgentsFailed ? null : pr.score,
    prBand: allAgentsFailed ? null : `${pr.icon} ${pr.band}`,
    counts,
    coverage,
    gaps,
    notReviewed: ctx.skipped,
    requirementsVerified: ctx.requirementsVerified,
    usedBasicModel: llm.usedBasicModel,
    contextTruncated: ctx.contextTruncated,
    modelsUsed,
    budgetUsd: ctx.manifest.budgetUsd,
    spentUsd: budget.spentUsd,
    ...(teachRecord ? { teach: teachRecord } : {}),
  };

  const report = renderReport(ctx.repo, ctx.prNumber, consolidated, summary);

  // artifact is ALWAYS written (even dry-run) — this is the calibration dataset.
  const runsDir = opts.runsDir ?? path.join(PKG_ROOT, 'runs');
  const artifact = writeRun(runsDir, {
    repo: ctx.repo,
    prNumber: ctx.prNumber,
    ts: new Date().toISOString(),
    preset: cfg.preset,
    verdict: summary.verdict,
    prScore: summary.prScore,
    findings: finalFindings,
    coverage,
    gaps,
    modelsUsed,
    spentUsd: budget.spentUsd,
    ...(teachRecord ? { teach: teachRecord } : {}),
    posted: {},
  } satisfies RunArtifact);
  log(`run artifact: ${path.relative(process.cwd(), artifact)}`);

  const failedAgents = agentResults.filter((r) => r.status === 'failed');
  if (failedAgents.length) log(`⚠️ ${failedAgents.length} specialist(s) failed: ${failedAgents.map((r) => r.agent).join(', ')}`);

  if (!opts.post) {
    return { summary, report, consolidated, artifactPath: artifact };
  }

  const posted = await publish(ctx, consolidated, summary, opts.gh ?? createGh(), log);
  return { summary, report, consolidated, posted, artifactPath: artifact };
}

async function publish(
  ctx: ReviewContext,
  consolidated: ConsolidatedFinding[],
  summary: RunSummary,
  gh: GhRunner,
  log: (m: string) => void,
): Promise<PostResult> {
  const me = await whoami(gh);
  const prior = await heimdallPriorBuckets(gh, ctx.repo, ctx.prNumber, me);
  log(`posting as ${me}; ${prior.size} of my prior inline comments found (self-dedupe)`);

  const result: PostResult = {
    reviewSubmitted: false,
    inlineUrls: [],
    threadReplies: [],
    skippedDuplicates: [],
    updatedSummary: false,
  };

  const inlineItems: { path: string; line: number; body: string }[] = [];
  let blockersPosted = 0;
  for (const c of consolidated) {
    const f = c.finding;
    const bucket = lineBucket(f.file, f.line);
    if (prior.has(bucket)) {
      result.skippedDuplicates.push(bucket);
      continue; // an earlier run already gated this line
    }
    // If a human already has an unresolved thread nearby, reply in-thread
    // instead of dropping a fresh comment beside theirs.
    const thread = humanThreadFor(f, ctx.comments, me, ctx.threadsTrusted);
    if (thread) {
      const url = await replyInThread(gh, ctx.repo, ctx.prNumber, thread, inlineBody(f, c.comment));
      if (url) result.threadReplies.push(url);
      if (f.tier === 'blocker') blockersPosted++;
      continue;
    }
    inlineItems.push({ path: f.file, line: f.line, body: inlineBody(f, c.comment) });
    if (f.tier === 'blocker') blockersPosted++;
  }

  if (inlineItems.length || blockersPosted > 0) {
    // A blocker posted this run is the condition that blocks the PR: escalate
    // the review event. Never APPROVE under any counts.
    const requestChanges = blockersPosted > 0;
    log(`review event: ${requestChanges ? 'REQUEST_CHANGES' : 'COMMENT'} (${blockersPosted} blocker(s) posted)`);
    const review = await postInlineReview(gh, ctx.repo, ctx.prNumber, ctx.pr.headSha, inlineItems, requestChanges);
    result.inlineUrls = review.inlineUrls;
    result.reviewSubmitted = review.submitted;
  }

  const body = fixProse(
    buildSummaryComment(ctx.repo, ctx.prNumber, consolidated.map((c) => c.finding), summary, blockersPosted > 0),
  );
  if (body.fixes.length) log(`prose gate: summary fixed ${describeFixes(body.fixes)}`);
  const summaryRes = await postSummary(gh, ctx.repo, ctx.prNumber, body.text);
  result.summaryUrl = summaryRes.url;
  result.updatedSummary = summaryRes.updated;
  log(`summary ${summaryRes.updated ? 'updated' : 'posted'}: ${summaryRes.url}`);
  return result;
}
