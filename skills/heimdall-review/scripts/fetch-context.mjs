#!/usr/bin/env node
/**
 * Deterministic context fetch for the heimdall-review skill. No dependencies,
 * no LLM — everything here is fact-gathering via gh, written to disk so the
 * orchestrating agent reads facts, never guesses them.
 *
 * usage: fetch-context.mjs <owner/repo> <pr> <outdir>
 */
import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const [,, repo, prNum, outDirArg] = process.argv;
if (!repo || !prNum || !outDirArg) {
  console.error('usage: fetch-context.mjs <owner/repo> <pr> <outdir>');
  process.exit(1);
}

const OUT = path.resolve(outDirArg);
const FILE_CAP = 12_000; // chars of head content per file
const SPEC_BUDGET = 60_000;
const DOC_BUDGET = 40_000;

const GH_TIMEOUT_MS = Number(process.env.HEIMDALL_GH_TIMEOUT_MS ?? 120_000);
const GH_MAX_OUTPUT = 64 * 1024 * 1024;

/**
 * Spawns gh and always closes its stdin. promisify(execFile) silently DROPS the
 * `input` option (only exec/execSync support it), so an `--input -` call through
 * it would wait on stdin forever, and a stdin that is never EOF'd turns any gh
 * interactive prompt (auth, keychain) into an infinite hang instead of an error.
 * The timeout is the backstop: a stalled call fails with a message.
 */
function run(cmd, args, { input, timeout = GH_TIMEOUT_MS } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args);
    let stdout = '';
    let stderr = '';
    let bytes = 0;
    let done = false;
    const finish = (fn, value) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      fn(value);
    };
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      finish(reject, Object.assign(new Error(`${cmd} timed out after ${Math.round(timeout / 1000)}s`), { stderr }));
    }, timeout);
    child.stdout.on('data', (d) => {
      bytes += d.length;
      if (bytes > GH_MAX_OUTPUT) {
        child.kill('SIGKILL');
        return finish(reject, Object.assign(new Error(`${cmd} output exceeded ${GH_MAX_OUTPUT} bytes`), { stderr }));
      }
      stdout += d;
    });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('error', (e) => finish(reject, Object.assign(e, { stderr })));
    child.on('close', (code) => (code === 0
      ? finish(resolve, stdout)
      : finish(reject, Object.assign(new Error(`${cmd} exited with code ${code}`), { stderr }))));
    child.stdin.end(input); // undefined => EOF immediately
  });
}

async function gh(args, { input, allowFail = false } = {}) {
  try {
    return await run('gh', args, { input });
  } catch (e) {
    if (allowFail) return '';
    throw new Error(`gh ${args.join(' ')} failed: ${String(e.stderr || e.message).slice(0, 300)}`);
  }
}
const ghJson = async (args, opts) => JSON.parse((await gh(args, opts)) || 'null');

function globMatch(pattern, p) {
  const escaped = pattern
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*\*\//g, '\u0000SLASHSTAR\u0000')
    .replace(/\*\*/g, '\u0000DOUBLESTAR\u0000')
    .replace(/\*/g, '[^/]*')
    .replace(/\?/g, '[^/]')
    .replace(/\u0000SLASHSTAR\u0000/g, '(?:.*/)?')
    .replace(/\u0000DOUBLESTAR\u0000/g, '.*');
  return new RegExp(`^${escaped}$`).test(p);
}

