import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkTaught, isTaught, renderTaughtBody, TEACH_LABELS } from '../src/agents/teach.js';
import { MAX_INLINE_WORDS, MAX_TAUGHT_WORDS } from '../src/lib/format.js';
import {
  MAX_INLINE_WORDS as SCRIPT_PLAIN_WORDS,
  MAX_TAUGHT_WORDS as SCRIPT_MAX_TAUGHT_WORDS,
  TEACH_LABELS as SCRIPT_LABELS,
  isTaught as scriptIsTaught,
  wordCapFor,
} from '../skills/heimdall-review/scripts/teach-gate.mjs';
import type { VerifiedFinding } from '../src/lib/types.js';

/**
 * AGENTS.md hard rule: the CLI and the skill stay in parity. The skill's gate is
 * a compact .mjs mirror of src/agents/teach.ts, so the only honest test is to
 * hand both the same bodies and demand the same verdicts. The script is driven
 * as a child process, the way the skill runs it.
 */
const SCRIPT = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  'skills',
  'heimdall-review',
  'scripts',
  'check-taught.mjs',
);

const CODE = "export function getUser(req, res) {\n  const user = db.users.byId(req.params.id);\n  res.send(user);\n}\n";

function finding(over: Partial<VerifiedFinding> = {}): VerifiedFinding {
  return {
    findingId: 'aaa111bbb222',
    agent: 'security',
    mergedAgents: ['security'],
    file: 'src/routes.js',
    line: 2,
    title: 'A missing user is rendered as a null body',
    verifiedEvidence: '  res.send(user);',
    why: 'byId returns undefined for an unknown id.',
    suggestion: 'Return 404 when the lookup misses.',
    status: 'keep',
    impact: 2,
    certainty: 2,
    blastRadius: 2,
    score: 6,
    tier: 'nit',
    ...over,
  };
}

/** The final.json record the skill's Step 4 wrote, plus the comment Step 5 wrote. */
function workdir(entries: { record: VerifiedFinding; comment: string }[], code = CODE): string {
  const dir = mkdtempSync(join(tmpdir(), 'heimdall-taught-'));
  mkdirSync(join(dir, 'agents'), { recursive: true });
  mkdirSync(join(dir, 'files', 'src'), { recursive: true });
  writeFileSync(join(dir, 'files', 'src', 'routes.js'), code);
  writeFileSync(
    join(dir, 'agents', 'security.final.json'),
    JSON.stringify(entries.map((e) => e.record), null, 2),
  );
  writeFileSync(
    join(dir, 'consolidated.json'),
    JSON.stringify(
      entries.map((e) => ({
        findingId: e.record.findingId,
        file: e.record.file,
        line: e.record.line,
        tier: e.record.tier,
        title: e.record.title,
        status: e.record.status,
        mergedAgents: e.record.mergedAgents,
        comment: e.comment,
        replyTo: null,
      })),
      null,
      2,
    ),
  );
  return dir;
}

interface ScriptResult {
  code: number;
  json: {
    below: number;
    eligible: number;
    taught: number;
    unexplained: string[];
    ok: boolean;
    checked: { findingId: string; verdict: string; reason?: string }[];
    rejected: { findingId: string; reason: string }[];
  };
  stdout: string;
}

function runGate(dir: string, below?: number): ScriptResult {
  const argv = [SCRIPT, '--dir', dir, ...(below === undefined ? [] : ['--below', String(below)])];
  let code = 0;
  let stdout = '';
  try {
    stdout = execFileSync('node', argv, { encoding: 'utf8' });
  } catch (err) {
    const e = err as { status?: number; stdout?: string };
    code = e.status ?? 1;
    stdout = e.stdout ?? '';
  }
  return { code, json: JSON.parse(stdout) as ScriptResult['json'], stdout };
}

const fields = {
  what: 'getUser sends whatever the lookup returned, and it never checks that shape.',
  why: 'An unknown id makes byId return undefined, so the client gets an empty 200 instead of a 404.',
  how: 'Answer 404 when the lookup has no row, before sending anything.',
};

const taughtBody = (f: VerifiedFinding = finding()) => renderTaughtBody(f, fields);

