import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { runReview } from '../src/lib/orchestrator.js';
import { FixtureSource } from '../src/sources/fixture.js';
import { ScriptedLlm } from '../src/llm/scripted.js';
import { parseManifest } from '../src/lib/manifest.js';
import type { ReviewSource } from '../src/sources/source.js';

const FIXTURE = join(dirname(fileURLToPath(import.meta.url)), '..', 'eval', 'fixtures', 'xss-reflected');
const STANDARDS_FIXTURE = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'standards-instruction');

async function loadScripted(dir: string) {
  const scripted = JSON.parse(readFileSync(join(dir, 'scripted.json'), 'utf8')) as {
    script: Record<string, string>;
    models?: Record<string, { model?: string; capability?: never }>;
  };
  return new ScriptedLlm(scripted.script as never, scripted.models as never);
}

describe('runReview (dry-run, offline)', () => {
  it('scores, consolidates, writes a run artifact, and posts nothing', async () => {
    const scripted = JSON.parse(readFileSync(join(FIXTURE, 'scripted.json'), 'utf8')) as {
      script: Record<string, string>;
      models?: Record<string, { model?: string; capability?: never }>;
    };
    const runsDir = join(tmpdir(), `heimdall-test-${Date.now()}`);

    const res = await runReview({
      source: new FixtureSource(FIXTURE),
      post: false,
      runsDir,
      log: () => {},
      llmFactory: () => new ScriptedLlm(scripted.script as never, scripted.models as never),
    });

    expect(res.summary.counts.blocker).toBe(1);
    expect(res.report).toMatch(/Blocker/i);
    expect(res.summary.requirementsVerified).toBe(true);
    const standardsRow = res.summary.coverage.find((r) => r.agent === 'standards');
    expect(standardsRow?.status).toBe('done'); // the seventh axis runs in the real pipeline
    expect(res.posted).toBeUndefined(); // dry-run posted nothing
    expect(res.artifactPath && existsSync(res.artifactPath)).toBe(true);

    const artifact = JSON.parse(readFileSync(res.artifactPath!, 'utf8')) as { findings: { tier: string; verifiedEvidence: string }[] };
    expect(artifact.findings[0]?.tier).toBe('blocker');
    expect(artifact.findings[0]?.verifiedEvidence).toContain('res.send');
  });
});

describe('agent instructions in the real pipeline', () => {
  it('delivers the repo instruction to the standards specialist and ships a finding that cites it', async () => {
    const llm = await loadScripted(STANDARDS_FIXTURE);
    const logs: string[] = [];
    const runsDir = join(tmpdir(), `heimdall-instr-${Date.now()}`);

    const res = await runReview({
      source: new FixtureSource(STANDARDS_FIXTURE),
      post: false,
      runsDir,
      log: (m) => logs.push(m),
      llmFactory: () => llm,
    });

    // the AGENTS.md text was actually in the standards specialist's context pack
    const standardsCall = llm.calls.find((c) => c.role === 'standards');
    expect(standardsCall?.user).toContain('## Repo agent instructions');
    expect(standardsCall?.user).toContain('validate input with zod');

    // the standards candidate citing it survived find -> verify -> quote gate
    const standardsRow = res.summary.coverage.find((r) => r.agent === 'standards');
    expect(standardsRow?.status).toBe('done');
    expect(standardsRow?.findings).toBe(1);
    expect(res.report).toContain('AGENTS.md');
    expect(res.posted).toBeUndefined();
  });

  it('declares the detected instruction files on the run log', async () => {
    const llm = await loadScripted(STANDARDS_FIXTURE);
    const logs: string[] = [];
    await runReview({
      source: new FixtureSource(STANDARDS_FIXTURE),
      post: false,
      runsDir: join(tmpdir(), `heimdall-instr-log-${Date.now()}`),
      log: (m) => logs.push(m),
      llmFactory: () => llm,
    });
    expect(logs).toContain('agent instructions: AGENTS.md');
  });

  it('declares none detected when the repo ships no instruction files', async () => {
    const llm = await loadScripted(FIXTURE);
    const logs: string[] = [];
    await runReview({
      source: new FixtureSource(FIXTURE),
      post: false,
      runsDir: join(tmpdir(), `heimdall-instr-none-${Date.now()}`),
      log: (m) => logs.push(m),
      llmFactory: () => llm,
    });
    expect(logs).toContain('agent instructions: none detected');
  });
});

