/**
 * Teach mode, in one place, for the skill's scripts. Compact mirror of
 * src/agents/teach.ts and src/lib/format.ts (canonical): the CLI renders a
 * taught body itself and gates what it rendered, while in the skill the
 * orchestrating agent writes the body — so the budget and the shape live here
 * where check-taught.mjs can enforce them and post-review.mjs can grade a
 * taught comment against the taught budget instead of the terse one.
 */
export const TEACH_LABELS = ['What the code does', 'Why it breaks', 'How to fix it'];
export const MAX_INLINE_WORDS = 80;
export const MAX_TAUGHT_WORDS = 180;

/** Fenced code is free. Same rule as proseWords() in src/lib/format.ts. */
export function proseWords(text) {
  return (String(text ?? '').replace(/```[\s\S]*?```/g, ' ').match(/\S+/g) ?? []).length;
}

/** All three labels: this body explains itself. */
export function isTaught(comment) {
  return TEACH_LABELS.every((label) => String(comment ?? '').includes(`**${label}:**`));
}

/** Any one label: whoever wrote this meant it as a taught body, so gate it. */
export function looksTaught(comment) {
  return TEACH_LABELS.some((label) => String(comment ?? '').includes(`**${label}:**`));
}

/** The prose budget this comment gets. */
export function wordCapFor(comment) {
  return isTaught(comment) ? MAX_TAUGHT_WORDS : MAX_INLINE_WORDS;
}

/**
 * The taught-body gate: the evidence quote verbatim inside a fence, all three
 * labels, and the prose inside the taught budget. Read-only — it reports, it
 * never rewrites.
 *
 * @param {string} comment
 * @param {{ verifiedEvidence?: string }} record the *.final.json record
 */
export function checkTaughtBody(comment, record) {
  const body = String(comment ?? '');
  const quote = String(record?.verifiedEvidence ?? '');
  if (!quote.trim()) return { ok: false, reason: 'no evidence quote to fence' };
  const fenced = [...body.matchAll(/```[^\n]*\n([\s\S]*?)```/g)].map((m) => m[1] ?? '');
  if (!fenced.some((block) => block.includes(quote)))
    return { ok: false, reason: 'evidence quote is not verbatim inside a fenced block' };
  for (const label of TEACH_LABELS)
    if (!body.includes(`**${label}:**`)) return { ok: false, reason: `missing label: ${label}` };
  const words = proseWords(body);
  if (words > MAX_TAUGHT_WORDS) return { ok: false, reason: `${words} prose words (cap ${MAX_TAUGHT_WORDS})` };
  return { ok: true };
}

/** A score as a percentage of the maximum — the number the teach bar compares. */
export function scorePct(score, maxScore) {
  const max = Number(maxScore) > 0 ? Number(maxScore) : 30;
  return Math.round((Number(score) / max) * 100);
}
