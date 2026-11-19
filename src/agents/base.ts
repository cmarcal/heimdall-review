import type { LlmForRole } from '../llm/types.js';
import { completeJson } from '../llm/json.js';
import { BudgetExceededError } from '../llm/budget.js';
import { candidateArraySchema, verifiedArraySchema, type Candidate } from '../lib/finding.js';
import { findingId, scoreAndTier, type ScoringConfig } from '../lib/scoring.js';
import type { AgentName, AgentResult, Capability, ReviewContext, VerifiedFinding } from '../lib/types.js';
import { buildContextPack, packBudget, pass1System, pass2System } from './prompt.js';

export interface AgentDeps {
  llm: LlmForRole;
  resolve(role: AgentName): { model: string; capability: Capability };
  scoring: ScoringConfig;
  log?: (msg: string) => void;
}

/**
 * One specialist, two passes. Pass 1 proposes; pass 2 verifies against the
 * real code and deletes anything it cannot quote. A finding only survives if
 * its verifiedEvidence appears VERBATIM in the file content — that check runs
 * in the harness, not in the model, so no hallucinated quote ships.
 */
export async function runAgent(
  agent: AgentName,
  ctx: ReviewContext,
  deps: AgentDeps,
): Promise<AgentResult> {
  const log = deps.log ?? (() => {});
  const capability = deps.resolve(agent).capability;
  const model = deps.resolve(agent).model;
  const { pack } = buildContextPack(ctx, agent, packBudget(capability));
  const empty = (status: AgentResult['status'], note: string, findings: VerifiedFinding[] = [], dropped = 0): AgentResult => ({
    agent,
    status,
    findings,
    dropped,
    model,
    capability,
    note,
  });

  let candidates: Candidate[];
  try {
    const res = await completeJson(
      deps.llm,
      agent,
      pass1System(agent),
      pack,
      candidateArraySchema,
    );
    candidates = res.data;
  } catch (err) {
    if (err instanceof BudgetExceededError) return empty('partial', `stopped: ${err.message}`);
    return empty('failed', `pass 1 failed: ${(err as Error).message.slice(0, 200)}`);
  }

  const changedFiles = new Set(ctx.files.map((f) => f.path));
  candidates = candidates.filter((c) => changedFiles.has(c.file));
  if (!candidates.length) return empty('done', 'no candidates in scope');

  try {
    const user = `${pack}\n\n## Candidates to verify (from ${agent})\n${JSON.stringify(candidates, null, 2)}`;
    const verifyRes = await completeJson(deps.llm, 'verifier', pass2System(), user, verifiedArraySchema);

    const contentByFile = new Map(ctx.files.map((f) => [f.path, f.content ?? '']));
    const kept: VerifiedFinding[] = [];
    let dropped = 0;

    for (const v of verifyRes.data) {
      if (v.status === 'drop') {
        dropped++;
        continue;
      }
      const fileContent = contentByFile.get(v.file) ?? '';
      // Anti-hallucination gate: the quote must exist in the real head content.
      if (v.verifiedEvidence && !fileContent.includes(v.verifiedEvidence)) {
        dropped++;
        log(`[${agent}] dropped unverifiable quote at ${v.file}:${v.line}`);
        continue;
      }
      if (!v.verifiedEvidence) {
        dropped++;
        continue;
      }
      const { score, tier } = scoreAndTier(v, v.status, deps.scoring);
      kept.push({
        findingId: findingId(v.file, v.line, agent),
        agent,
        mergedAgents: [agent],
        file: v.file,
        line: v.line,
        title: v.title,
        verifiedEvidence: v.verifiedEvidence,
        why: v.why,
        suggestion: v.suggestion,
        status: v.status,
        impact: v.impact,
        certainty: v.certainty,
        blastRadius: v.blastRadius,
        score,
        tier,
      });
    }
    return empty('done', `${kept.length} verified, ${dropped} dropped`, kept, dropped);
  } catch (err) {
    if (err instanceof BudgetExceededError) return empty('partial', `stopped at verify: ${err.message}`);
    return empty('failed', `pass 2 failed: ${(err as Error).message.slice(0, 200)}`);
  }
}
