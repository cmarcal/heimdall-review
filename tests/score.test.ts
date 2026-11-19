import { describe, it, expect } from 'vitest';
import { prScoreOf, renderReport } from '../src/lib/output.js';
import type { RunSummary } from '../src/lib/types.js';

const counts = (blocker = 0, major = 0, minor = 0, nit = 0) => ({ blocker, major, minor, nit });

const run = (over: Partial<RunSummary>): RunSummary => ({
  verdict: 'v', prScore: null, prBand: null, counts: counts(), coverage: [], gaps: [],
  notReviewed: [], requirementsVerified: true, usedBasicModel: false, contextTruncated: false,
  modelsUsed: [], budgetUsd: 1, spentUsd: 0, ...over,
});

describe('prScoreOf', () => {
  it('a clean PR is a perfect score', () => {
    expect(prScoreOf(counts())).toEqual({ score: 100, band: 'Ready', icon: '🟢' });
  });

  it('deducts a fixed penalty per tier and floors at 0', () => {
    expect(prScoreOf(counts(0, 1, 2, 3)).score).toBe(100 - 15 - 10 - 3);
    expect(prScoreOf(counts(0, 0, 0, 200)).score).toBe(0);
  });

  it('any blocker reads Blocked whatever the number says, matching the gate', () => {
    expect(prScoreOf(counts(1, 0, 0, 0))).toEqual({ score: 60, band: 'Blocked', icon: '💀' });
    expect(prScoreOf(counts(3)).band).toBe('Blocked');
  });

  it('bands the healthy range by score', () => {
    expect(prScoreOf(counts(0, 0, 0, 10)).band).toBe('Ready'); // 90
    expect(prScoreOf(counts(0, 1, 1, 1)).band).toBe('Nearly ready'); // 79
    expect(prScoreOf(counts(0, 2, 2, 0)).band).toBe('Needs work'); // 60
    expect(prScoreOf(counts(0, 3, 2, 0)).band).toBe('At risk'); // 45
  });
});

describe('renderReport PR score highlight', () => {
  it('leads with the score, a gauge and the deduction breakdown', () => {
    const c = counts(0, 1, 2, 0);
    const report = renderReport('acme/x', 7, [], run({ prScore: 79, prBand: '🔵 Nearly ready', counts: c }));
    expect(report).toContain('## 🎯 PR Score  79/100  🔵 Nearly ready');
    expect(report).toContain('████████░░');
    expect(report).toContain('Score: 100 −15 (1 major) −10 (2 minors)');
  });

  it('shows 100/100 for a clean run instead of hiding the number', () => {
    const report = renderReport('acme/x', 7, [], run({ prScore: 100, prBand: '🟢 Ready' }));
    expect(report).toContain('PR Score  100/100');
    expect(report).toContain('nothing to deduct');
  });

  it('declares the score unavailable only when no specialist completed', () => {
    const report = renderReport('acme/x', 7, [], run({ prScore: null, prBand: null }));
    expect(report).toContain('not available (no specialist completed');
  });
});
