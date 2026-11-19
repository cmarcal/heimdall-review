import { describe, it, expect } from 'vitest';
import { capTitle, fenceCodeRuns, MAX_TITLE_CHARS, proseWords, tidyComment } from '../src/lib/format.js';

describe('fenceCodeRuns', () => {
  it('fences a tab-indented snippet pasted into a paragraph (PR #617 shape)', () => {
    const raw =
      'GetJobType fails right here —\n' +
      '\t\treturn fmt.Errorf(\n' +
      '\t\t\t"unknown event type [%s]",\n' +
      'and with the processor gone, the row is never retried.';
    const out = fenceCodeRuns(raw);
    expect(out).toBe(
      'GetJobType fails right here —\n\n```\nreturn fmt.Errorf(\n\t"unknown event type [%s]",\n```\n\nand with the processor gone, the row is never retried.',
    );
    expect(out).not.toMatch(/\n\t.*\n[a-z]/); // no tab-indented prose seam
  });

  it('leaves existing fenced blocks untouched', () => {
    const raw = 'see:\n\n```go\nfunc main() {\n\treturn\n}\n```\n\ndone';
    expect(fenceCodeRuns(raw)).toBe(raw);
  });

  it('treats 4-space indentation as code too', () => {
    expect(fenceCodeRuns('before\n    x = do();\nafter')).toContain('```\nx = do();\n```');
  });
});

describe('proseWords', () => {
  it('counts prose but not fenced evidence', () => {
    const text = `one two three\n\n\`\`\`\n${'a b c '.repeat(50)}\n\`\`\`\n\nfour five`;
    expect(proseWords(text)).toBe(5);
  });
});

describe('tidyComment', () => {
  it('collapses blank-line runs and is idempotent', () => {
    const once = tidyComment('a\n\n\n\nb\n\tcode();\nc');
    expect(once).toBe('a\n\nb\n\n```\ncode();\n```\n\nc');
    expect(tidyComment(once)).toBe(once);
  });
});

describe('capTitle', () => {
  it('keeps short titles as-is', () => {
    expect(capTitle('Dead exported sentinel error')).toBe('Dead exported sentinel error');
  });

  it('cuts long titles at a word boundary under the cap', () => {
    const long =
      'After removing the backfill, does the 0066 column comment (and the models.go sqlc regenerates from it) now contradict this updated comment about NULL identifier_type?';
    const capped = capTitle(long);
    expect(capped.length).toBeLessThanOrEqual(MAX_TITLE_CHARS);
    expect(capped.endsWith('…')).toBe(true);
    expect(capped).not.toContain('  ');
  });

  it('folds embedded newlines into one line', () => {
    expect(capTitle('a\nb\t c')).toBe('a b c');
  });
});
