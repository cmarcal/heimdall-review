import { describe, it, expect } from 'vitest';
import { mergeCloseFindings } from '../src/lib/dedupe.js';
import type { VerifiedFinding } from '../src/lib/types.js';

const f = (over: Partial<VerifiedFinding>): VerifiedFinding => ({
  findingId: Math.random().toString(36).slice(2),
  agent: 'security',
  mergedAgents: ['security'],
  file: 'a.js',
  line: 10,
  title: 't',
  verifiedEvidence: 'x',
  why: 'w',
  suggestion: 's',
  status: 'keep',
  impact: 5,
  certainty: 5,
  blastRadius: 5,
  score: 15,
  tier: 'minor',
  ...over,
});

describe('mergeCloseFindings', () => {
  it('merges findings within 3 lines and tags both categories, keeping the higher tier', () => {
    const out = mergeCloseFindings([
      f({ file: 'a.js', line: 10, agent: 'security', mergedAgents: ['security'], tier: 'major', score: 18 }),
      f({ file: 'a.js', line: 12, agent: 'performance', mergedAgents: ['performance'], tier: 'nit', score: 5 }),
    ]);
    expect(out).toHaveLength(1);
    expect(out[0]!.mergedAgents.sort()).toEqual(['performance', 'security']);
    expect(out[0]!.tier).toBe('major');
  });

  it('does not merge the same file when the lines are far apart', () => {
    const out = mergeCloseFindings([
      f({ file: 'a.js', line: 10 }),
      f({ file: 'a.js', line: 30 }),
    ]);
    expect(out).toHaveLength(2);
  });

  it('does not merge different files at the same line', () => {
    const out = mergeCloseFindings([
      f({ file: 'a.js', line: 10 }),
      f({ file: 'b.js', line: 10 }),
    ]);
    expect(out).toHaveLength(2);
  });
});
