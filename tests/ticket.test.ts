import { describe, it, expect } from 'vitest';
import { parseLinkedIssue } from '../src/lib/ticket.js';

describe('parseLinkedIssue', () => {
  it('flag wins over everything', () => {
    expect(parseLinkedIssue({ prBody: 'Closes #5', branch: 'feat/9-x', flag: 77 })).toEqual({ number: 77, source: 'flag' });
  });

  it('parses closing keywords from the body', () => {
    for (const body of ['Closes #12', 'Fixes #12', 'Resolves #12', 'refs #12', 'Fixes acme/repo#12']) {
      expect(parseLinkedIssue({ prBody: body, branch: 'main' }).number).toBe(12);
    }
  });

  it('parses a full issue URL', () => {
    const r = parseLinkedIssue({ prBody: 'Closes https://github.com/acme/repo/issues/42', branch: 'main' });
    expect(r).toEqual({ number: 42, source: 'body' });
  });

  it('falls back to the branch number only when the body has no link', () => {
    expect(parseLinkedIssue({ prBody: 'no link here', branch: 'feat/34-add-thing' })).toEqual({ number: 34, source: 'branch' });
  });

  it('resolves from commit closing keywords when the body has no link', () => {
    const r = parseLinkedIssue({
      prBody: 'no link here',
      branch: 'feature/no-number',
      commits: ['wip', 'fix: retry on timeout, closes #42'],
    });
    expect(r).toEqual({ number: 42, source: 'commit' });
  });

  it('body outranks commits, commits outrank the branch', () => {
    const bodyWins = parseLinkedIssue({ prBody: 'Closes #5', branch: 'feat/9-x', commits: ['Fixes #77'] });
    expect(bodyWins).toEqual({ number: 5, source: 'body' });
    const commitWins = parseLinkedIssue({ prBody: 'nope', branch: 'feat/9-x', commits: ['Fixes #77'] });
    expect(commitWins).toEqual({ number: 77, source: 'commit' });
  });

  it('a bare #N in a commit is NOT a link — only closing keywords count', () => {
    const r = parseLinkedIssue({ prBody: 'nope', branch: 'feature/x', commits: ['tweaks (#99)'] });
    expect(r).toEqual({ number: null, source: 'none' });
  });

  it('returns none — a declared state, never a guess', () => {
    expect(parseLinkedIssue({ prBody: 'nothing', branch: 'feature/nothing' })).toEqual({ number: null, source: 'none' });
  });
});
