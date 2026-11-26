import type { ConsolidatedFinding } from '../agents/consolidator.js';
import type { RunSummary, Tier, VerifiedFinding } from './types.js';
import { tierIcon } from './summary.js';
import { truncate } from './util.js';

/** Readiness score is derived ONLY from public tier counts — the private score map never leaks. */
const PENALTY: Record<Tier, number> = { blocker: 40, major: 15, minor: 5, nit: 1 };
const PENALTY_ORDER: Tier[] = ['blocker', 'major', 'minor', 'nit'];

export interface PrScore {
  score: number;
  band: string;
  icon: string;
}

/**
 * PR readiness 0–100: 100 minus a fixed penalty per finding, floored at 0.
 * Any blocker reads Blocked whatever the number says — it matches the
 * REQUEST_CHANGES gate, so the headline and the event can never disagree.
 */
export function prScoreOf(counts: Record<Tier, number>): PrScore {
  const deducted = PENALTY_ORDER.reduce((sum, t) => sum + PENALTY[t] * counts[t], 0);
  const score = Math.max(0, 100 - deducted);
  if (counts.blocker > 0) return { score, band: 'Blocked', icon: '💀' };
  if (score >= 90) return { score, band: 'Ready', icon: '🟢' };
  if (score >= 75) return { score, band: 'Nearly ready', icon: '🔵' };
  if (score >= 50) return { score, band: 'Needs work', icon: '🟠' };
  return { score, band: 'At risk', icon: '🔴' };
}

function penaltyBreakdown(counts: Record<Tier, number>): string {
  const parts = PENALTY_ORDER.filter((t) => counts[t] > 0).map(
    (t) => `−${PENALTY[t] * counts[t]} (${counts[t]} ${t}${counts[t] > 1 ? 's' : ''})`,
  );
  return parts.length ? `Score: 100 ${parts.join(' ')}` : 'Score: 100 — nothing to deduct';
}

/** A 10-cell block gauge so the number reads as a picture, not just a digit. */
function gauge(score: number): string {
  const filled = Math.round(score / 10);
  return '█'.repeat(filled) + '░'.repeat(10 - filled);
}

export function renderReport(
  repo: string,
  prNumber: number,
  consolidated: ConsolidatedFinding[],
  run: RunSummary,
): string {
  const lines: string[] = [];
  lines.push(`# Heimdall — ${repo} PR #${prNumber} (dry run, nothing posted)`);
  lines.push('');
  if (run.prScore === null) {
    lines.push('## 🎯 PR Score — not available (no specialist completed this run)');
  } else {
    lines.push(`## 🎯 PR Score  ${run.prScore}/100  ${run.prBand}`);
    lines.push(`> \`${gauge(run.prScore)}\`  ${penaltyBreakdown(run.counts)}`);
  }
  lines.push('');
  lines.push(`Verdict: ${run.verdict}`);
  lines.push('');

  if (consolidated.length) {
    lines.push('## Inline comments that would be posted');
    lines.push('');
    for (const c of consolidated) {
      const f = c.finding;
      lines.push(`### ${tierIcon(f.tier)} ${f.tier.toUpperCase()} — ${f.file}:${f.line} [${f.mergedAgents.join('+')}]${f.status === 'question' ? ' (question)' : ''}`);
      lines.push('');
      lines.push(c.comment);
      lines.push('');
      lines.push(`evidence: ${truncate(f.verifiedEvidence.replace(/\s+/g, ' '), 160)}`);
      lines.push(`scores(hidden): impact=${f.impact} certainty=${f.certainty} blast=${f.blastRadius} → ${f.score}`);
      lines.push('');
    }
  } else {
    lines.push('No findings survived the two-pass verification.');
    lines.push('');
  }

  lines.push('## Coverage');
  for (const c of run.coverage) {
    lines.push(`- ${c.agent}: ${c.status} (${c.model}/${c.capability}) findings=${c.findings} dropped=${c.dropped}`);
  }
  if (run.gaps.length) {
    lines.push('');
    lines.push('## Gap checks');
    for (const g of run.gaps) lines.push(`- ${g.file}: ${g.clean ? 'clean' : `⚠️ ${g.note ?? ''}`}`);
  }
  if (run.notReviewed.length) {
    lines.push('');
    lines.push('## Not reviewed');
    for (const n of run.notReviewed) lines.push(`- ${n.file}: ${n.reason}`);
  }
  // Teach mode earns a line only when something was under the bar: a run where
  // it had nothing to do reports exactly what the same run without it reported.
  if (run.teach && run.teach.eligible > 0) {
    const t = run.teach;
    lines.push('');
    lines.push('## 🎓 Teach mode');
    lines.push(`- bar: ${t.below}/100 of the maximum score — a finding under it gets a full explanation`);
    lines.push(
      `- ${t.taught} explained, ${t.fallback} kept the terse comment ` +
        `(${t.eligible} finding${t.eligible === 1 ? '' : 's'} under the bar)`,
    );
  }
  if (run.usedBasicModel) {
    lines.push('');
    lines.push('⚠️ basic-capability models were used — expect shallower security/regression analysis.');
  }
  return lines.join('\n');
}

export function countTiers(findings: VerifiedFinding[]): Record<Tier, number> {
  const counts: Record<Tier, number> = { blocker: 0, major: 0, minor: 0, nit: 0 };
  for (const f of findings) counts[f.tier]++;
  return counts;
}