function parsePatch(diffText) {
  const files = [];
  let cur = null;
  let headLine = 0;
  let inHunk = false;
  const flush = () => {
    if (cur) files.push(cur);
    cur = null;
  };
  for (const line of diffText.split('\n')) {
    if (line.startsWith('diff --git ')) {
      flush();
      const m = line.match(/ b\/(.+)$/);
      cur = { path: m?.[1] ?? 'unknown', status: 'modified', patchLines: [line], added: 0, removed: 0, changedLines: [] };
      headLine = 0;
      inHunk = false;
      continue;
    }
    if (!cur) continue;
    cur.patchLines.push(line);
    if (line.startsWith('new file mode')) { cur.status = 'added'; continue; }
    if (line.startsWith('deleted file mode')) { cur.status = 'removed'; continue; }
    if (line.startsWith('rename from ') || line.startsWith('rename to ')) { cur.status = 'renamed'; continue; }
    if (/^(---|\+\+\+|index |similarity |dissimilarity |old mode |new mode |copy from |copy to )/.test(line)) continue;
    const hunk = line.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
    if (hunk?.[1]) { headLine = Number(hunk[1]); inHunk = true; continue; }
    if (!inHunk || line.startsWith('\\')) continue;
    if (line.startsWith('+')) { cur.added++; cur.changedLines.push(headLine); headLine++; }
    else if (line.startsWith('-')) cur.removed++;
    else headLine++;
  }
  flush();
  return files.map((f) => ({ path: f.path, status: f.status, added: f.added, removed: f.removed, changedLines: f.changedLines, patch: f.patchLines.join('\n') }));
}

// ---------------------------------------------------------------- fetch ----
mkdirSync(path.join(OUT, 'files'), { recursive: true });
mkdirSync(path.join(OUT, 'agents'), { recursive: true });
mkdirSync(path.join(OUT, 'docs'), { recursive: true });

const view = await ghJson(['pr', 'view', prNum, '--repo', repo, '--json', 'number,title,body,author,url,headRefName,baseRefName,headRefOid,comments']);
const pr = {
  number: view.number, title: view.title, body: view.body ?? '',
  author: view.author?.login ?? 'unknown', url: view.url,
  headRef: view.headRefName, baseRef: view.baseRefName, headSha: view.headRefOid,
};

// Commit list: the author's stated intent — ticket-resolution hop + context.
try {
  const commitList = await ghJson(['api', `repos/${repo}/pulls/${prNum}/commits`, '--paginate']);
  pr.commits = (Array.isArray(commitList) ? commitList : []).slice(0, 50)
    .map((c) => ({ oid: c.oid, subject: String(c.commit?.message ?? '').split('\n')[0] ?? '' }));
} catch { pr.commits = []; }

const manifestRaw = await gh(['api', `repos/${repo}/contents/.pr-review.json?ref=${pr.headSha}`, '-H', 'Accept: application/vnd.github.raw'], { allowFail: true });
let manifest = {};
try { manifest = manifestRaw ? JSON.parse(manifestRaw) : {}; } catch { manifest = {}; } // bad manifest = defaults, declared below
writeFileSync(path.join(OUT, 'manifest.json'), JSON.stringify(manifest, null, 2));
writeFileSync(path.join(OUT, 'pr.json'), JSON.stringify(pr, null, 2));

const diffText = await gh(['pr', 'diff', prNum, '--repo', repo]);
writeFileSync(path.join(OUT, 'diff.patch'), diffText);

const skip = manifest.skip ?? ['**/*.lock', '**/package-lock.json', '**/yarn.lock', '**/pnpm-lock.yaml', '**/dist/**', '**/build/**', '**/generated/**', '**/*.min.js', '**/*.min.css'];
const maxFile = manifest.maxFileChangedLines ?? 400;
const maxTotal = manifest.maxTotalChangedLines ?? 3000;

const parsed = parsePatch(diffText);
const skipped = [];
const kept = [];
for (const f of parsed) {
  if (skip.some((g) => globMatch(g, f.path))) { skipped.push({ file: f.path, reason: 'skip pattern' }); continue; }
  if (f.added + f.removed > maxFile) { skipped.push({ file: f.path, reason: `over per-file cap (${f.added + f.removed} changed lines)` }); continue; }
  kept.push(f);
}
let total = 0;
const review = [];
for (const f of [...kept].sort((a, b) => b.added + b.removed - (a.added + a.removed))) {
  if (total + f.added + f.removed > maxTotal) { skipped.push({ file: f.path, reason: 'over total cap' }); continue; }
  total += f.added + f.removed;
  review.push(f);
}
review.sort((a, b) => a.path.localeCompare(b.path));

