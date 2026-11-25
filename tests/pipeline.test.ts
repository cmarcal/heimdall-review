import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { runReview } from '../src/lib/orchestrator.js';
import { FixtureSource } from '../src/sources/fixture.js';
import { ScriptedLlm } from '../src/llm/scripted.js';

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
