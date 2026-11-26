import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { PKG_ROOT } from '../src/lib/paths.js';

/**
 * Eval fixtures and every example in the docs are fiction: an invented `acme/*`
 * company with an invented schema. Reviewing real private repositories is how
 * this tool gets better, and the temptation afterwards is to paste the real
 * table and column names into a fixture "as an example". That publishes someone
 * else's production schema, so this gate is an ALLOWLIST: content may use a name
 * the registry declares and nothing else. A denylist of the real names would
 * publish the very thing it forbids.
 *
 * The rules read JSON string values (so escaped newlines in fixture files are
 * real text again), ignore keys, and skip path-like tokens, which keeps them
 * quiet on JavaScript and Go source. `fiction catches a pasted schema` below is
 * the proof that each rule fires, so a rule cannot rot into a no-op.
 */

interface Vocabulary {
  orgs: string[];
  repos: string[];
  schemas: string[];
  tables: string[];
  columns: string[];
  constraints: string[];
  /** neutral non-schema words that prose and docs may mention */
  words: string[];
}

interface Text {
  owner: string;
  text: string;
}

const VOCAB = JSON.parse(readFileSync(path.join(PKG_ROOT, 'config/fixture-vocabulary.json'), 'utf8')) as Vocabulary;
const FIXTURE_ROOT = path.join(PKG_ROOT, 'eval', 'fixtures');

