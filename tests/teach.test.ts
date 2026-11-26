import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  TEACH_LABELS,
  checkTaught,
  isTaught,
  renderTaughtBody,
  teach,
  teachStats,
} from '../src/agents/teach.js';
import { deterministicComment } from '../src/agents/consolidator.js';
import { MAX_INLINE_WORDS, MAX_TAUGHT_WORDS } from '../src/lib/format.js';
import { teachScoringConfig } from '../src/lib/scoring.js';
import { taughtFieldsSchema } from '../src/lib/finding.js';
import { CONFIG_DIR } from '../src/lib/paths.js';
import type { ConsolidatedFinding } from '../src/agents/consolidator.js';
import type { LlmForRole } from '../src/llm/types.js';
import type { ReviewContext, VerifiedFinding } from '../src/lib/types.js';

const scoring = teachScoringConfig(
  JSON.parse(readFileSync(`${CONFIG_DIR}/scoring.json`, 'utf8')) as never,
);

const CODE = [
  "import { db } from './db.js';",
  '',
  'export function getUser(req, res) {',
  '  const user = db.users.byId(req.params.id);',
  '  res.send(user);',
  '}',
  '',
].join('\n');

function finding(over: Partial<VerifiedFinding> = {}): VerifiedFinding {
  return {
    findingId: 'aaa111',
    agent: 'security',
    mergedAgents: ['security'],
    file: 'src/routes.js',
    line: 4,
    title: 'A missing user is rendered as a null body',
    verifiedEvidence: '  res.send(user);',
    why: 'byId returns undefined for an unknown id and res.send(undefined) sends an empty body.',
    suggestion: 'Return 404 when the lookup misses.',
    status: 'keep',
    impact: 3,
    certainty: 2,
    blastRadius: 1,
    score: 6,
    tier: 'nit',
    ...over,
  };
}

function ctx(over: Partial<ReviewContext> = {}): ReviewContext {
  return {
    repo: 'acme/api',
    prNumber: 7,
    pr: {
      number: 7,
      title: 'Add user route',
      body: 'b',
      author: 'dev',
      url: 'u',
      headRef: 'h',
      baseRef: 'm',
      headSha: 'sha',
    },
    files: [
      {
        path: 'src/routes.js',
        status: 'added',
        patch: '+x',
        content: CODE,
        changedLines: [3, 4, 5],
        added: 6,
        removed: 0,
      },
    ],
    skipped: [],
    ticket: null,
    requirementsVerified: false,
    ticketSource: 'none',
    specs: [],
    agentInstructions: [],
    comments: [],
    threadsTrusted: true,
    manifest: { ...defaultManifestShallow() },
    docs: [],
    contextTruncated: false,
    ...over,
  };
}

// A manifest stand-in: teach only reads what it already reads today.
function defaultManifestShallow(): ReviewContext['manifest'] {
  return {
    preset: null,
    budgetUsd: 3,
    maxFileChangedLines: 400,
    maxTotalChangedLines: 3000,
    skip: [],
    specs: [],
    agentInstructions: false,
    migrations: [],
    agents: Object.fromEntries(
      ['security', 'requirements', 'e2e-tests', 'architecture', 'regression', 'performance', 'standards'].map(
        (a) => [a, { enabled: true, docs: [] }],
      ),
    ) as ReviewContext['manifest']['agents'],
  };
}

const entry = (f: VerifiedFinding = finding()): ConsolidatedFinding => ({
  finding: f,
  comment: deterministicComment(f),
});

/** Scripted teacher: one reply per call, in order. */
function teacher(...replies: (string | Error)[]): {
  llm: LlmForRole;
  calls: { system: string; user: string }[];
} {
  const calls: { system: string; user: string }[] = [];
  let i = 0;
  return {
    calls,
    llm: {
      complete: async (_role, system, user) => {
        calls.push({ system, user });
        const reply = replies[Math.min(i++, replies.length - 1)] as string | Error;
        if (reply instanceof Error) throw reply;
        return { text: reply, usage: { inputTokens: 10, outputTokens: 10 } };
      },
    },
  };
}

