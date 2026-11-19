/**
 * Ticket discovery, in priority order: explicit flag, closing keywords in the
 * PR body (Closes/Fixes/Resolves/Refs #N or full issue URL), the same closing
 * keywords in the commit messages (the author's per-change intent), branch
 * name (feat/123-foo). Never a guess beyond these rules — an unlinked ticket
 * is a declared state ("requirements unverified"), not a silent one.
 */
export type TicketSource = 'flag' | 'body' | 'commit' | 'branch' | 'none';

const CLOSING_RE =
  /\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?|ref[s]?)\b[^\d]{0,60}?(?:issues\/|#)\s*(\d+)/gi;

export function parseLinkedIssue(opts: {
  prBody: string;
  branch: string;
  /** commit message bodies — searched with the same closing-keyword rule */
  commits?: string[];
  flag?: number;
}): { number: number | null; source: TicketSource } {
  if (opts.flag && opts.flag > 0) return { number: opts.flag, source: 'flag' };

  const body = opts.prBody.matchAll(CLOSING_RE);
  for (const m of body) {
    const n = Number(m[1]);
    if (Number.isFinite(n) && n > 0) return { number: n, source: 'body' };
  }

  for (const message of opts.commits ?? []) {
    const m = message.matchAll(CLOSING_RE);
    for (const hit of m) {
      const n = Number(hit[1]);
      if (Number.isFinite(n) && n > 0) return { number: n, source: 'commit' };
    }
  }

  const branch = opts.branch.match(/(?:^|[/_-])(\d{1,6})(?:[-_]|$)/);
  const branchNum = branch?.[1] ? Number(branch[1]) : null;
  if (branchNum) return { number: branchNum, source: 'branch' };

  return { number: null, source: 'none' };
}
