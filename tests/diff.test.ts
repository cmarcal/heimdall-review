import { describe, it, expect } from 'vitest';
import { parsePatch, applyCaps } from '../src/lib/diff.js';

const newFile = [
  'diff --git a/a.js b/a.js',
  'new file mode 100644',
  'index 0000000..1111111 100644',
  '--- /dev/null',
  '+++ b/a.js',
  '@@ -0,0 +1,3 @@',
  '+one',
  '+two',
  '+three',
  '',
].join('\n');

const modified = [
  'diff --git a/b.js b/b.js',
  'index aaa..bbb 100644',
  '--- a/b.js',
  '+++ b/b.js',
  '@@ -1,3 +1,2 @@',
  ' keep',
  '-gone',
  ' stay',
].join('\n');

describe('parsePatch', () => {
  it('counts added lines with correct head line numbers', () => {
    const files = parsePatch(newFile);
    expect(files).toHaveLength(1);
    const f = files[0]!;
    expect(f.path).toBe('a.js');
    expect(f.status).toBe('added');
    expect(f.added).toBe(3);
    expect(f.removed).toBe(0);
    expect(f.changedLines).toEqual([1, 2, 3]);
  });

  it('does not count +++/---/index headers as changes', () => {
    const files = parsePatch(newFile);
    const f = files[0]!;
    // exactly 3 additions, headers excluded
    expect(f.added).toBe(3);
  });

  it('handles a modified file with context and a removal', () => {
    const f = parsePatch(modified)[0]!;
    expect(f.status).toBe('modified');
    expect(f.removed).toBe(1);
    expect(f.added).toBe(0);
    expect(f.changedLines).toEqual([]);
  });
});

describe('applyCaps', () => {
  const mk = (path: string, added: number, removed = 0) => ({
    path,
    status: 'added' as const,
    patch: '',
    changedLines: [],
    added,
    removed,
  });

  it('skips files matching skip globs', () => {
    const r = applyCaps([mk('dist/bundle.js', 5)], {
      skip: ['**/dist/**'],
      maxFileChangedLines: 100,
      maxTotalChangedLines: 100,
    });
    expect(r.review).toHaveLength(0);
    expect(r.skipped[0]?.reason).toBe('skip pattern');
  });

  it('skips a file over the per-file cap', () => {
    const r = applyCaps([mk('big.js', 500)], {
      skip: [],
      maxFileChangedLines: 100,
      maxTotalChangedLines: 1000,
    });
    expect(r.skipped[0]?.reason).toMatch(/per-file cap/);
  });

  it('keeps the riskiest files under the total cap and declares the rest', () => {
    const r = applyCaps([mk('small.js', 10), mk('huge.js', 90), mk('mid.js', 40)], {
      skip: [],
      maxFileChangedLines: 200,
      maxTotalChangedLines: 100,
    });
    // huge(90) kept, mid(40) would exceed 100 -> skipped, small(10) fits after huge? total=90 then small=100 ok
    expect(r.review.map((f) => f.path)).toEqual(['huge.js', 'small.js']);
    expect(r.skipped.map((s) => s.file)).toEqual(['mid.js']);
  });
});
