import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { CONFIG_DIR, PKG_ROOT } from './lib/paths.js';
import { loadModelsConfig } from './llm/config.js';
import { Budget, RoleLlm } from './llm/factory.js';
import { ScriptedLlm, type ScriptedReply } from './llm/scripted.js';
import type { ReviewerLlm } from './llm/types.js';
import type { ModelsConfig } from './llm/config.js';
import { runReview } from './lib/orchestrator.js';
import { FixtureSource } from './sources/fixture.js';
import type { AgentName, AgentRole, VerifiedFinding } from './lib/types.js';
import type { Capability } from './lib/types.js';

interface Expected {
  agent?: AgentName;
  file: string;
  line: number;
  tolerance?: number;
  note?: string;
}
interface EvalSpec {
  trueFindings: Expected[];
  decoys?: Expected[];
}
interface ScriptedFixture {
  script: Record<string, ScriptedReply>;
  models?: Record<string, { model?: string; capability?: Capability }>;
}

interface AgentScore {
  agent: string;
  expected: number;
  found: number;
  missed: Expected[];
  reported: number;
  hallucinations: number;
}

function matches(f: { file: string; line: number; agent: string; mergedAgents?: string[] }, e: Expected, agentsMustMatch: boolean): boolean {
  const tol = e.tolerance ?? 6;
  const fileOk = f.file === e.file;
  const lineOk = Math.abs(f.line - e.line) <= tol;
  const agentOk = !agentsMustMatch || !e.agent || f.agent === e.agent || (f.mergedAgents ?? []).includes(e.agent);
  return fileOk && lineOk && agentOk;
}

async function evalFixture(
  dir: string,
  mode: 'offline' | 'live',
  preset?: string,
  /** present only when the run asked for teach mode */
  teachMode?: { below?: number },
) {
  const spec = JSON.parse(readFileSync(path.join(dir, 'expected-findings.json'), 'utf8')) as EvalSpec;
  const source = new FixtureSource(dir);

  let llmFactory: (cfg: ModelsConfig, budget: Budget, f: typeof fetch) => ReviewerLlm;
  const scriptedPath = path.join(dir, 'scripted.json');
  if (mode === 'offline' && existsSync(scriptedPath)) {
    const scripted = JSON.parse(readFileSync(scriptedPath, 'utf8')) as ScriptedFixture;
    llmFactory = () => new ScriptedLlm(scripted.script as Partial<Record<AgentRole, ScriptedReply>>, scripted.models);
  } else {
    const cfg = loadModelsConfig(path.join(CONFIG_DIR, 'models.json'));
    if (preset) cfg.preset = preset;
    llmFactory = (_c, budget, f) => new RoleLlm(cfg, budget, f);
  }

  const result = await runReview({
    source,
    preset,
    post: false,
    runsDir: path.join(PKG_ROOT, 'runs', 'eval'),
    llmFactory,
    log: () => {},
    // teach mode is prose-only: recall and precision must not move
    teach: teachMode !== undefined,
    teachBelow: teachMode?.below,
  });

  const reported: VerifiedFinding[] = result.consolidated.map((c) => c.finding);
  const scores: Record<string, AgentScore> = {};
  const bucket = (a: string): AgentScore =>
    (scores[a] ??= { agent: a, expected: 0, found: 0, missed: [], reported: 0, hallucinations: 0 });

  for (const exp of spec.trueFindings) {
    const a = exp.agent ?? 'any';
    bucket(a).expected++;
    const hit = reported.find((f) => matches(f, exp, true));
    if (hit) bucket(a).found++;
    else bucket(a).missed.push(exp);
  }
  for (const f of reported) bucket(f.agent).reported++;
  for (const decoy of spec.decoys ?? []) {
    const hit = reported.find((f) => matches(f, decoy, false));
    if (hit) bucket(hit.agent).hallucinations++;
  }

  return { name: path.basename(dir), verdict: result.summary.verdict, prScore: result.summary.prScore, scores, reported };
}

export async function runEval(opts: {
  fixture?: string;
  mode: 'offline' | 'live';
  preset?: string;
  /** run every fixture in teach mode: same findings, explained prose */
  teach?: boolean;
  teachBelow?: number;
}): Promise<number> {
  const root = path.join(PKG_ROOT, 'eval', 'fixtures');
  const dirs = readdirSync(root, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => path.join(root, d.name))
    .filter((d) => !opts.fixture || path.basename(d) === opts.fixture);

  if (!dirs.length) {
    process.stdout.write(`no fixtures matched${opts.fixture ? ` "${opts.fixture}"` : ''} in ${root}\n`);
    return 1;
  }

  const perAgent: Record<string, AgentScore> = {};
  let failed = 0;

  for (const dir of dirs) {
    const name = path.basename(dir);
    try {
      const r = await evalFixture(dir, opts.mode, opts.preset, opts.teach ? { below: opts.teachBelow } : undefined);
      process.stdout.write(`\n▶ ${name}  [${opts.mode}]  ${r.prScore === null ? '—' : `${r.prScore}/100`}  ${r.verdict}\n`);
      for (const s of Object.values(r.scores)) {
        const agg = (perAgent[s.agent] ??= { agent: s.agent, expected: 0, found: 0, missed: [], reported: 0, hallucinations: 0 });
        agg.expected += s.expected;
        agg.found += s.found;
        agg.reported += s.reported;
        agg.hallucinations += s.hallucinations;
        agg.missed.push(...s.missed);
        const line = `    ${s.agent.padEnd(13)} recall ${s.found}/${s.expected}  reported ${s.reported}  hallucinations ${s.hallucinations}`;
        process.stdout.write(line + '\n');
        for (const m of s.missed) process.stdout.write(`      MISSED ${m.file}:${m.line} ${m.note ?? ''}\n`);
      }
    } catch (err) {
      failed++;
      process.stdout.write(`\n▶ ${name}  ERROR: ${(err as Error).message}\n`);
    }
  }

  const agg = Object.values(perAgent);
  const totExpected = agg.reduce((s, a) => s + a.expected, 0);
  const totFound = agg.reduce((s, a) => s + a.found, 0);
  const totReported = agg.reduce((s, a) => s + a.reported, 0);
  const totHalluc = agg.reduce((s, a) => s + a.hallucinations, 0);
  const recall = totExpected ? Math.round((totFound / totExpected) * 100) : 100;
  const precision = totReported ? Math.round(((totReported - totHalluc) / totReported) * 100) : 100;

  process.stdout.write('\n──────────────────────────────────────────────\n');
  const teachNote = opts.teach ? `  teach=${opts.teachBelow !== undefined ? opts.teachBelow : 'on'}` : '';
  process.stdout.write(`mode=${opts.mode}  fixtures=${dirs.length - failed}/${dirs.length}${teachNote}\n`);
  process.stdout.write(`RECALL ${totFound}/${totExpected} (${recall}%)   PRECISION ${precision}%   hallucinations ${totHalluc}\n`);
  if (opts.mode === 'live') {
    process.stdout.write('Copy these numbers into README — real eval numbers beat another architecture diagram.\n');
  }
  return failed ? 1 : 0;
}
