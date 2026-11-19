#!/usr/bin/env node
/**
 * The harness gate for the heimdall-review skill — the step the orchestrating
 * agent is NOT allowed to do with its own judgment. Re-reads the fetched head
 * files, deletes any finding whose verifiedEvidence quote is not literally in
 * the code, then scores survivors with the private map and assigns stable
 * findingIds. Same rules as src/agents/base.ts + src/lib/scoring.ts, so skill
 * runs and CLI runs interoperate (shared self-dedupe + calibration dataset).
 *
 * usage: verify-findings.mjs --dir <workdir> --agent <name>
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { realpathSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const [,, ...argv] = process.argv;
const arg = (name) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : undefined;
};
const dir = arg('dir');
const agent = arg('agent');
if (!dir || !agent) {
  console.error('usage: verify-findings.mjs --dir <workdir> --agent <name>');
  process.exit(1);
}

const ROOT = path.resolve(path.dirname(realpathSync(fileURLToPath(import.meta.url))), '..', '..', '..');
const scoring = JSON.parse(readFileSync(path.join(ROOT, 'config', 'scoring.json'), 'utf8'));

const candidatesPath = path.join(dir, 'agents', `${agent}.candidates.json`);
const verifiedPath = path.join(dir, 'agents', `${agent}.verified.json`);
if (!existsSync(verifiedPath)) {
  console.log(JSON.stringify({ agent, kept: 0, question: 0, dropped: 0, droppedQuote: 0, note: 'no verified file — nothing ran or no candidates' }));
  process.exit(0);
}

const verified = JSON.parse(readFileSync(verifiedPath, 'utf8'));
if (!Array.isArray(verified)) {
  console.error(`${verifiedPath} is not a JSON array`);
  process.exit(1);
}

const contentCache = new Map();
function headContent(file) {
  if (contentCache.has(file)) return contentCache.get(file);
  let content = '';
  try {
    content = readFileSync(path.join(dir, 'files', file), 'utf8');
  } catch {
    content = '';
  }
  contentCache.set(file, content);
  return content;
}

const bucket = (line) => Math.floor(line / 5);
const findingId = (file, line) =>
  createHash('sha1').update(`${file}:${bucket(line)}:${agent}`).digest('hex').slice(0, 12);

const order = { blocker: 4, major: 3, minor: 2, nit: 1 };
const tierOf = (score) => {
  for (const t of [...scoring.tiers].sort((a, b) => b.min - a.min)) if (score >= t.min) return t;
  return [...scoring.tiers].sort((a, b) => b.min - a.min).at(-1);
};
const scoreOf = (f) =>
  Math.round(f.impact * scoring.weights.impact + f.certainty * scoring.weights.certainty + f.blastRadius * scoring.weights.blastRadius);

// Mirror of src/lib/scoring.ts scoreAndTier(): a pass-2 `question` is a concern
// the verifier could NOT confirm, so clamp its certainty and cap its public
// tier — an unconfirmed finding is never a Major. Records keep the finder's
// original sub-scores for calibration.
const QUESTION = scoring.question ?? { certaintyCap: 3, maxTier: 'minor' };
function scoreAndTier(f, status) {
  const sub =
    status === 'question' ? { ...f, certainty: Math.min(f.certainty, QUESTION.certaintyCap ?? 3) } : f;
  const score = scoreOf(sub);
  let tier = tierOf(score).id;
  const max = status === 'question' ? QUESTION.maxTier : undefined;
  if (max && order[tier] > order[max]) tier = max;
  return { score, tier };
}

let dropped = 0;
let droppedQuote = 0;
let question = 0;
let clamped = 0;
const survivors = [];

for (const v of verified) {
  if (v.status === 'drop') { dropped++; continue; }
  const quote = typeof v.verifiedEvidence === 'string' ? v.verifiedEvidence : '';
  if (!quote) { dropped++; continue; }
  const content = headContent(String(v.file));
  if (!content || !content.includes(quote)) {
    dropped++;
    droppedQuote++;
    continue;
  }
  if (v.status !== 'keep' && v.status !== 'question') { dropped++; continue; }
  const { score, tier } = scoreAndTier(v, v.status);
  if (v.status === 'question') {
    question++;
    const rawTier = tierOf(scoreOf(v)).id;
    if (order[rawTier] > order[tier]) clamped++;
  }
  survivors.push({
    findingId: findingId(String(v.file), Number(v.line)),
    agent,
    mergedAgents: [agent],
    file: String(v.file),
    line: Number(v.line),
    title: String(v.title),
    verifiedEvidence: quote,
    why: String(v.why),
    suggestion: String(v.suggestion),
    status: v.status,
    impact: v.impact, certainty: v.certainty, blastRadius: v.blastRadius,
    score,
    tier,
  });
}

survivors.sort((a, b) => order[b.tier] - order[a.tier] || b.score - a.score);
writeFileSync(path.join(dir, 'agents', `${agent}.final.json`), JSON.stringify(survivors, null, 2));

console.log(JSON.stringify({
  agent,
  kept: survivors.length,
  question,
  clamped,
  dropped,
  droppedQuote,
  hiddenScores: survivors.map((s) => `${s.file}:${s.line} → ${s.score} (${s.tier}) [i${s.impact} c${s.certainty} b${s.blastRadius}]`),
}));
