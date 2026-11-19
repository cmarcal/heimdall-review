import { describe, it, expect } from 'vitest';
import { describeFixes, fixProse, PROSE_FIXES } from '../src/lib/prose.js';

const fixed = (t: string) => fixProse(t).text;

describe('fixProse — wrong words become right words', () => {
  it('fixes en-GB -ise spellings the models wobble on', () => {
    expect(fixed('The cache is never initialised.')).toBe('The cache is never initialized.');
    expect(fixed('Initialised once, then optimised per request.')).toBe('Initialized once, then optimized per request.');
    expect(fixed('INITIALISED AT BOOT')).toBe('INITIALIZED AT BOOT');
    expect(fixed('It optimises and summarises the rows.')).toBe('It optimizes and summarizes the rows.');
  });

  it('fixes en-GB variants and common misspellings', () => {
    expect(fixed('The behaviour centres on a seperate reponse.')).toBe('The behavior centers on a separate response.');
    expect(fixed('you recieve the dependancy, it definately occured')).toBe('you receive the dependency, it definitely occurred');
    expect(fixed('the the row is writting itself')).toBe('the row is writing itself');
  });

  it('keeps correct US words and -ise traps untouched', () => {
    for (const w of ['raise', 'advise', 'revise', 'precise', 'exercise', 'analyses', 'promise', 'otherwise', 'wise'])
      expect(fixed(`it ${w} nothing`)).toBe(`it ${w} nothing`);
    expect(fixed('the the the')).toBe('the the'); // one fix per pass boundary, not a loop
  });

  it('never touches code: fences and backticks are evidence, not prose', () => {
    const src = 'The flag `cache.initialised` gates:\n\n```go\nif cfg.initialised && behaviour {\n\trecieve()\n}\n```\n\nso initialise it once.';
    const out = fixed(src);
    expect(out).toContain('`cache.initialised`');
    expect(out).toContain('if cfg.initialised && behaviour {\n\trecieve()');
    expect(out).toContain('so initialize it once.');
  });

  it('does not rewrite identifiers glued to the word', () => {
    expect(fixed('rename is_initialised and userInitialised flag')).toBe('rename is_initialised and userInitialised flag');
  });

  it('keeps grammatical doubled words', () => {
    expect(fixed('he had had enough, and that that clause lies')).toBe('he had had enough, and that that clause lies');
  });

  it('is idempotent and declares every fix', () => {
    const r = fixProse('initialised behaviour the the initialised');
    expect(fixProse(r.text).fixes).toEqual([]);
    const declared = Object.fromEntries(r.fixes.map((f) => [f.wrong, `${f.right}×${f.count}`]));
    expect(declared).toEqual({ initialised: 'initialized×2', behaviour: 'behavior×1', 'the the': 'the×1' });
    expect(describeFixes(r.fixes)).toContain('initialised→initialized×2');
  });
});