const filesMeta = [];
for (const f of review) {
  let truncated = false;
  let content = null;
  if (f.status !== 'removed') {
    const raw = await gh(['api', `repos/${repo}/contents/${f.path}?ref=${pr.headSha}`, '-H', 'Accept: application/vnd.github.raw'], { allowFail: true });
    content = raw || null;
    if (content && content.length > FILE_CAP) {
      content = content.slice(0, FILE_CAP) + '\n[truncated by heimdall — quotes beyond this point cannot be verified]';
      truncated = true;
    }
  }
  const dest = path.join(OUT, 'files', f.path);
  mkdirSync(path.dirname(dest), { recursive: true });
  if (content !== null) writeFileSync(dest, content);
  filesMeta.push({ ...f, contentAvailable: content !== null, truncated });
}
writeFileSync(path.join(OUT, 'files.json'), JSON.stringify(filesMeta, null, 2));
writeFileSync(path.join(OUT, 'skipped.json'), JSON.stringify(skipped, null, 2));

// --- comments (body + inline + resolution state, best effort) --------------
const comments = (view.comments ?? []).map((c) => ({ author: c.author?.login ?? 'unknown', body: c.body }));
const rcs = await ghJson(['api', `repos/${repo}/pulls/${prNum}/comments`, '--paginate'], { allowFail: true }).catch(() => null);
for (const rc of rcs ?? []) {
  comments.push({ author: rc.user?.login ?? 'unknown', body: rc.body, file: rc.path, line: rc.line ?? undefined, commentId: rc.id, resolved: undefined });
}
let threadsTrusted = false;
const [owner, name] = repo.split('/');
const gql = await gh(['api', 'graphql', '-f',
  'query=query($owner:String!,$name:String!,$number:Int!){repository(owner:$owner,name:$name){pullRequest(number:$number){reviewThreads(first:100){nodes{isResolved comments(first:100){nodes{databaseId}}}}}}}',
  '-f', `owner=${owner}`, '-f', `name=${name}`, '-F', `number=${Number(prNum)}`], { allowFail: true }).catch(() => '');
if (gql) {
  try {
    const nodes = JSON.parse(gql).data?.repository?.pullRequest?.reviewThreads?.nodes ?? [];
    for (const t of nodes) {
      const ids = new Set((t.comments?.nodes ?? []).map((c) => c.databaseId));
      for (const c of comments) if (c.commentId !== undefined && ids.has(c.commentId)) c.resolved = t.isResolved;
    }
    threadsTrusted = true;
  } catch { threadsTrusted = false; }
}
writeFileSync(path.join(OUT, 'comments.json'), JSON.stringify({ threadsTrusted, comments }, null, 2));