const SNAKE = /[a-z][a-z0-9]*(?:_[a-z0-9]+)+/g;
const SQL_HEAD = /^\s*(select|insert|update|delete|with)\b/i;
const DDL_TABLE = /\bcreate\s+table\s+(?:if\s+not\s+exists\s+)?([a-zA-Z_][\w.]*)\s*\(/gi;
const DML_TABLE = /\b(?:from|join|into|update)\s+([a-zA-Z_][\w.]*)/gi;
const CONSTRAINT_HEAD = /^(primary key|unique|foreign key|constraint|check|exclude)\b/i;
const GITHUB_ORG = /github\.com\/([A-Za-z0-9._-]+)\//g;
const LOCAL_PATH = /(?:^|[\s"'(])(?:\/Users\/|\/home\/|\/var\/folders\/|[A-Za-z]:\\\\)/;
const QUOTED = /(['"`])((?:\\.|(?!\1)[\s\S])*?)\1/g;

const knownTables = new Set([...VOCAB.tables, ...VOCAB.schemas]);
const knownColumns = new Set([...VOCAB.columns, ...VOCAB.tables, ...VOCAB.schemas]);
const knownEverywhere = new Set([
  ...VOCAB.columns,
  ...VOCAB.tables,
  ...VOCAB.schemas,
  ...VOCAB.constraints,
  ...VOCAB.words,
]);

/** Rule 1: a fixture stands for an invented repo, never a real one. */
function checkRepo(name: string, repo: string): string[] {
  const [org, slug] = repo.split('/');
  if (!VOCAB.orgs.includes(org?.toLowerCase())) return [`${name}: repo "${repo}" is not an invented org`];
  if (!VOCAB.repos.includes(slug)) return [`${name}: repo "${repo}" is not declared in config/fixture-vocabulary.json`];
  return [];
}

/** Rule 2: no real GitHub org and no local filesystem path in any example. */
function checkLinks(texts: Text[]): string[] {
  const problems: string[] = [];
  for (const { owner, text } of texts) {
    for (const m of text.matchAll(GITHUB_ORG)) {
      if (!VOCAB.orgs.includes(m[1].toLowerCase())) problems.push(`${owner}: github.com/${m[1]}/ is not an allowed org`);
    }
    if (LOCAL_PATH.test(text)) problems.push(`${owner}: mentions a local filesystem path`);
  }
  return problems;
}

/** Rule 3: every snake_case identifier in a fixture is a declared one. */
function checkIdentifiers(texts: Text[]): string[] {
  const problems: string[] = [];
  for (const { owner, text } of texts) {
    const stripped = text.replace(/[\w.@-]*\/[\w.@-]+/g, ' ');
    for (const m of stripped.matchAll(SNAKE)) {
      if (!knownEverywhere.has(m[0])) problems.push(`${owner}: "${m[0]}" is not declared in config/fixture-vocabulary.json`);
    }
  }
  return [...new Set(problems)];
}

function segments(name: string): string[] {
  return name
    .toLowerCase()
    .split('.')
    .map((s) => s.replace(/["`;,]/g, '').trim())
    .filter(Boolean);
}

/** Rule 4: a CREATE TABLE anyone can read is a schema fact anyone can read. */
function checkDdl(texts: Text[]): string[] {
  const problems: string[] = [];
  for (const { owner, text } of texts) {
    for (const m of text.matchAll(DDL_TABLE)) {
      for (const seg of segments(m[1])) {
        if (!knownTables.has(seg)) problems.push(`${owner}: table "${seg}" is not declared`);
      }
      const open = text.indexOf('(', m.index ?? 0);
      let depth = 0;
      let end = open;
      for (; end < text.length; end++) {
        if (text[end] === '(') depth++;
        else if (text[end] === ')' && --depth === 0) break;
      }
      for (const raw of text.slice(open + 1, end).split(/,(?![^(]*\))/)) {
        const entry = raw.trim().replace(/^\+/, '').trim();
        if (!entry) continue;
        if (CONSTRAINT_HEAD.test(entry)) {
          const named = entry.match(/^constraint\s+([a-zA-Z_]\w*)/i);
          if (named && !VOCAB.constraints.includes(named[1].toLowerCase())) {
            problems.push(`${owner}: constraint "${named[1]}" is not declared`);
          }
          for (const col of entry.match(/\(([^)]*)\)/)?.[1].split(',') ?? []) {
            const c = col.trim().toLowerCase();
            if (c && !knownColumns.has(c)) problems.push(`${owner}: column "${c}" is not declared`);
          }
        } else {
          const col = entry.match(/^([a-zA-Z_]\w*)/)?.[1].toLowerCase();
          if (col && !knownColumns.has(col)) problems.push(`${owner}: column "${col}" is not declared`);
        }
      }
    }
  }
  return [...new Set(problems)];
}

/** Rule 5: SQL quoted in code or prose names declared tables only. */
function checkSqlStatements(texts: Text[]): string[] {
  const problems: string[] = [];
  for (const { owner, text } of texts) {
    for (const m of text.matchAll(QUOTED)) {
      if (!SQL_HEAD.test(m[2])) continue;
      for (const ref of m[2].matchAll(DML_TABLE)) {
        for (const seg of segments(ref[1])) {
          if (!knownTables.has(seg)) problems.push(`${owner}: SQL names table "${seg}" which is not declared`);
        }
      }
    }
  }
  return [...new Set(problems)];
}

/** Every string value in a parsed JSON tree; keys are labels, not content. */
function stringsIn(node: unknown, out: string[] = []): string[] {
  if (typeof node === 'string') out.push(node);
  else if (Array.isArray(node)) for (const v of node) stringsIn(v, out);
  else if (node && typeof node === 'object') for (const v of Object.values(node)) stringsIn(v, out);
  return out;
}

function fixtureDirs(): string[] {
  return readdirSync(FIXTURE_ROOT, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => path.join(FIXTURE_ROOT, d.name));
}

function readJson(dir: string, file: string): unknown {
  return JSON.parse(readFileSync(path.join(dir, file), 'utf8'));
}

function fixtureTexts(): Text[] {
  const rows: Text[] = [];
  for (const dir of fixtureDirs()) {
    const name = path.basename(dir);
    for (const file of readdirSync(dir)) {
      for (const text of stringsIn(readJson(dir, file))) rows.push({ owner: `${name}/${file}`, text });
    }
  }
  return rows;
}

function filesUnder(rel: string, accept: (name: string) => boolean): Text[] {
  const out: Text[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (['node_modules', 'dist', 'runs'].includes(entry.name)) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (accept(entry.name)) out.push({ owner: path.relative(PKG_ROOT, full), text: readFileSync(full, 'utf8') });
    }
  };
  walk(path.join(PKG_ROOT, rel));
  return out;
}

/**
 * Prose a reader copies from: docs, prompts, the skill's own instructions and
 * the fixtures. The blanket identifier rule applies here, where a real schema
 * name slips in unnoticed.
 */
function proseTexts(): Text[] {
  const roots = ['README.md', 'AGENTS.md'].map((f) => ({ owner: f, text: readFileSync(path.join(PKG_ROOT, f), 'utf8') }));
  return [...roots, ...filesUnder('prompts', () => true), ...filesUnder('skills', (f) => f.endsWith('.md')), ...fixtureTexts()];
}

/**
 * Everything else: sources, tests, the skill's scripts. Real code legitimately
 * mentions `html_url` and `child_process`, so the identifier rule stays off it —
 * but the SQL-shaped rules apply, because a `SELECT ... FROM real.real_table`
 * pasted into a unit test is the same leak as one pasted into a fixture.
 */
function codeTexts(): Text[] {
  // This test file is excluded: it holds a synthetic private schema, on purpose,
  // to prove the rules fire. Every other test is scanned like any other source.
  const tests = filesUnder('tests', (f) => f.endsWith('.ts') && f !== 'fixture-hygiene.test.ts');
  return [...proseTexts(), ...tests, ...filesUnder('src', () => true), ...filesUnder('skills', (f) => !f.endsWith('.md'))];
}

describe('fixture fiction registry', () => {
  it('declares lowercase identifiers only, without duplicates', () => {
    const problems: string[] = [];
    for (const [key, list] of Object.entries(VOCAB)) {
      for (const name of list) if (!/^[a-z][a-z0-9_]*$/.test(name)) problems.push(`${key}: "${name}" is not an identifier`);
      if (new Set(list).size !== list.length) problems.push(`${key}: duplicate entry`);
    }
    expect(problems).toEqual([]);
  });
});

describe('the repo obeys the fiction rules', () => {
  it('every fixture stands for an invented repo', () => {
    const problems = fixtureDirs().flatMap((dir) => {
      const meta = readJson(dir, 'fixture.json') as { repo: string };
      return checkRepo(path.basename(dir), meta.repo);
    });
    expect(problems).toEqual([]);
  });

  it('nowhere names a real GitHub org or a local path', () => expect(checkLinks(codeTexts())).toEqual([]));
  it('every schema identifier in prose and fixtures is declared', () => expect(checkIdentifiers(proseTexts())).toEqual([]));
  it('every CREATE TABLE shown is made of declared tables and columns', () => expect(checkDdl(codeTexts())).toEqual([]));
  it('every SQL statement quoted names declared tables', () => expect(checkSqlStatements(codeTexts())).toEqual([]));
});

describe('fiction catches a pasted schema', () => {
  // A private schema that is nowhere in this repo: the point is that unknown
  // names fail, not that these particular ones do.
  const leakyDDL =
    'CREATE TABLE billing.invoice_header (\n' +
    '    tenant_id uuid NOT NULL,\n' +
    '    invoice_number text NOT NULL,\n' +
    '    CONSTRAINT uq_billing_invoice_header_tenant_invoice_number UNIQUE (tenant_id, invoice_number),\n' +
    '    PRIMARY KEY (tenant_id)\n' +
    ');\n';
  const leakySql = "const rows = await db.query(`UPDATE billing.invoice_header SET invoice_number = $2 WHERE tenant_id = $1`);";
  const leakyProse = 'The finding rests on UNIQUE (tenant_id, invoice_number) in billing.invoice_header.';
  const leaky: Text[] = [
    { owner: 'leak/fixture.json', text: 'billing.invoice_header' },
    { owner: 'leak/pr.json', text: leakyDDL + leakySql },
    { owner: 'leak/scripted.json', text: leakyProse },
  ];

  it('rejects a fixture standing for a real repo', () =>
    expect(checkRepo('leak', 'realcorp/billing-service')).toEqual([
      'leak: repo "realcorp/billing-service" is not an invented org',
    ]));

  it('rejects a real GitHub org in prose', () =>
    expect(checkLinks([{ owner: 'README.md', text: 'see https://github.com/realcorp/billing/pull/9' }])).toEqual([
      'README.md: github.com/realcorp/ is not an allowed org',
    ]));

  it('rejects undeclared columns, tables and constraint names', () => {
    const found = checkIdentifiers(leaky).join('\n');
    for (const name of ['tenant_id', 'invoice_number', 'invoice_header', 'uq_billing_invoice_header_tenant_invoice_number']) {
      expect(found).toContain(`"${name}"`);
    }
  });

  it('rejects the shape of a real CREATE TABLE', () => {
    const found = checkDdl(leaky).join('\n');
    expect(found).toContain('table "billing" is not declared');
    expect(found).toContain('column "tenant_id" is not declared');
    expect(found).toContain('column "invoice_number" is not declared');
    expect(found).toContain('constraint "uq_billing_invoice_header_tenant_invoice_number" is not declared');
  });

  it('rejects SQL embedded in code that touches an undeclared table', () =>
    expect(checkSqlStatements(leaky).join('\n')).toContain('SQL names table "billing" which is not declared'));

  it('stays quiet on invented schema and on ordinary source code', () => {
    const fine: Text[] = [
      { owner: 'ok/pr.json', text: "const rows = await db.query('SELECT product_id FROM products WHERE sku = $2');" },
      { owner: 'ok/pr.json', text: 'app.post("/orders", function handler (req, res) { res.json({ ok: true }); });' },
    ];
    expect(checkIdentifiers(fine)).toEqual([]);
    expect(checkDdl(fine)).toEqual([]);
    expect(checkSqlStatements(fine)).toEqual([]);
  });
});
