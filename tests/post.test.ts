import { describe, it, expect } from 'vitest';
import { inlineBody, lineBucket, humanThreadFor, postInlineReview } from '../src/lib/post.js';
import { MAX_TITLE_CHARS } from '../src/lib/format.js';
import type { GhRunner } from '../src/lib/gh.js';
import type { ExistingComment, VerifiedFinding } from '../src/lib/types.js';

const f = (over: Partial<VerifiedFinding> = {}): VerifiedFinding => ({
  findingId: 'x', agent: 'security', mergedAgents: ['security'], file: 'a.js', line: 10,
  title: 't', verifiedEvidence: 'e', why: 'w', suggestion: 's', status: 'keep',
  impact: 5, certainty: 5, blastRadius: 5, score: 15, tier: 'minor', ...over,
});

describe('lineBucket', () => {
  it('buckets by 5 lines so small drift is the same target', () => {
    expect(lineBucket('a.js', 10)).toBe('a.js:2');
    expect(lineBucket('a.js', 12)).toBe('a.js:2');
    expect(lineBucket('a.js', 9)).toBe('a.js:1');
  });
});

describe('humanThreadFor', () => {
  const human = (over: Partial<ExistingComment>): ExistingComment => ({
    author: 'alice', body: 'hmm', file: 'a.js', line: 11, commentId: 101, resolved: false, ...over,
  });

  it('replies in an unresolved human thread near the finding', () => {
    expect(humanThreadFor(f(), [human({})], 'me', true)).toBe(101);
  });

  it('does NOT re-open a thread a human already dismissed', () => {
    expect(humanThreadFor(f(), [human({ resolved: true })], 'me', true)).toBeNull();
  });

  it('ignores my own prior comments', () => {
    expect(humanThreadFor(f(), [human({ author: 'me' })], 'me', true)).toBeNull();
  });

  it('ignores threads too far from the finding', () => {
    expect(humanThreadFor(f({ line: 10 }), [human({ line: 40 })], 'me', true)).toBeNull();
  });
});

describe('inlineBody', () => {
  it('caps the bold header at one bounded line', () => {
    const long = 'x'.repeat(40).replace(/x/g, 'word');
    const body = inlineBody(f({ title: long }), 'prose');
    const header = body.split('\n')[0]!;
    expect(header.length).toBeLessThanOrEqual(MAX_TITLE_CHARS + '** 🟡 Minor — '.length + 4);
  });

  it('fences raw code pasted into the comment body', () => {
    const body = inlineBody(f(), 'fails here —\n\t\treturn err\nand stops.');
    expect(body).toContain('```\nreturn err\n```');
  });

  it('prose gate: no wrong-spelling word survives into the posted body', () => {
    const body = inlineBody(f({ title: 'Cache never initialised' }), 'the cache behaviour must be initialised once — keep `initialised_count` as written.');
    expect(body).toContain('Cache never initialized');
    expect(body).toContain('behavior');
    expect(body).toContain('must be initialized');
    expect(body).toContain('`initialised_count`'); // the identifier is evidence, not prose
    expect(body).not.toMatch(/initialised(?!_count)/);
  });
});

describe('postInlineReview event', () => {
  const captureGh = (): { gh: GhRunner; payloads: any[] } => {
    const payloads: any[] = [];
    const gh: GhRunner = async (_args, opts) => {
      payloads.push(JSON.parse(opts?.input ?? '{}'));
      return JSON.stringify({ html_url: 'https://gh/pr/1#pullrequestreview-1', user: { html_url: 'u' } });
    };
    return { gh, payloads };
  };
  const items = [{ path: 'a.go', line: 3, body: 'b' }];

  it('posts COMMENT when no blocker escalated', async () => {
    const { gh, payloads } = captureGh();
    const res = await postInlineReview(gh, 'r', 1, 'sha', items);
    expect(payloads[0]).toMatchObject({ event: 'COMMENT' });
    expect(payloads[0].body).toMatch(/^Heimdall left 1 inline comment\./);
    expect(res.submitted).toBe(true);
  });

  it('escalates to REQUEST_CHANGES when a blocker was posted — never APPROVE', async () => {
    const { gh, payloads } = captureGh();
    const res = await postInlineReview(gh, 'r', 1, 'sha', items, true);
    expect(payloads[0]).toMatchObject({ event: 'REQUEST_CHANGES' });
    expect(payloads[0].body).toMatch(/requested changes/);
    expect(res.submitted).toBe(true);
    expect(res.inlineUrls.length).toBe(1);
  });

  it('still posts the gate when the blocker only landed as a thread reply', async () => {
    const { gh, payloads } = captureGh();
    const res = await postInlineReview(gh, 'r', 1, 'sha', [], true);
    expect(payloads[0]).toMatchObject({ event: 'REQUEST_CHANGES', comments: [] });
    expect(res).toMatchObject({ submitted: true, inlineUrls: [] }); // gate exists, no inline anchors
  });

  it('posts nothing at all with no items and no blocker', async () => {
    const { gh, payloads } = captureGh();
    expect(await postInlineReview(gh, 'r', 1, 'sha', [])).toEqual({ submitted: false, inlineUrls: [] });
    expect(payloads).toHaveLength(0);
  });
});