// --- ticket: flag absent here; body > commits > branch. Never a guess. -----
const linkRe = /\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?|ref[s]?)\b[^\d]{0,60}?(?:issues\/|#)\s*(\d+)/gi;
let ticketNumber = null;
let ticketSource = 'none';
const m = linkRe.exec(pr.body);
if (m?.[1]) { ticketNumber = Number(m[1]); ticketSource = 'body'; }
if (!ticketNumber) {
  for (const c of pr.commits ?? []) {
    linkRe.lastIndex = 0;
    const cm = linkRe.exec(c.subject);
    if (cm?.[1]) { ticketNumber = Number(cm[1]); ticketSource = 'commit'; break; }
  }
}
if (!ticketNumber) {
  const b = pr.headRef.match(/(?:^|[/_-])(\d{1,6})(?:[-_]|$)/);
  if (b?.[1]) { ticketNumber = Number(b[1]); ticketSource = 'branch'; }
}
let ticket = null;
if (ticketNumber) {
  const issue = await ghJson(['issue', 'view', String(ticketNumber), '--repo', repo, '--json', 'number,title,body,url'], { allowFail: true }).catch(() => null);
  if (issue) ticket = { ...issue, source: ticketSource };
}
writeFileSync(path.join(OUT, 'ticket.json'), JSON.stringify(
  ticket ?? { number: null, note: 'NO TICKET LINKED — requirements are UNVERIFIED. Do not invent requirements.' },
  null, 2,
));

// --- specs + per-agent docs (tree scan on head sha) -------------------------
let tree = [];
try {
  const t = await ghJson(['api', `repos/${repo}/git/trees/${pr.headSha}?recursive=1`]);
  tree = (t.tree ?? []).filter((x) => x.type === 'blob').map((x) => x.path);
} catch { /* declared below via specs.json empty + note */ }
const specPatterns = manifest.specs ?? ['docs/rfc/**', 'docs/specs/**', 'docs/prd/**', 'docs/adr/**'];
let budget = SPEC_BUDGET;
const specs = [];
for (const p of tree.filter((p) => specPatterns.some((g) => globMatch(g, p)))) {
  if (budget <= 0) break;
  const c = await gh(['api', `repos/${repo}/contents/${p}?ref=${pr.headSha}`, '-H', 'Accept: application/vnd.github.raw'], { allowFail: true });
  if (!c) continue;
  const cut = c.length > budget ? c.slice(0, budget) : c;
  specs.push({ path: p, content: cut });
  budget -= cut.length;
}
writeFileSync(path.join(OUT, 'specs.json'), JSON.stringify(specs, null, 2));

// --- migrations naming tables the diff references — schema facts ------------
// Mirror of src/lib/schema.ts + the manifest `migrations` globs. A constraint
// claim (e.g. "this column is not unique") must cite these files or degrade to
// a question; the fetch itself is deterministic, no model involved.
const SQL_NOISE = new Set(['select', 'set', 'values', 'unnest', 'lateral', 'only', 'exists', 'rows', 'range',
  'generate_series', 'jsonb_array_elements', 'jsonb_each', 'regexp_split_to_table', 'table', 'index', 'if', 'not', 'final', 'public']);
function extractTableRefs(text) {
  const names = new Set();
  for (const re of [
    /\b(?:from|join|into|update)\s+(?:if\s+(?:not\s+)?exists\s+)?([a-zA-Z_][\w$]*(?:\.[a-zA-Z_][\w$]*){0,2})/gi,
    /\b(?:create|drop|alter|truncate)\s+(?:\w+\s+)*?table\s+(?:if\s+(?:not\s+)?exists\s+)?([a-zA-Z_][\w$]*(?:\.[a-zA-Z_][\w$]*){0,2})/gi,
  ]) {
    let m;
    while ((m = re.exec(text)) !== null) {
      for (const part of m[1].toLowerCase().split('.')) {
        if (part.length < 3 || !/^[a-z_][a-z0-9_]*$/.test(part) || SQL_NOISE.has(part)) continue;
        names.add(part);
      }
    }
  }
  return [...names].sort();
}
const MIGRATION_GLOBS = ['**/*migrat*/**']; // mirror of src/lib/manifest.ts MIGRATION_GLOBS
const MIGRATION_BUDGET = 30_000;
const MIGRATION_MAX_FILES = 20;
const migrationGlobs = manifest.migrations ?? MIGRATION_GLOBS;
const tables = extractTableRefs(diffText);
const inDiff = new Set(review.map((f) => f.path));
const migrationPaths = tables.length
  ? tree
      .filter((p) => migrationGlobs.some((g) => globMatch(g, p)))
      .filter((p) => !skip.some((g) => globMatch(g, p)))
      .filter((p) => tables.some((t) => p.toLowerCase().includes(t)))
      .filter((p) => !inDiff.has(p))
      .sort()
  : [];
let migBudget = MIGRATION_BUDGET;
const migrations = [];
for (const p of migrationPaths.slice(0, MIGRATION_MAX_FILES)) {
  if (migBudget <= 0) break;
  const c = await gh(['api', `repos/${repo}/contents/${p}?ref=${pr.headSha}`, '-H', 'Accept: application/vnd.github.raw'], { allowFail: true });
  if (!c) continue;
  const cut = c.length > migBudget ? c.slice(0, migBudget) : c;
  migrations.push({ path: p, content: cut });
  migBudget -= cut.length;
}
writeFileSync(path.join(OUT, 'migrations.json'), JSON.stringify({ tables, migrations }, null, 2));

const AGENTS = ['security', 'requirements', 'e2e-tests', 'architecture', 'regression', 'performance', 'standards'];
// Mirror of src/lib/manifest.ts DEFAULT_DOCS — docs an agent reads even when
// the repo ships no .pr-review.json. [] in the manifest => discover nothing.
// AGENTS.md/CLAUDE.md are NOT here: the shared instruction section below already
// delivers every agent's instruction files.
const DEFAULT_DOCS = {
  security: [], requirements: [], 'e2e-tests': [], architecture: [], regression: [], performance: [],
  standards: ['CONTRIBUTING.md', 'CODING_STANDARDS.md', 'docs/standards/**'],
};
// Mirror of src/lib/manifest.ts AGENT_INSTRUCTION_PATTERNS + instructions.ts caps.
const AGENT_INSTRUCTION_PATTERNS = [
  'AGENTS.md', 'CLAUDE.md', 'GEMINI.md', '.github/copilot-instructions.md',
  '.cursorrules', '.cursor/rules/**', '.qodo/agents/**', '**/AGENTS.md', '**/CLAUDE.md',
];
const INSTRUCTIONS_BUDGET = 30_000;
const INSTRUCTIONS_MAX_FILES = 12;
let docBudget = DOC_BUDGET;
for (const agent of AGENTS) {
  const patterns = manifest.agents?.[agent]?.docs ?? DEFAULT_DOCS[agent] ?? [];
  const docs = [];
  for (const pattern of patterns) {
    const paths = pattern.includes('*') ? tree.filter((p) => globMatch(pattern, p)) : tree.filter((p) => p === pattern);
    for (const p of paths) {
      if (docBudget <= 0) break;
      const c = await gh(['api', `repos/${repo}/contents/${p}?ref=${pr.headSha}`, '-H', 'Accept: application/vnd.github.raw'], { allowFail: true });
      if (!c) continue;
      const cut = c.length > docBudget ? c.slice(0, docBudget) : c;
      docs.push({ path: p, content: cut });
      docBudget -= cut.length;
    }
  }
  writeFileSync(path.join(OUT, 'docs', `${agent}.json`), JSON.stringify(docs, null, 2));
}

// --- repo agent instructions (AGENTS.md, Cursor rules, ...) for all agents --
// Mirror of src/lib/instructions.ts: match patterns, drop skip globs, dedupe,
// order root-level first then nested (alphabetical), cap count and total chars.
let instructionPatterns = manifest.agentInstructions ?? AGENT_INSTRUCTION_PATTERNS;
const instructions = [];
if (instructionPatterns !== false) {
  const seen = new Set();
  for (const p of tree) {
    if (!instructionPatterns.some((g) => globMatch(g, p))) continue;
    if (skip.some((g) => globMatch(g, p))) continue;
    seen.add(p);
  }
  const depth = (p) => (p.includes('/') ? 1 : 0);
  const selected = [...seen].sort((a, b) => depth(a) - depth(b) || a.localeCompare(b)).slice(0, INSTRUCTIONS_MAX_FILES);
  let instrBudget = INSTRUCTIONS_BUDGET;
  for (const p of selected) {
    if (instrBudget <= 0) break;
    const c = await gh(['api', `repos/${repo}/contents/${p}?ref=${pr.headSha}`, '-H', 'Accept: application/vnd.github.raw'], { allowFail: true });
    if (!c) continue;
    let cut = c.length > FILE_CAP ? c.slice(0, FILE_CAP) : c;
    if (cut.length > instrBudget) cut = cut.slice(0, instrBudget);
    instructions.push({ path: p, content: cut });
    instrBudget -= cut.length;
  }
}
writeFileSync(path.join(OUT, 'instructions.json'), JSON.stringify(instructions, null, 2));

const enabled = AGENTS.filter((a) => manifest.agents?.[a]?.enabled !== false);
console.log(JSON.stringify({
  repo, pr: pr.number, title: pr.title, headSha: pr.headSha.slice(0, 8),
  filesInScope: filesMeta.length, skipped: skipped.length,
  truncatedFiles: filesMeta.filter((f) => f.truncated).map((f) => f.path),
  ticket: ticket ? `#${ticket.number} via ${ticketSource}` : 'NONE — requirements unverified',
  specs: specs.length, agentInstructions: instructions.length,
  migrationTables: tables.length, migrations: migrations.length,
  threadsTrusted, agentsEnabled: enabled,
  out: OUT,
}, null, 2));
