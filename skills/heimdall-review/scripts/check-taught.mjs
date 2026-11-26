#!/usr/bin/env node
/**
 * The harness gate for the heimdall-review skill's teach mode — the check the
 * orchestrating agent is NOT allowed to make with its own judgment. Teach mode
 * is opt-in: the reporter asks for it, Step 5 writes a teaching body for the
 * findings that scored under the bar, and this script decides whether each of
 * those bodies may ship. Same rules as src/agents/teach.ts, so a skill run and
 * a CLI run publish the same shape:
 *
 *   - the evidence quote is still there, verbatim, inside a fenced block;
 *   - all three labels are present (prompts/teach.md names them, and this
 *     script reads that file, so a renamed label fails the run instead of
 *     quietly publishing an ungraded comment);
 *   - the prose fits the taught budget (180 words, fenced code free);
 *   - the finding was not edited on the way to consolidated.json: file, line,
 *     tier, title and status are what verify-findings.mjs wrote.
 *
 * It rewrites nothing and touches no verdict. A rejection means Step 5 either
 * fixes that body or drops back to the terse comment — the choice is declared
 * in the result JSON, never hidden. Exit 1 when anything is rejected.
 *
 * usage: check-taught.mjs --dir <workdir> [--below <pct>]
 *   <workdir>/consolidated.json  the comments Step 5 wrote
 *   <workdir>/agents/*.final.json  the verified records (tier, score, quote)
 */
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { realpathSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkTaughtBody, isTaught, looksTaught, scorePct, TEACH_LABELS } from './teach-gate.mjs';

const [,, ...argv] = process.argv;
const arg = (name) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : undefined;
};
const dir = arg('dir');
if (!dir) {
  console.error('usage: check-taught.mjs --dir <workdir> [--below <pct>]');
  process.exit(1);
}

const ROOT = path.resolve(path.dirname(realpathSync(fileURLToPath(import.meta.url))), '..', '..', '..');
const scoring = JSON.parse(readFileSync(path.join(ROOT, 'config', 'scoring.json'), 'utf8'));
const teachCfg = scoring.teach ?? {};
const maxScore = Number(teachCfg.maxScore) > 0 ? Number(teachCfg.maxScore) : 30;
let below = Number(teachCfg.below) >= 0 ? Number(teachCfg.below) : 60;
const flag = arg('below');
if (flag !== undefined) {
  const pct = Number(flag);
  if (!Number.isInteger(pct) || pct < 0 || pct > 100) {
    console.error(`--below wants a whole number from 0 to 100, got "${flag}"`);
    process.exit(1);
  }
  below = pct;
}

// The teaching contract lives in one prompt file the CLI reads too. If a label
// moved there without moving here, stop: a gate that checks a shape nobody is
// asked to write is worse than no gate.
const promptPath = path.join(ROOT, 'prompts', 'teach.md');
const prompt = existsSync(promptPath) ? readFileSync(promptPath, 'utf8') : '';
const stale = TEACH_LABELS.filter((label) => !prompt.includes(label));
if (stale.length) {
  console.error(
    `prompts/teach.md no longer names: ${stale.join(', ')} — update teach-gate.mjs and src/agents/teach.ts together`,
  );
  process.exit(1);
}

const consolidatedPath = path.join(dir, 'consolidated.json');
if (!existsSync(consolidatedPath)) {
  console.log(JSON.stringify({ below, maxScore, eligible: 0, taught: 0, unexplained: [], ok: true, checked: [], rejected: [], note: 'no consolidated.json — nothing to check' }));
  process.exit(0);
}
const consolidated = JSON.parse(readFileSync(consolidatedPath, 'utf8'));
if (!Array.isArray(consolidated)) {
  console.error(`${consolidatedPath} is not a JSON array`);
  process.exit(1);
}

// The verified records are the truth about tier, score and quote. Teach mode
// explains them; it is never allowed to restate them.
const agentsDir = path.join(dir, 'agents');
const records = new Map();
try {
  for (const f of readdirSync(agentsDir)) {
    if (!f.endsWith('.final.json')) continue;
    for (const r of JSON.parse(readFileSync(path.join(agentsDir, f), 'utf8'))) records.set(r.findingId, r);
  }
} catch {
  console.error(`${agentsDir} holds no *.final.json — run verify-findings.mjs first`);
  process.exit(1);
}

const FROZEN = ['file', 'line', 'tier', 'title', 'status'];
const checked = [];
const rejected = [];
const unexplained = [];
let eligible = 0;
let taught = 0;

const reject = (findingId, reason) => {
  checked.push({ findingId, verdict: 'rejected', reason });
  rejected.push({ findingId, reason });
};

for (const c of consolidated) {
  const id = String(c.findingId ?? '');
  const record = records.get(c.findingId);
  if (!record) {
    reject(id, 'no verify-findings.mjs record for this findingId — teach mode cannot explain an unverified finding');
    continue;
  }
  const moved = FROZEN.filter((k) => String(c[k] ?? '') !== String(record[k] ?? ''));
  if (moved.length) {
    reject(id, `finding record edited after verification: ${moved.join(', ')} changed`);
    continue;
  }

  const underBar = scorePct(record.score, maxScore) < below;
  if (underBar) eligible++;

  if (!looksTaught(c.comment)) {
    checked.push({ findingId: id, verdict: 'plain' });
    if (underBar) unexplained.push(id);
    continue;
  }
  const verdict = checkTaughtBody(c.comment, record);
  if (!verdict.ok) {
    reject(id, verdict.reason);
    continue;
  }
  checked.push({ findingId: id, verdict: 'accepted' });
  if (underBar && isTaught(c.comment)) taught++;
}

console.log(JSON.stringify({ below, maxScore, eligible, taught, unexplained, ok: rejected.length === 0, checked, rejected }));
process.exit(rejected.length ? 1 : 0);
