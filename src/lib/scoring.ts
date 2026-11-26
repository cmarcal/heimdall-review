import { createHash } from 'node:crypto';
import type { Tier, VerifiedFinding } from './types.js';

export interface ScoringConfig {
  weights: { impact: number; certainty: number; blastRadius: number };
  tiers: { id: Tier; min: number; icon: string; label: string }[];
  /** Clamp for pass-2 `question` findings (see config/scoring.json). */
  question?: { certaintyCap?: number; maxTier?: Tier };
  /** Teach mode: explain findings whose score, as a percentage of maxScore, is below `below`. */
  teach?: { below?: number; maxScore?: number };
}

export type FindingStatus = 'keep' | 'question';

/** The shipped defaults, used when a config omits the teach block. */
export const DEFAULT_TEACH_BELOW = 60;
export const DEFAULT_TEACH_MAX_SCORE = 30;

export function scoreOf(f: { impact: number; certainty: number; blastRadius: number }, cfg: ScoringConfig): number {
  return Math.round(
    f.impact * cfg.weights.impact +
      f.certainty * cfg.weights.certainty +
      f.blastRadius * cfg.weights.blastRadius,
  );
}

export function tierOf(score: number, cfg: ScoringConfig): { id: Tier; icon: string; label: string } {
  const sorted = [...cfg.tiers].sort((a, b) => b.min - a.min);
  for (const t of sorted) if (score >= t.min) return t;
  const last = sorted[sorted.length - 1];
  if (!last) throw new Error('scoring config has no tiers');
  return last;
}

/**
 * Score + tier for a survivor of the quote gate. A `question` is a concern the
 * verifier could NOT confirm from the code, so its tier is clamped (certainty
 * cap + max tier from the scoring config): an unconfirmed finding is never a
 * Major, whatever the finder claimed. The record keeps the finder's original
 * sub-scores — the calibration dataset wants to see over-claims.
 */
export function scoreAndTier(
  f: { impact: number; certainty: number; blastRadius: number },
  status: FindingStatus,
  cfg: ScoringConfig,
): { score: number; tier: Tier } {
  const sub =
    status === 'question'
      ? { ...f, certainty: Math.min(f.certainty, cfg.question?.certaintyCap ?? 3) }
      : f;
  const score = scoreOf(sub, cfg);
  let tier = tierOf(score, cfg).id;
  const max = status === 'question' ? cfg.question?.maxTier : undefined;
  if (max && tierWeight(tier) > tierWeight(max)) tier = max;
  return { score, tier };
}

/**
 * The score as a percentage of the maximum, so a threshold means the same
 * thing whatever the weights are. A non-positive maxScore is treated as the
 * default rather than dividing by zero.
 */
export function scorePct(score: number, cfg: ScoringConfig): number {
  const max = cfg.teach?.maxScore;
  const maxScore = max && max > 0 ? max : DEFAULT_TEACH_MAX_SCORE;
  return Math.round((score / maxScore) * 100);
}

/**
 * Teach mode reads one thing off the finding: does it score low enough that a
 * terse comment would leave the author with nothing to act on? Strictly below —
 * a finding exactly at the bar keeps the terse voice.
 */
export function shouldTeach(f: { score: number }, cfg: ScoringConfig): boolean {
  return scorePct(f.score, cfg) < (cfg.teach?.below ?? DEFAULT_TEACH_BELOW);
}

/**
 * The scoring map with this run's teach threshold applied (a `--teach-below`
 * flag or a repo manifest wins over config/scoring.json). Everything else in
 * the map is shared by reference: teach must not be able to move a tier.
 */
export function teachScoringConfig(
  cfg: ScoringConfig,
  override?: { below?: number },
): ScoringConfig {
  const below = override?.below ?? cfg.teach?.below ?? DEFAULT_TEACH_BELOW;
  return { ...cfg, teach: { ...cfg.teach, below } };
}

/**
 * Stable across runs: file + coarse line bucket + agent.
 * Bucketed by 5 lines so a human's 2-line edit does not re-trigger the same finding.
 */
export function findingId(file: string, line: number, agent: string): string {
  const bucket = Math.floor(line / 5);
  return createHash('sha1')
    .update(`${file}:${bucket}:${agent}`)
    .digest('hex')
    .slice(0, 12);
}

export function tierWeight(tier: Tier): number {
  const order: Record<Tier, number> = { blocker: 4, major: 3, minor: 2, nit: 1 };
  return order[tier];
}

/** Highest-tier-first sort used everywhere findings are listed. */
export function sortByTier(findings: VerifiedFinding[]): VerifiedFinding[] {
  return [...findings].sort(
    (a, b) => tierWeight(b.tier) - tierWeight(a.tier) || b.score - a.score || a.file.localeCompare(b.file),
  );
}