// Teach mode in the real pipeline: the flag changes published prose only.
// Scores, tiers, the verdict and the PR score must be identical with and
// without it, and a run that never asked for teach must not spend a call on it.
describe('teach mode in the real pipeline', () => {
  const TEACH_FIXTURE = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'teach-low');

  // Scores in this fixture: 6 (20%) and 12 (40%) are below the 60% bar; 20 (67%)
  // is a Major and 24 (80%) a Blocker, both above it.
  async function run(
    over: { teach?: boolean; teachBelow?: number; manifestTeachBelow?: number; noTeacher?: boolean } = {},
  ) {
    const scripted = JSON.parse(readFileSync(join(TEACH_FIXTURE, 'scripted.json'), 'utf8')) as {
      script: Record<string, string>;
      models?: Record<string, { model?: string; capability?: never }>;
    };
    if (over.noTeacher) delete scripted.script.teach;
    const llm = new ScriptedLlm(scripted.script as never, scripted.models as never);
    const runsDir = join(tmpdir(), `heimdall-teach-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    const res = await runReview({
      source: teachSource(TEACH_FIXTURE, over.manifestTeachBelow),
      post: false,
      runsDir,
      log: () => {},
      teach: over.teach,
      teachBelow: over.teachBelow,
      llmFactory: () => llm,
    });
    return { res, llm, artifact: JSON.parse(readFileSync(res.artifactPath!, 'utf8')) };
  }

  it('without the flag nothing calls the teacher and the report is unchanged', async () => {
    const { res, llm, artifact } = await run();
    expect(llm.calls.filter((c) => c.role === 'teach')).toHaveLength(0);
    expect(res.report).not.toMatch(/teach/i);
    expect(res.summary.teach).toBeUndefined();
    expect(artifact.teach).toBeUndefined();
    expect(res.consolidated.every((c) => !c.comment.includes('**What the code does:**'))).toBe(true);
  });

  it('teaches the findings below the bar and leaves the rest terse', async () => {
    const { res, llm } = await run({ teach: true });
    const taught = res.consolidated.filter((c) => c.comment.includes('**What the code does:**'));
    expect(taught).toHaveLength(2);
    expect(llm.calls.filter((c) => c.role === 'teach')).toHaveLength(2);

    for (const c of taught) {
      expect(c.comment).toContain('**Why it breaks:**');
      expect(c.comment).toContain('**How to fix it:**');
      expect(c.comment).toContain('```');
      expect(c.comment).toContain(c.finding.verifiedEvidence);
      expect(c.finding.score).toBeLessThan(18);
    }
    // the Major and the Blocker keep the consolidator's comment verbatim
    const terse = res.consolidated.filter((c) => !c.comment.includes('**What the code does:**'));
    expect(terse.map((c) => c.finding.tier).sort()).toEqual(['blocker', 'major']);
    expect(terse.every((c) => c.comment.startsWith('**'))).toBe(true);
  });

  it('never moves a score, tier, verdict or the PR score', async () => {
    const plain = await run();
    const taughtRun = await run({ teach: true });
    const view = (r: typeof plain.res) =>
      JSON.parse(
        JSON.stringify({
          verdict: r.summary.verdict,
          prScore: r.summary.prScore,
          counts: r.summary.counts,
          findings: r.consolidated.map((c) => ({
            id: c.finding.findingId,
            tier: c.finding.tier,
            score: c.finding.score,
            impact: c.finding.impact,
            certainty: c.finding.certainty,
            blastRadius: c.finding.blastRadius,
            status: c.finding.status,
            title: c.finding.title,
            verifiedEvidence: c.finding.verifiedEvidence,
          })),
        }),
      );
    expect(view(taughtRun.res)).toEqual(view(plain.res));
  });

  it('reports teach mode, the threshold and the counts in the run report and the artifact', async () => {
    const { res, artifact } = await run({ teach: true });
    expect(res.summary.teach).toMatchObject({ below: 60, taught: 2, fallback: 0 });
    expect(res.report).toMatch(/teach/i);
    expect(res.report).toContain('60/100');
    expect(artifact.teach).toMatchObject({ below: 60, taught: 2, fallback: 0 });
  });

  it('teaches nothing at threshold 0 and everything at 100', async () => {
    const plain = await run();
    const none = await run({ teach: true, teachBelow: 0 });
    expect(none.res.summary.teach).toMatchObject({ below: 0, taught: 0, fallback: 0 });
    expect(none.llm.calls.filter((c) => c.role === 'teach')).toHaveLength(0);
    expect(none.res.consolidated.every((c) => !c.comment.includes('**What the code does:**'))).toBe(true);
    // PLAN item 5: a teach run with nothing under the bar reports the same thing
    expect(none.res.report).toBe(plain.res.report);

    const all = await run({ teach: true, teachBelow: 100 });
    expect(all.res.summary.teach).toMatchObject({ below: 100, taught: 4, fallback: 0 });
    expect(all.res.consolidated.every((c) => c.comment.includes('**What the code does:**'))).toBe(true);
    // the Blocker is explained, and still a Blocker with the same score
    const blocker = all.res.consolidated.find((c) => c.finding.tier === 'blocker');
    expect(blocker?.finding.score).toBe(24);
  });

  it('honors the repo manifest threshold', async () => {
    const { res } = await run({ teach: true, manifestTeachBelow: 30 });
    // only the score-6 finding (20%) is under 30; the score-12 one (40%) is not
    expect(res.summary.teach).toMatchObject({ below: 30, taught: 1, fallback: 0 });
  });

  it('a flag overrides the manifest threshold', async () => {
    const { res } = await run({ teach: true, teachBelow: 100, manifestTeachBelow: 30 });
    expect(res.summary.teach?.below).toBe(100);
  });

  it('degrades to the plain comments when the teacher is not available', async () => {
    const { res, llm } = await run({ teach: true, noTeacher: true });
    expect(llm.calls.filter((c) => c.role === 'teach')).toHaveLength(2);
    expect(res.consolidated.every((c) => !c.comment.includes('**What the code does:**'))).toBe(true);
    expect(res.summary.teach).toMatchObject({ below: 60, eligible: 2, taught: 0, fallback: 2 });
    // the run is still green: the verdict and the terse comments stand
    expect(res.summary.verdict).toMatch(/blocker/i);
    expect(res.report).toMatch(/No findings|💀|🔴/);
  });
});

// The shared fixture, with an optional teach threshold written into the manifest
// the way a repo would ship it in .pr-review.json — so the override goes through
// the real manifest parser, not a shortcut.
function teachSource(dir: string, manifestTeachBelow?: number): ReviewSource {
  const inner = new FixtureSource(dir);
  return {
    buildContext: async (issueFlag?: number) => {
      const ctx = await inner.buildContext(issueFlag);
      if (manifestTeachBelow !== undefined) {
        ctx.manifest = parseManifest(JSON.stringify({ ...ctx.manifest, teach: { below: manifestTeachBelow } }));
      }
      return ctx;
    },
  };
}
