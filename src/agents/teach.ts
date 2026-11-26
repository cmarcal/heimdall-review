import { completeJson } from '../llm/json.js';
import { taughtFieldsSchema, type TaughtFields } from '../lib/finding.js';
import { MAX_TAUGHT_WORDS, proseWords, tidyComment } from '../lib/format.js';
import { describeFixes, fixProse } from '../lib/prose.js';
import { shouldTeach, type ScoringConfig } from '../lib/scoring.js';
import { loadPrompt } from './prompt.js';
import type { ConsolidatedFinding } from './consolidator.js';
import type { LlmForRole } from '../llm/types.js';
import type { ReviewContext, VerifiedFinding } from '../lib/types.js';
import { truncate } from '../lib/util.js';

/**
 * Teach mode: a finding that scored LOW is the one a terse comment helps least.
 * This pass runs AFTER pass 1, the pass-2 verifier, dedupe and the consolidator,
 * so every one of them kept reading the same terse finding it reads without the
 * flag — verification is untouched. Only the published prose changes.
 *
 * The shape is fixed and the harness checks it: three labeled parts around the
 * verbatim evidence fence. The model supplies the three sentences and nothing
 * else — never the tier, the score or the quote. A taught body that fails the
 * gate keeps the terse comment, and the log says so.
 */
export const TEACH_LABELS = ['What the code does', 'Why it breaks', 'How to fix it'] as const;

export interface TeachOptions {
  /** scoring map with this run's teach threshold already resolved */
  scoring: ScoringConfig;
  /** cap on the head content packed for one finding */
  maxContentChars?: number;
}

/** A taught body is one that carries all three labels. */
export function isTaught(comment: string): boolean {
  return TEACH_LABELS.every((label) => comment.includes(`**${label}:**`));
}

/**
 * Deterministic render of the three parts around the evidence fence. Labels and
 * the quote come from the finding; the model only fills the sentences. Parts are
 * separate paragraphs because GitHub joins a single line break.
 */
export function renderTaughtBody(f: VerifiedFinding, fields: TaughtFields): string {
  const lead = f.status === 'question' ? `Question: ${f.title}` : f.title;
  const [what, why, how] = TEACH_LABELS;
  const parts: string[] = [
    lead,
    '',
    '```',
    f.verifiedEvidence,
    '```',
    '',
    `**${what}:** ${fields.what}`,
    '',
    `**${why}:** ${fields.why}`,
    '',
    `**${how}:** ${fields.how}`,
  ];
  if (fields.tryThis) parts.push('', '**Try this:**', '', '```', fields.tryThis, '```');
  return parts.join('\n');
}

/**
 * The taught-body gate. The quote is re-checked verbatim inside a fence, the
 * three labels must be there, and the prose budget is the taught one: 180
 * words, not the 80 a terse comment gets.
 */
export function checkTaught(
  body: string,
  f: VerifiedFinding,
): { ok: true } | { ok: false; reason: string } {
  const quote = f.verifiedEvidence.trim();
  if (!quote) return { ok: false, reason: 'no evidence quote to fence' };
  const fenced = [...body.matchAll(/```[^\n]*\n([\s\S]*?)```/g)].map((m) => m[1] ?? '');
  if (!fenced.some((block) => block.includes(f.verifiedEvidence)))
    return { ok: false, reason: 'evidence quote is not verbatim inside a fenced block' };
  for (const label of TEACH_LABELS)
    if (!body.includes(`**${label}:**`)) return { ok: false, reason: `missing label: ${label}` };
  const words = proseWords(body);
  if (words > MAX_TAUGHT_WORDS) return { ok: false, reason: `${words} prose words (cap ${MAX_TAUGHT_WORDS})` };
  return { ok: true };
}

/** What the pass did, for the run report, the summary and the artifact. */
export function teachStats(
  before: ConsolidatedFinding[],
  after: ConsolidatedFinding[],
  scoring: ScoringConfig,
): { taught: number; fallback: number } {
  const terse = new Map(before.map((c) => [c.finding.findingId, c.comment]));
  let taught = 0;
  let fallback = 0;
  for (const c of after) {
    if (!shouldTeach(c.finding, scoring)) continue;
    const didTeach = isTaught(c.comment) && terse.get(c.finding.findingId) !== c.comment;
    if (didTeach) taught++;
    else fallback++;
  }
  return { taught, fallback };
}