const fields = (over: Record<string, string> = {}) =>
  JSON.stringify({
    what: 'getUser sends whatever db.users.byId returns, including nothing.',
    why: 'An unknown id makes byId return undefined, so the client gets an empty 200 instead of a 404.',
    how: 'Check the lookup result and answer 404 before sending the body.',
    ...over,
  });

describe('taughtFields schema', () => {
  it('requires the three parts and takes tryThis optionally', () => {
    expect(taughtFieldsSchema.parse({ what: 'a', why: 'b', how: 'c' })).toEqual({
      what: 'a',
      why: 'b',
      how: 'c',
    });
    expect(taughtFieldsSchema.parse({ what: 'a', why: 'b', how: 'c', tryThis: 'x' }).tryThis).toBe('x');
    expect(() => taughtFieldsSchema.parse({ what: 'a', why: 'b' })).toThrow();
    expect(() => taughtFieldsSchema.parse({ what: '', why: 'b', how: 'c' })).toThrow();
  });
});

describe('renderTaughtBody', () => {
  it('renders the title, the verbatim quote fenced, and the three labeled parts', () => {
    const f = finding();
    const body = renderTaughtBody(f, {
      what: 'getUser sends whatever the lookup returns.',
      why: 'An unknown id yields undefined, so the client gets an empty 200.',
      how: 'Answer 404 when the lookup misses.',
    });
    expect(body.startsWith(f.title)).toBe(true);
    expect(body).toContain('```\n  res.send(user);\n```');
    for (const label of TEACH_LABELS) expect(body).toContain(`**${label}:**`);
    expect(body).toContain('Answer 404 when the lookup misses.');
    expect(isTaught(body)).toBe(true);
  });

  it('keeps the Question: lead for an unconfirmed finding', () => {
    const body = renderTaughtBody(finding({ status: 'question' }), { what: 'a', why: 'b', how: 'c' });
    expect(body.startsWith('Question:')).toBe(true);
  });

  it('appends a fenced Try this block only when the teacher offered one', () => {
    const plain = renderTaughtBody(finding(), { what: 'a', why: 'b', how: 'c' });
    expect(plain).not.toContain('**Try this:**');
    const withCode = renderTaughtBody(finding(), { what: 'a', why: 'b', how: 'c', tryThis: 'if (!user) return res.status(404).end();' });
    expect(withCode).toContain('**Try this:**');
    expect(withCode).toContain('if (!user) return res.status(404).end();');
  });
});

describe('checkTaught gate', () => {
  const f = finding();
  const good = renderTaughtBody(f, { what: 'a', why: 'b', how: 'c' });

  it('accepts a body the renderer produced', () => {
    expect(checkTaught(good, f)).toEqual({ ok: true });
  });

  it('rejects a body with a missing label', () => {
    const broken = good.replace('**Why it breaks:**', '**Because:**');
    expect(checkTaught(broken, f)).toMatchObject({ ok: false, reason: expect.stringContaining('Why it breaks') });
  });

  it('rejects a body whose quote was dropped or altered', () => {
    expect(checkTaught(good.replace('  res.send(user);', '  res.send(user)'), f)).toMatchObject({
      ok: false,
      reason: expect.stringContaining('evidence'),
    });
    expect(checkTaught(good.replace('```\n  res.send(user);\n```', 'no quote here'), f)).toMatchObject({
      ok: false,
      reason: expect.stringContaining('evidence'),
    });
  });

  it('rejects a body over the taught word cap', () => {
    const bloated = `${good} ${'extra words '.repeat(MAX_TAUGHT_WORDS)}`;
    expect(checkTaught(bloated, f)).toMatchObject({ ok: false, reason: expect.stringContaining(String(MAX_TAUGHT_WORDS)) });
  });

  it('rejects an empty quote instead of waving it through', () => {
    const f2 = finding({ verifiedEvidence: '' });
    expect(checkTaught(renderTaughtBody(f2, { what: 'a', why: 'b', how: 'c' }), f2)).toMatchObject({
      ok: false,
    });
  });

  it('does not mistake a plain comment for a taught one', () => {
    expect(isTaught(deterministicComment(f))).toBe(false);
  });
});

