import type { GhRunner } from './gh.js';
import { ghJson } from './gh.js';
import { capTitle, tidyComment } from './format.js';
import { fixProse } from './prose.js';
import { SUMMARY_MARKER, tierIcon, tierLabel } from './summary.js';
import type { ExistingComment, VerifiedFinding } from './types.js';

const FOOTER = (id: string) => `<sub>heimdall · finding \`${id}\` · advisory, human decides</sub>`;

/** The single chokepoint every inline comment body passes through. */
export function inlineBody(f: VerifiedFinding, comment: string): string {
  const tags = f.mergedAgents.length > 1 ? ` _[${f.mergedAgents.join(' + ')}]_` : '';
  // fixProse is the idempotent last gate — the consolidator already fixed and
  // declared this text; this guarantees nothing unproven can be posted.
  return fixProse(
    `**${tierIcon(f.tier)} ${tierLabel(f.tier)} — ${capTitle(f.title)}**${tags}\n\n${tidyComment(comment)}\n\n${FOOTER(f.findingId)}`,
  ).text;
}

/** Same bucketing as findingId: prevents re-flagging a line we already commented on. */
export function lineBucket(file: string, line: number): string {
  return `${file}:${Math.floor(line / 5)}`;
}

export async function whoami(gh: GhRunner): Promise<string> {
  return (await gh(['api', 'user', '--jq', '.login'])).trim();
}

/** Prior inline comments left by this same gh user under Heimdall's footer. */
export async function heimdallPriorBuckets(
  gh: GhRunner,
  repo: string,
  pr: number,
  me: string,
): Promise<Set<string>> {
  const rcs = await ghJson<
    { body: string; path: string; line: number | null; user: { login: string } | null }[]
  >(gh, ['api', `repos/${repo}/pulls/${pr}/comments`, '--paginate']).catch(() => []);
  const buckets = new Set<string>();
  for (const c of rcs) {
    if (c.user?.login === me && c.body.includes('finding `') && c.line != null) {
      buckets.add(lineBucket(c.path, c.line));
    }
  }
  return buckets;
}

/** A human's unresolved inline thread touching the same neighborhood — reply target. */
export function humanThreadFor(
  f: VerifiedFinding,
  comments: ExistingComment[],
  me: string,
  threadsTrusted: boolean,
): number | null {
  let best: { id: number; distance: number } | null = null;
  for (const c of comments) {
    if (!c.file || c.line == null || c.commentId == null) continue;
    if (c.author === me) continue;
    if (threadsTrusted && c.resolved) continue; // a human already dismissed it
    if (c.file !== f.file) continue;
    const distance = Math.abs(c.line - f.line);
    if (distance > 3) continue;
    if (!best || distance < best.distance) best = { id: c.commentId, distance };
  }
  return best?.id ?? null;
}

export interface PostResult {
  reviewSubmitted: boolean;
  summaryUrl?: string;
  inlineUrls: string[];
  threadReplies: string[];
  skippedDuplicates: string[];
  updatedSummary: boolean;
}

export async function findSummaryCommentId(gh: GhRunner, repo: string, pr: number): Promise<number | null> {
  const list = await ghJson<{ id: number; body: string | null }[]>(
    gh,
    ['api', `repos/${repo}/issues/${pr}/comments`, '--paginate'],
  ).catch(() => []);
  const hit = list.filter((c) => (c.body ?? '').includes(SUMMARY_MARKER)).pop();
  return hit?.id ?? null;
}

export async function postSummary(
  gh: GhRunner,
  repo: string,
  pr: number,
  body: string,
): Promise<{ url: string; updated: boolean }> {
  const existingId = await findSummaryCommentId(gh, repo, pr);
  if (existingId) {
    const data = await ghJson<{ html_url: string }>(gh, [
      'api',
      '-X',
      'PATCH',
      `repos/${repo}/issues/comments/${existingId}`,
      '-f',
      `body=${body}`,
    ]);
    return { url: data.html_url, updated: true };
  }
  const data = await ghJson<{ html_url: string }>(gh, [
    'api',
    '-X',
    'POST',
    `repos/${repo}/issues/${pr}/comments`,
    '-f',
    `body=${body}`,
  ]);
  return { url: data.html_url, updated: false };
}

/**
 * One formal review. `event=COMMENT` normally; `event=REQUEST_CHANGES` when a
 * blocker survived this run — the review asks for changes, it never approves.
 * An empty review still posts when requestChanges is set and the blockers all
 * landed as thread replies, so the gate never silently disappears.
 */
export async function postInlineReview(
  gh: GhRunner,
  repo: string,
  pr: number,
  commitSha: string,
  items: { path: string; line: number; body: string }[],
  requestChanges = false,
): Promise<{ submitted: boolean; inlineUrls: string[] }> {
  if (!items.length && !requestChanges) return { submitted: false, inlineUrls: [] };
  const n = `Heimdall left ${items.length} inline comment${items.length === 1 ? '' : 's'}`;
  const body = requestChanges
    ? `Heimdall requested changes — ${items.length ? `${n}; ` : 'blocking findings were raised; '}blockers must be resolved before merge. See the pinned summary comment for the full picture.`
    : `${n}. See the pinned summary comment for the full picture.`;
  const payload = JSON.stringify({
    commit_id: commitSha,
    event: requestChanges ? 'REQUEST_CHANGES' : 'COMMENT',
    body,
    comments: items.map((i) => ({ path: i.path, line: i.line, side: 'RIGHT', body: i.body })),
  });
  const out = await gh(
    ['api', '-X', 'POST', `repos/${repo}/pulls/${pr}/reviews`, '--input', '-'],
    { input: payload, allowFail: true },
  );
  if (!out) return { submitted: false, inlineUrls: [] };
  try {
    const data = JSON.parse(out) as { html_url?: string; user?: { html_url?: string } };
    const base = data.user?.html_url ?? '';
    return {
      submitted: true,
      inlineUrls: items.map((_, i) => (data.html_url ? `${data.html_url}#discussion-${i}` : base)),
    };
  } catch {
    return { submitted: false, inlineUrls: [] };
  }
}

/** Reply inside an existing human review thread — REST replies endpoint. */
export async function replyInThread(
  gh: GhRunner,
  repo: string,
  pr: number,
  commentId: number,
  body: string,
): Promise<string | null> {
  const out = await gh(
    ['api', '-X', 'POST', `repos/${repo}/pulls/${pr}/comments/${commentId}/replies`, '-f', `body=${body}`],
    { allowFail: true },
  );
  if (!out) return null;
  try {
    const data = JSON.parse(out) as { html_url: string };
    return data.html_url;
  } catch {
    return null;
  }
}
