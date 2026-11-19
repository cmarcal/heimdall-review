import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { runReview } from '../src/lib/orchestrator.js';
import { FixtureSource } from '../src/sources/fixture.js';
import { ScriptedLlm } from '../src/llm/scripted.js';

const FIXTURE = join(dirname(fileURLToPath(import.meta.url)), '..', 'eval', 'fixtures', 'xss-reflected');

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
