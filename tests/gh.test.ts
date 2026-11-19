import { describe, it, expect } from 'vitest';
import { createGh } from '../src/lib/gh.js';

/**
 * Regression guard for the publish hang: promisify(execFile) ignores `input`, so
 * a `gh api --input -` call left gh reading a stdin that was never written and
 * never EOF'd — the run blocked forever and posted nothing. Whatever backs the
 * runner, stdin must arrive and close. `sh` stands in for gh; the flag order
 * mirrors `gh api --input -`.
 */
const readStdin = 'read -r line; printf \'%s\' "got:$line"';

describe('createGh stdin plumbing', () => {
  it('delivers `input` to the command stdin', async () => {
    const out = await createGh('sh')(['-c', readStdin], { input: 'hello' });
    expect(out).toBe('got:hello');
  });

  it('closes stdin when there is no input, so a stdin-reading command cannot hang', async () => {
    const out = await createGh('sh')(['-c', readStdin]);
    expect(out).toBe('got:');
  });

  it('rejects with stderr when the command fails', async () => {
    await expect(createGh('sh')(['-c', 'echo boom >&2; exit 3'])).rejects.toThrow();
  });

  it('returns empty string on failure when allowFail is set', async () => {
    await expect(createGh('sh')(['-c', 'exit 1'], { allowFail: true })).resolves.toBe('');
  });

  it('posts the review payload through stdin instead of blocking on it', async () => {
    // gh reads `--input -` from stdin; echo the payload back to prove it landed.
    const gh = createGh('sh');
    const payload = JSON.stringify({ commit_id: 'abc', event: 'COMMENT', comments: [] });
    const out = await gh(['-c', 'cat'], { input: payload });
    expect(JSON.parse(out)).toMatchObject({ event: 'COMMENT', commit_id: 'abc' });
  });
});