describe('the skill teach gate agrees with the CLI gate', () => {
  it('ships the script next to the other harness gates', () => {
    expect(existsSync(SCRIPT)).toBe(true);
  });

  it('accepts a taught body the CLI renderer produced', () => {
    const f = finding();
    const dir = workdir([{ record: f, comment: taughtBody(f) }]);
    const res = runGate(dir);
    expect(res.stdout).toBe(res.stdout.trim() + '\n'); // one JSON document on stdout
    expect(res.code).toBe(0);
    expect(res.json).toMatchObject({ below: 60, eligible: 1, taught: 1, ok: true });
    expect(res.json.checked[0]).toMatchObject({ findingId: f.findingId, verdict: 'accepted' });
  });

  const cases: { name: string; make: (f: VerifiedFinding) => string }[] = [
    {
      name: 'a missing label',
      make: (f) => taughtBody(f).replace('**Why it breaks:**', '**Because:**'),
    },
    {
      name: 'an altered quote',
      make: (f) => taughtBody(f).replace('  res.send(user);', '  res.send(user)'),
    },
    {
      name: 'a dropped quote',
      make: (f) => taughtBody(f).replace('```\n  res.send(user);\n```', 'no quote here'),
    },
    {
      name: 'an over-budget body',
      make: (f) => `${taughtBody(f)} ${'extra words '.repeat(MAX_TAUGHT_WORDS)}`,
    },
    {
      name: 'a body that restates nothing but keeps the shape',
      make: (f) => renderTaughtBody(f, { ...fields, tryThis: 'if (!user) return res.status(404).end();' }),
    },
  ];

  for (const c of cases) {
    it(`rejects ${c.name} exactly where the CLI gate does`, () => {
      const f = finding();
      const comment = c.make(f);
      const dir = workdir([{ record: f, comment }]);
      const res = runGate(dir);
      const cliAccepts = checkTaught(comment, f).ok;
      expect(res.json.checked[0]?.verdict).toBe(cliAccepts ? 'accepted' : 'rejected');
      expect(res.code).toBe(cliAccepts ? 0 : 1);
      if (!cliAccepts) expect(res.json.rejected[0]?.reason).toBeTruthy();
    });
  }

  it('rejects a record whose tier or score moved on the way to consolidated.json', () => {
    const f = finding();
    const dir = workdir([{ record: f, comment: taughtBody(f) }]);
    const consolidated = JSON.parse(readFileSync(join(dir, 'consolidated.json'), 'utf8')) as Record<string, unknown>[];
    consolidated[0]!.tier = 'blocker';
    writeFileSync(join(dir, 'consolidated.json'), JSON.stringify(consolidated));
    const res = runGate(dir);
    expect(res.code).toBe(1);
    expect(res.json.rejected[0]?.reason).toMatch(/tier/);
  });

  it('rejects a finding whose record was edited on the way to consolidated.json', () => {
    const f = finding();
    const dir = workdir([{ record: f, comment: taughtBody(f) }]);
    const consolidated = JSON.parse(readFileSync(join(dir, 'consolidated.json'), 'utf8')) as Record<string, unknown>[];
    consolidated[0]!.title = 'Something else entirely';
    writeFileSync(join(dir, 'consolidated.json'), JSON.stringify(consolidated));
    const res = runGate(dir);
    expect(res.code).toBe(1);
    expect(res.json.rejected[0]?.reason).toMatch(/title/);
  });

  it('leaves terse comments alone and teaches nothing above the bar', () => {
    const above = finding({ findingId: 'ccc333ddd444', score: 24, tier: 'blocker', impact: 8, certainty: 8, blastRadius: 8 });
    const dir = workdir([{ record: above, comment: `**${above.title}**\n\n(src/routes.js:2)` }]);
    const res = runGate(dir);
    expect(res.code).toBe(0);
    expect(res.json).toMatchObject({ eligible: 0, taught: 0, ok: true });
    expect(res.json.checked[0]?.verdict).toBe('plain');
  });

  it('declares an eligible finding that was left terse without failing the run', () => {
    const f = finding();
    const dir = workdir([{ record: f, comment: `**${f.title}**\n\n(src/routes.js:2)` }]);
    const res = runGate(dir);
    expect(res.code).toBe(0);
    expect(res.json).toMatchObject({ eligible: 1, taught: 0, ok: true });
    expect(res.json.unexplained).toEqual([f.findingId]);
  });

  it('takes the bar from --below and falls back to config/scoring.json', () => {
    const f = finding({ findingId: 'eee555fff666', score: 12, impact: 5, certainty: 4, blastRadius: 3 });
    const at60 = runGate(workdir([{ record: f, comment: taughtBody(f) }]));
    expect(at60.json).toMatchObject({ below: 60, eligible: 1, ok: true });

    const at30 = runGate(workdir([{ record: f, comment: taughtBody(f) }]), 30);
    expect(at30.json).toMatchObject({ below: 30, eligible: 0, taught: 0, ok: true });
    expect(at30.json.checked[0]?.verdict).toBe('accepted'); // a taught body is still checked
  });

  it('says what it checked, so the report can declare it', () => {
    const low = finding();
    const high = finding({ findingId: 'ggg777hhh888', file: 'src/other.js', score: 24, tier: 'blocker' });
    const dir = workdir([
      { record: low, comment: taughtBody(low) },
      { record: high, comment: `**${high.title}**\n\n(src/other.js:2)` },
    ]);
    mkdirSync(join(dir, 'files', 'src'), { recursive: true });
    const res = runGate(dir);
    expect(res.json.checked.map((c) => c.verdict)).toEqual(['accepted', 'plain']);
    expect(res.json).toMatchObject({ eligible: 1, taught: 1, ok: true });
  });
});

// The publisher enforces the 80-word voice cap on every comment it posts. A
// taught body is legitimately longer, so the cap has to come from one place —
// otherwise the skill would warn on every taught comment it is allowed to ship.
describe('the word budget the skill shares', () => {
  it('names the same labels and budgets as the CLI', () => {
    expect([...SCRIPT_LABELS]).toEqual([...TEACH_LABELS]);
    expect(SCRIPT_MAX_TAUGHT_WORDS).toBe(MAX_TAUGHT_WORDS);
    expect(SCRIPT_PLAIN_WORDS).toBe(MAX_INLINE_WORDS);
  });

  it('reads a body the same way the CLI does', () => {
    const f = finding();
    const bodies = [
      taughtBody(f),
      `**${f.title}**\n\n(src/routes.js:2)`,
      taughtBody(f).replace('**How to fix it:**', '**Fix:**'),
    ];
    for (const body of bodies) expect(scriptIsTaught(body)).toBe(isTaught(body));
  });

  it('budgets a taught body at 180 prose words and a terse one at 80', () => {
    const f = finding();
    expect(wordCapFor(taughtBody(f))).toBe(MAX_TAUGHT_WORDS);
    expect(wordCapFor(`**${f.title}**\n\n(src/routes.js:2)`)).toBe(MAX_INLINE_WORDS);
  });

  it('is the only place the publisher reads the cap from', () => {
    const publisher = readFileSync(join(dirname(SCRIPT), 'post-review.mjs'), 'utf8');
    expect(publisher).toMatch(/teach-gate\.mjs/);
    expect(publisher).not.toMatch(/^const MAX_INLINE_WORDS = \d+;/m);
  });
});
