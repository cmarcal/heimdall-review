import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { runAgent } from '../src/agents/base.js';
import { ScriptedLlm } from '../src/llm/scripted.js';
import { defaultManifest } from '../src/lib/manifest.js';
import { CONFIG_DIR } from '../src/lib/paths.js';
import type { ScoringConfig } from '../src/lib/scoring.js';
import type { ReviewContext } from '../src/lib/types.js';

const scoring: ScoringConfig = JSON.parse(readFileSync(join(CONFIG_DIR, 'scoring.json'), 'utf8'));

function makeCtx(content: string): ReviewContext {
  return {
    repo: 'acme/x',
    prNumber: 1,
    pr: { number: 1, title: 't', body: 'b', author: 'a', url: 'u', headRef: 'h', baseRef: 'm', headSha: 'sha' },
    files: [
      {
        path: 'a.js', status: 'added', patch: '', content,
        changedLines: [1, 2, 3], added: 3, removed: 0,
      },
    ],
    skipped: [], ticket: null, requirementsVerified: false, ticketSource: 'none',
    specs: [], comments: [], threadsTrusted: true, manifest: defaultManifest(), docs: [], contextTruncated: false,
  };
}

// Pass-1 proposes a real bug, a fabricated one, an out-of-scope one, and an open question.
const pass1 = JSON.stringify([
  { file: 'a.js', line: 2, title: 'Real bug', evidenceQuote: 'line2 PROBLEM', why: 'why here', suggestion: 'fix it now', impact: 8, certainty: 8, blastRadius: 8 },
  { file: 'a.js', line: 2, title: 'Fabricated bug', evidenceQuote: 'whatever', why: 'why here', suggestion: 'fix it now', impact: 9, certainty: 9, blastRadius: 9 },
  { file: 'ghost.js', line: 1, title: 'Out of scope', evidenceQuote: 'x', why: 'why here', suggestion: 'fix it now', impact: 5, certainty: 5, blastRadius: 5 },
  { file: 'a.js', line: 1, title: 'Open question', evidenceQuote: 'line1', why: 'why here', suggestion: 'fix it now', impact: 3, certainty: 4, blastRadius: 2 },
]);

// The verifier tries to KEEP the fabricated one with a quote that is NOT in the code.
const pass2 = JSON.stringify([
  { file: 'a.js', line: 2, title: 'Real bug', evidenceQuote: 'line2 PROBLEM', why: 'why here', suggestion: 'fix it now', impact: 8, certainty: 8, blastRadius: 8, status: 'keep', verifiedEvidence: 'line2 PROBLEM' },
  { file: 'a.js', line: 2, title: 'Fabricated bug', evidenceQuote: 'whatever', why: 'why here', suggestion: 'fix it now', impact: 9, certainty: 9, blastRadius: 9, status: 'keep', verifiedEvidence: 'TOTALLY FAKE LINE' },
  { file: 'a.js', line: 1, title: 'Open question', evidenceQuote: 'line1', why: 'why here', suggestion: 'fix it now', impact: 3, certainty: 4, blastRadius: 2, status: 'question', verifiedEvidence: 'line1' },
]);

const deps = {
  resolve: () => ({ model: 'scripted', capability: 'high' as const }),
  scoring,
  log: () => {},
};

describe('two-pass gate — where hallucinations die', () => {
  it('drops a KEEP finding whose evidence quote is not really in the code', async () => {
    const llm = new ScriptedLlm({ security: pass1, verifier: pass2 });
    const res = await runAgent('security', makeCtx('line1\nline2 PROBLEM\nline3\n'), { ...deps, llm });

    const titles = res.findings.map((f) => f.title);
    expect(titles).toContain('Real bug');
    expect(titles).toContain('Open question');
    expect(titles).not.toContain('Fabricated bug'); // dropped by the harness quote gate, not the model
    expect(res.findings.find((f) => f.title === 'Real bug')?.tier).toBe('blocker');
    expect(res.findings.find((f) => f.title === 'Open question')?.status).toBe('question');
    expect(res.dropped).toBe(1);
  });

  it('never reports anything outside the changed files', async () => {
    const llm = new ScriptedLlm({ security: pass1, verifier: pass2 });
    const res = await runAgent('security', makeCtx('line1\nline2 PROBLEM\nline3\n'), { ...deps, llm });
    expect(res.findings.some((f) => f.file === 'ghost.js')).toBe(false);
  });

  it('a candidate that only quotes real code survives; a wholly absent file returns clean', async () => {
    const empty = new ScriptedLlm({ security: '[]' });
    const res = await runAgent('security', makeCtx('clean code\n'), { ...deps, llm: empty });
    expect(res.status).toBe('done');
    expect(res.findings).toHaveLength(0);
  });

  it('clamps an unconfirmed question: never posts above Minor, record keeps the over-claim', async () => {
    // Regression of a real PR on a private app repo: a question the
    // verifier cannot confirm must not reach the PR as Major on the finder's scores.
    const p1 = JSON.stringify([
      { file: 'a.js', line: 1, title: 'Does X run before init?', evidenceQuote: 'line1', why: 'if so, data loss', suggestion: 'ask the author', impact: 8, certainty: 8, blastRadius: 6 },
    ]);
    const p2 = JSON.stringify([
      { file: 'a.js', line: 1, title: 'Does X run before init?', evidenceQuote: 'line1', why: 'if so, data loss', suggestion: 'ask the author', impact: 8, certainty: 8, blastRadius: 6, status: 'question', verifiedEvidence: 'line1' },
    ]);
    const res = await runAgent('security', makeCtx('line1\nline2 PROBLEM\nline3\n'), { ...deps, llm: new ScriptedLlm({ security: p1, verifier: p2 }) });
    const q = res.findings.find((f) => f.status === 'question');
    expect(q?.tier).toBe('minor');
    expect(q?.certainty).toBe(8); // the dataset keeps the finder's claim
    expect(q?.score).toBe(17); // scoring used the capped certainty
  });
});
