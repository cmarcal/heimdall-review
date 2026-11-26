import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  scoreOf,
  tierOf,
  findingId,
  scoreAndTier,
  scorePct,
  shouldTeach,
  teachScoringConfig,
  type ScoringConfig,
} from '../src/lib/scoring.js';
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

// Teach mode reads one number: the score as a percentage of the maximum, so a
// repo with different weights still gets the same 0-100 bar. Scores stay
// private — the percentage only ever decides whether a comment explains itself.
describe('teach threshold (normalized to 0-100)', () => {
  it('ships the teach block in the calibration file', () => {
    expect(cfg.teach).toMatchObject({ below: 60, maxScore: 30 });
  });

  it('normalizes a raw score against maxScore', () => {
    expect(scorePct(30, cfg)).toBe(100);
    expect(scorePct(18, cfg)).toBe(60);
    expect(scorePct(17, cfg)).toBe(57);
    expect(scorePct(0, cfg)).toBe(0);
  });

  it('honors a maxScore override', () => {
    const c: ScoringConfig = { ...cfg, teach: { ...cfg.teach, maxScore: 20 } };
    expect(scorePct(12, c)).toBe(60);
    expect(shouldTeach({ score: 12 }, c)).toBe(false);
    expect(shouldTeach({ score: 11 }, c)).toBe(true);
  });

  it('teaches strictly below the bar and never at it', () => {
    expect(shouldTeach({ score: 18 }, cfg)).toBe(false); // 60% — at the bar
    expect(shouldTeach({ score: 17 }, cfg)).toBe(true); // 57%
    expect(shouldTeach({ score: 24 }, cfg)).toBe(false); // a Blocker, 80%
  });

  it('falls back to 60 of 30 when the config carries no teach block', () => {
    const bare: ScoringConfig = { weights: cfg.weights, tiers: cfg.tiers };
    expect(scorePct(18, bare)).toBe(60);
    expect(shouldTeach({ score: 18 }, bare)).toBe(false);
    expect(shouldTeach({ score: 17 }, bare)).toBe(true);
  });

  it('never divides by a zero or missing maxScore', () => {
    expect(scorePct(12, { ...cfg, teach: { below: 60, maxScore: 0 } })).toBe(40);
  });

  it('overlays a run threshold on the shipped config', () => {
    expect(teachScoringConfig(cfg).teach).toMatchObject({ below: 60, maxScore: 30 });
    expect(teachScoringConfig(cfg, { below: 45 }).teach?.below).toBe(45);
    expect(teachScoringConfig(cfg, { below: 45 }).teach?.maxScore).toBe(30);
    expect(teachScoringConfig(cfg, { below: 45 }).tiers).toBe(cfg.tiers);
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
