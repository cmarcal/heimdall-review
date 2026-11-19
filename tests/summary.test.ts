import { describe, it, expect } from 'vitest';
import { computeVerdict, buildSummaryComment, SUMMARY_MARKER } from '../src/lib/summary.js';
import type { RunSummary, VerifiedFinding } from '../src/lib/types.js';

const counts = (blocker = 0, major = 0, minor = 0, nit = 0) => ({ blocker, major, minor, nit });

const run = (over: Partial<RunSummary>): RunSummary => ({
  verdict: 'x', prScore: 100, prBand: '🟢 Ready', counts: counts(), coverage: [], gaps: [], notReviewed: [],
  requirementsVerified: true, usedBasicModel: false, contextTruncated: false,
  modelsUsed: [], budgetUsd: 3, spentUsd: 0.1, ...over,
});

const finding: VerifiedFinding = {
  findingId: 'f1', agent: 'security', mergedAgents: ['security'], file: 'a.js', line: 3,
  title: 'XSS', verifiedEvidence: 'x', why: 'w', suggestion: 's', status: 'keep',
  impact: 9, certainty: 8, blastRadius: 8, score: 25, tier: 'blocker',
};

describe('computeVerdict', () => {
  it('prioritizes blockers, then majors, then minors', () => {
    expect(computeVerdict(counts(1))).toMatch(/Needs work/);
    expect(computeVerdict(counts(0, 2))).toMatch(/2 majors/);
    expect(computeVerdict(counts(0, 0, 1))).toMatch(/Comment only/);
    expect(computeVerdict(counts())).toMatch(/No findings/);
  });
});

describe('buildSummaryComment', () => {
  it('always carries the marker and the advisory tone', () => {
    const s = buildSummaryComment('acme/x', 1, [], run({}));
    expect(s).toContain(SUMMARY_MARKER);
    expect(s).toMatch(/never approves and never gates/);
  });

  it('declares the gate when a blocker requests changes', () => {
    const s = buildSummaryComment('acme/x', 1, [finding], run({ counts: counts(1) }));
    expect(s).toMatch(/requests changes/);
    expect(s).not.toMatch(/never gates/);
  });

  it('declares unverified requirements only when the ticket is missing', () => {
    expect(buildSummaryComment('a/b', 1, [], run({ requirementsVerified: false }))).toMatch(/Requirements unverified/);
    expect(buildSummaryComment('a/b', 1, [], run({ requirementsVerified: true }))).not.toMatch(/Requirements unverified/);
  });

  it('discloses basic models honestly, and stays quiet about capable ones', () => {
    const withBasic = buildSummaryComment('a/b', 1, [finding], run({
      usedBasicModel: true,
      modelsUsed: [{ role: 'security', model: 'llama3.1:8b', capability: 'basic' }],
    }));
    expect(withBasic).toMatch(/expect shallower security and regression analysis/);
    expect(withBasic).toContain('llama3.1:8b');

    const withGood = buildSummaryComment('a/b', 1, [finding], run({ usedBasicModel: false }));
    expect(withGood).not.toMatch(/expect shallower security/);
  });

  it('renders the private score nowhere — only the tier label appears', () => {
    const s = buildSummaryComment('a/b', 1, [finding], run({}));
    expect(s).toMatch(/Blocker/);
    expect(s).not.toMatch(/score.*25|impact.*9/i);
  });
});