describe('teach pass', () => {
  it('replaces the comment of a low-scoring finding with the taught body', async () => {
    const logs: string[] = [];
    const t = teacher(fields());
    const before = [entry()];
    const after = await teach(before, ctx(), t.llm, { scoring }, (m) => logs.push(m));

    expect(isTaught(after[0]!.comment)).toBe(true);
    expect(after[0]!.comment).toContain('An unknown id makes byId return undefined');
    expect(after[0]!.comment).toContain('```\n  res.send(user);\n```');
    expect(t.calls).toHaveLength(1);
    expect(teachStats(before, after, scoring)).toEqual({ taught: 1, fallback: 0 });
  });

  it('never calls the teacher for a finding above the threshold', async () => {
    const logs: string[] = [];
    const t = teacher(fields());
    const above = finding({ score: 20, tier: 'major', impact: 7, certainty: 7, blastRadius: 6 });
    const before = [entry(above)];
    const after = await teach(before, ctx(), t.llm, { scoring }, (m) => logs.push(m));

    expect(t.calls).toHaveLength(0);
    expect(after[0]!.comment).toBe(before[0]!.comment);
    expect(teachStats(before, after, scoring)).toEqual({ taught: 0, fallback: 0 });
  });

  it('grounds the teacher in the finding, its comment and the real head content', async () => {
    const t = teacher(fields());
    await teach([entry()], ctx(), t.llm, { scoring }, () => {});
    const user = t.calls[0]!.user;
    expect(user).toContain('A missing user is rendered as a null body');
    expect(user).toContain('res.send(user);');
    expect(user).toContain('export function getUser(req, res) {'); // head content
    expect(t.calls[0]!.system).toContain('What the code does'); // the teacher prompt
    expect(user).not.toMatch(/"score"|"impact"|"certainty"|"blastRadius"/); // scores stay private
  });

  it('keeps the three parts as separate paragraphs so GitHub renders them apart', async () => {
    const after = await teach([entry()], ctx(), teacher(fields()).llm, { scoring }, () => {});
    expect(after[0]!.comment).toMatch(/\*\*What the code does:\*\*[^\n]*\n\n\*\*Why it breaks:\*\*/);
  });

  it('leaves the finding record untouched: tier, score, sub-scores, quote, title', async () => {
    const f = finding();
    const before = [entry(f)];
    const after = await teach(before, ctx(), teacher(fields()).llm, { scoring }, () => {});
    expect(after[0]!.finding).toEqual(f);
    expect(after[0]!.finding.tier).toBe('nit');
    expect(after[0]!.finding.score).toBe(6);
    expect(after[0]!.finding.verifiedEvidence).toBe(f.verifiedEvidence);
  });

  it('teaches some findings and leaves the rest alone in the same run', async () => {
    const low = finding();
    const blocker = finding({
      findingId: 'bbb222',
      line: 5,
      title: 'Reflected input is sent back unescaped',
      verifiedEvidence: '  res.send(user);',
      score: 24,
      tier: 'blocker',
      impact: 8,
      certainty: 8,
      blastRadius: 8,
    });
    const t = teacher(fields());
    const before = [entry(low), entry(blocker)];
    const after = await teach(before, ctx(), t.llm, { scoring }, () => {});

    expect(isTaught(after[0]!.comment)).toBe(true);
    expect(after[1]!.comment).toBe(before[1]!.comment);
    expect(after[1]!.finding.tier).toBe('blocker');
    expect(t.calls).toHaveLength(1);
    expect(teachStats(before, after, scoring)).toEqual({ taught: 1, fallback: 0 });
  });

  it('gives an over-budget taught body one rewrite, then keeps the terse comment', async () => {
    const long = fields({ what: `it reads the id ${'over and over '.repeat(MAX_TAUGHT_WORDS)}` });
    const logs: string[] = [];
    const t = teacher(long, long);
    const before = [entry()];
    const after = await teach(before, ctx(), t.llm, { scoring }, (m) => logs.push(m));

    expect(t.calls).toHaveLength(2);
    expect(after[0]!.comment).toBe(before[0]!.comment);
    expect(logs.join(' | ')).toMatch('rewrite');
    expect(logs.join(' | ')).toMatch('terse');
    expect(teachStats(before, after, scoring)).toEqual({ taught: 0, fallback: 1 });
  });

  it('keeps the rewrite when it satisfies the gate', async () => {
    const logs: string[] = [];
    const t = teacher(fields({ what: `verbose ${'padding '.repeat(MAX_TAUGHT_WORDS)}` }), fields());
    const after = await teach([entry()], ctx(), t.llm, { scoring }, (m) => logs.push(m));
    expect(isTaught(after[0]!.comment)).toBe(true);
    expect(t.calls).toHaveLength(2);
    expect(logs.join(' | ')).toMatch('rewrite');
  });

  it('rejects a taught body that lost the quote and declares the fallback', async () => {
    const logs: string[] = [];
    const broken = JSON.stringify({
      what: 'getUser sends the lookup result.',
      why: 'An unknown id sends an empty body.',
      how: 'Answer 404 when the lookup misses.',
      tryThis: 'res.status(404)',
    });
    // the renderer is deterministic, so the harness catches a finding whose
    // quote is empty: nothing verifiable can be fenced, so the body is refused.
    const f = finding({ verifiedEvidence: '   ' });
    const before = [entry(f)];
    const after = await teach(before, ctx(), teacher(broken, broken).llm, { scoring }, (m) => logs.push(m));

    expect(after[0]!.comment).toBe(before[0]!.comment);
    expect(logs.join(' | ')).toMatch('evidence');
    expect(logs.join(' | ')).toMatch('terse');
    expect(teachStats(before, after, scoring)).toEqual({ taught: 0, fallback: 1 });
  });

  it('survives a teacher that throws: terse comments, run still green', async () => {
    const logs: string[] = [];
    const before = [entry()];
    const after = await teach(before, ctx(), teacher(new Error('429 rate limited')).llm, { scoring }, (m) =>
      logs.push(m),
    );
    expect(after[0]!.comment).toBe(before[0]!.comment);
    expect(logs.join(' | ')).toMatch('teacher failed');
    expect(teachStats(before, after, scoring)).toEqual({ taught: 0, fallback: 1 });
  });

  it('survives unparseable teacher output', async () => {
    const logs: string[] = [];
    const before = [entry()];
    const after = await teach(before, ctx(), teacher('I am not JSON at all').llm, { scoring }, (m) => logs.push(m));
    expect(after[0]!.comment).toBe(before[0]!.comment);
    expect(logs.join(' | ')).toMatch('teacher failed');
  });

  it('returns the input untouched when nothing qualifies', async () => {
    const t = teacher(fields());
    const before = [entry(finding({ score: 30, tier: 'blocker' }))];
    const after = await teach(before, ctx(), t.llm, { scoring }, () => {});
    expect(after).toEqual(before);
    expect(t.calls).toHaveLength(0);
  });

  it('caps plain comments at 80 prose words and taught bodies at 180', () => {
    expect(MAX_INLINE_WORDS).toBe(80);
    expect(MAX_TAUGHT_WORDS).toBe(180);
    expect(deterministicComment(finding()).split('\n').length).toBeGreaterThan(0);
  });
});
