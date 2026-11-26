import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describeScoring } from '../src/doctor.js';
import type { ScoringConfig } from '../src/lib/scoring.js';
import { CONFIG_DIR } from '../src/lib/paths.js';

/**
 * `doctor --scoring` is what a human reads to find out how the harness grades, so
 * the teach bar belongs in that same output next to the weights and the tier
 * cutoffs: it is calibrated against them, and a bar nobody can see is a bar nobody
 * trusts.
 */
const cfg: ScoringConfig = JSON.parse(readFileSync(join(CONFIG_DIR, 'scoring.json'), 'utf8'));

function capture(run: () => void): string {
  const write = process.stdout.write.bind(process.stdout);
  let out = '';
  process.stdout.write = ((chunk: string | Uint8Array) => {
    out += String(chunk);
    return true;
  }) as typeof process.stdout.write;
  try {
    run();
  } finally {
    process.stdout.write = write;
  }
  return out;
}

describe('doctor --scoring', () => {
  it('prints the weights and every tier cutoff', () => {
    const out = capture(describeScoring);
    expect(out).toMatch(/scoring weights:/);
    for (const tier of cfg.tiers) expect(out).toContain(`score >= ${tier.min}`);
  });

  it('prints the teach bar as a normalized value, not a raw score', () => {
    const out = capture(describeScoring);
    expect(out).toContain(`${cfg.teach.below}/${cfg.teach.maxScore}`);
  });

  it('names the flag the bar belongs to, after the tier cutoffs', () => {
    const out = capture(describeScoring);
    expect(out).toMatch(/--teach/);
    expect(out.indexOf('teach')).toBeGreaterThan(out.indexOf('nit'));
  });

  it('says the bar is about explaining prose, so nobody reads it as a fifth tier', () => {
    const out = capture(describeScoring);
    expect(out).toMatch(/explains/);
  });
});
