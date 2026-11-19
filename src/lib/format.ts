/**
 * Formatting the HARNESS enforces — the prompts only request it.
 * Whatever leaves this module is what lands on GitHub: quoted code becomes a
 * fenced block, prose is capped in words, titles are capped in characters.
 */

/** Prose word budget for one inline comment. Fenced evidence is free. */
export const MAX_INLINE_WORDS = 80;
/** The title renders as a bold header — it must stay a single line. */
export const MAX_TITLE_CHARS = 90;

const FENCE = /^\s*```/;
/** Markdown's own code convention: a tab or 4+ leading spaces is not prose. */
const CODE_LINE = /^\t[ \t]*\S|^ {4,}\S/;

/**
 * Raw code that leaked into prose (the model obeying "quote the exact line"
 * by pasting tab-indented snippets mid-sentence) becomes its own fenced
 * block, dedented. Existing fences are passed through untouched.
 */
export function fenceCodeRuns(text: string): string {
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  const out: string[] = [];
  const endPara = () => {
    if (out.length && out[out.length - 1] !== '') out.push('');
  };
  let inFence = false;
  let i = 0;
  while (i < lines.length) {
    const line = lines[i] as string;
    if (FENCE.test(line)) {
      const opening = !inFence;
      inFence = !inFence;
      if (opening) endPara();
      out.push(line.trim());
      i++;
      continue;
    }
    if (!inFence && CODE_LINE.test(line)) {
      const run: string[] = [];
      while (i < lines.length && !FENCE.test(lines[i] as string) && CODE_LINE.test(lines[i] as string))
        run.push(lines[i++] as string);
      const indent = Math.min(...run.map((l) => (l.match(/^[\t ]*/)?.[0].length ?? 0)));
      endPara();
      out.push('```', ...run.map((l) => l.slice(indent)), '```', '');
      continue;
    }
    out.push(line.trimEnd());
    i++;
  }
  return out.join('\n');
}

/** Words of prose only — quoted evidence in fenced blocks is not counted. */
export function proseWords(text: string): number {
  return ((text.replace(/```[\s\S]*?```/g, ' ').match(/\S+/g) ?? []).length);
}

/** Collapse blank-line noise and raw code runs. Idempotent. */
export function tidyComment(text: string): string {
  return fenceCodeRuns(text).replace(/\n{3,}/g, '\n\n').trim();
}

/** One-line header text: fold whitespace, cut at a word boundary. */
export function capTitle(title: string): string {
  const t = title.replace(/\s+/g, ' ').trim();
  if (t.length <= MAX_TITLE_CHARS) return t;
  const cut = t.slice(0, MAX_TITLE_CHARS);
  const at = cut.lastIndexOf(' ');
  return `${(at > 40 ? cut.slice(0, at) : cut).replace(/[,;:.!?—-]+$/, '')}…`;
}