/**
 * Explain the low-scoring findings. Never throws: a teacher that fails, rambles
 * or loses the quote leaves the consolidated comment in place and declares it.
 */
export async function teach(
  findings: ConsolidatedFinding[],
  ctx: ReviewContext,
  llm: LlmForRole,
  opts: TeachOptions,
  log: (msg: string) => void,
): Promise<ConsolidatedFinding[]> {
  const system = `${loadPrompt('style')}\n\n---\n\n${loadPrompt('teach')}`;
  const out = [...findings];
  for (let i = 0; i < out.length; i++) {
    const entry = out[i];
    if (!entry || !shouldTeach(entry.finding, opts.scoring)) continue;
    const taughtBody = await teachOne(entry, ctx, llm, opts, system, log);
    if (taughtBody) out[i] = { finding: entry.finding, comment: taughtBody };
  }
  return out;
}

/**
 * One finding, one teacher call, one gate, one targeted rewrite. Returns the
 * body to ship, or null to keep the consolidated comment.
 */
async function teachOne(
  entry: ConsolidatedFinding,
  ctx: ReviewContext,
  llm: LlmForRole,
  opts: TeachOptions,
  system: string,
  log: (msg: string) => void,
): Promise<string | null> {
  const where = `${entry.finding.file}:${entry.finding.line}`;
  const user = teacherInput(entry, ctx, opts);
  const first = await askTeacher(system, user, llm, where, log);
  if (!first) return null;

  let body = tidyComment(renderTaughtBody(entry.finding, first));
  let verdict = checkTaught(body, entry.finding);
  if (verdict.ok) return declareProse(body, entry.finding, where, log);

  log(`teacher for ${where} broke the contract (${verdict.reason}) — one rewrite`);
  const retry = await askTeacher(system, `${user}\n\n---\n${rewriteNote(verdict.reason, entry.finding)}`, llm, where, log);
  if (!retry) return null;
  body = tidyComment(renderTaughtBody(entry.finding, retry));
  verdict = checkTaught(body, entry.finding);
  if (!verdict.ok) {
    log(`teacher for ${where} still fails the contract (${verdict.reason}) — terse comment kept`);
    return null;
  }
  return declareProse(body, entry.finding, where, log);
}

function rewriteNote(reason: string, f: VerifiedFinding): string {
  return (
    `Your previous reply failed the contract: ${reason}. Reply again with the same JSON keys, fixing exactly that. ` +
    `The three parts stay <=${MAX_TAUGHT_WORDS} prose words in total, and ${JSON.stringify(f.verifiedEvidence)} ` +
    'is fenced by the harness — do not restate it in your text.'
  );
}

function teacherInput(entry: ConsolidatedFinding, ctx: ReviewContext, opts: TeachOptions): string {
  const f = entry.finding;
  const content = ctx.files.find((x) => x.path === f.file)?.content ?? '';
  return JSON.stringify(
    {
      finding: {
        file: f.file,
        line: f.line,
        title: f.title,
        status: f.status,
        verifiedEvidence: f.verifiedEvidence,
        why: f.why,
        suggestion: f.suggestion,
      },
      comment: entry.comment,
      headContent: content ? truncate(content, opts.maxContentChars ?? 12_000) : '(unavailable)',
    },
    null,
    2,
  );
}

async function askTeacher(
  system: string,
  user: string,
  llm: LlmForRole,
  where: string,
  log: (msg: string) => void,
): Promise<TaughtFields | null> {
  try {
    const res = await completeJson(llm, 'teach', system, user, taughtFieldsSchema);
    return res.data;
  } catch (err) {
    log(`teacher failed for ${where} (${(err as Error).message.slice(0, 120)}) — terse comment kept`);
    return null;
  }
}

/** The taught prose goes through the same declared spelling gate as any comment. */
function declareProse(
  body: string,
  f: VerifiedFinding,
  where: string,
  log: (msg: string) => void,
): string {
  const prose = fixProse(body);
  if (prose.fixes.length) log(`prose gate: ${where} fixed ${describeFixes(prose.fixes)}`);
  return prose.text;
}
