import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { scoreOf, tierOf, findingId, scoreAndTier, type ScoringConfig } from '../src/lib/scoring.js';
import { CONFIG_DIR } from '../src/lib/paths.js';

const cfg: ScoringConfig = JSON.parse(readFileSync(join(CONFIG_DIR, 'scoring.json'), 'utf8'));

describe('scoring map (the private calibration)', () => {
  it('sums the three sub-scores with weights', () => {
    expect(scoreOf({ impact: 9, certainty: 8, blastRadius: 8 }, cfg)).toBe(25);
  });

  it('maps score totals to tiers at the boundaries', () => {
    expect(tierOf(25, cfg).id).toBe('blocker');
    expect(tierOf(24, cfg).id).toBe('blocker');
    expect(tierOf(23, cfg).id).toBe('major');
    expect(tierOf(16, cfg).id).toBe('major');
    expect(tierOf(15, cfg).id).toBe('minor');
    expect(tierOf(8, cfg).id).toBe('minor');
    expect(tierOf(7, cfg).id).toBe('nit');
    expect(tierOf(0, cfg).id).toBe('nit');
  });

  it('scores a keep exactly like the raw sub-scores', () => {
    const f = { impact: 8, certainty: 8, blastRadius: 6 };
    expect(scoreAndTier(f, 'keep', cfg)).toEqual({ score: 22, tier: 'major' });
  });

  it('clamps an unconfirmed question: certainty capped, tier at most minor', () => {
    // The end-user-native#8863 case: a Major-seeming speculation the verifier
    // could not confirm — raw 22 (major), certainty 8→3, tier clamped to minor.
    const f = { impact: 8, certainty: 8, blastRadius: 6 };
    expect(scoreAndTier(f, 'question', cfg)).toEqual({ score: 17, tier: 'minor' });
  });

  it('leaves a small question untouched when the clamp changes nothing', () => {
    const f = { impact: 3, certainty: 2, blastRadius: 2 };
    expect(scoreAndTier(f, 'question', cfg)).toEqual({ score: 7, tier: 'nit' });
  });
});

describe('findingId', () => {
  it('is stable and bucket-tolerant to small line moves', () => {
    const a = findingId('src/a.js', 10, 'security');
    expect(a).toBe(findingId('src/a.js', 10, 'security'));
    // 10 and 12 share a 5-line bucket, so a 2-line drift is the same finding
    expect(a).toBe(findingId('src/a.js', 12, 'security'));
  });

  it('differs across file and agent', () => {
    expect(findingId('src/a.js', 10, 'security')).not.toBe(findingId('src/b.js', 10, 'security'));
    expect(findingId('src/a.js', 10, 'security')).not.toBe(findingId('src/a.js', 10, 'performance'));
  });
});
