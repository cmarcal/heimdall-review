import { capTitle } from './format.js';
import type { RunSummary, Tier, VerifiedFinding } from './types.js';

export const SUMMARY_MARKER = '<!-- heimdall:summary -->';

export function computeVerdict(counts: Record<Tier, number>): string {
  if (counts.blocker > 0)
    return `❌ Needs work — ${counts.blocker} blocker${counts.blocker > 1 ? 's' : ''}${counts.major ? `, ${counts.major} major(s)` : ''}`;
  if (counts.major > 0) return `⚠️ Needs work — ${counts.major} major${counts.major > 1 ? 's' : ''}`;
  if (counts.minor > 0) return `🟡 Comment only — ${counts.minor} minor${counts.minor > 1 ? 's' : ''}, nothing blocking`;
  if (counts.nit > 0) return `🔵 Nits only — author's discretion`;
  return '✅ No findings — all specialists and gap-checks came back clean';
}

export function tierIcon(tier: Tier): string {
  return { blocker: '💀', major: '🔴', minor: '🟡', nit: '🔵' }[tier];
}

export function tierLabel(tier: Tier): string {
  return { blocker: 'Blocker', major: 'Major', minor: 'Minor', nit: 'Nit' }[tier];
}

export function buildSummaryComment(
  ctxRepo: string,
  prNumber: number,
  findings: VerifiedFinding[],
  run: RunSummary,
  /** must match the event the review was posted with — blockers gate */
  requestChanges = run.counts.blocker > 0,
): string {
  const lines: string[] = [];
  lines.push(SUMMARY_MARKER);
  lines.push(`## 🛰️ Heimdall review — \`${ctxRepo}\` · PR #${prNumber}`);
  lines.push('');
  lines.push(`**Verdict:** ${run.verdict}`);
  lines.push('');
  lines.push(
    requestChanges
      ? '_Advisory review by Heimdall (multi-agent). It never approves; this run **requests changes** — blockers must be resolved. Humans merge._'
      : '_Advisory review by Heimdall (multi-agent). It never approves and never gates — humans decide._',
  );
  lines.push('');

  if (findings.length) {
    lines.push('### Findings (inline comments on the diff)');
    lines.push('');
    const order: Tier[] = ['blocker', 'major', 'minor', 'nit'];
    for (const t of order) {
      const fs = findings.filter((f) => f.tier === t);
      if (!fs.length) continue;
      lines.push(`**${tierIcon(t)} ${tierLabel(t)} — ${fs.length}**`);
      for (const f of fs) {
        const tags = f.mergedAgents.length > 1 ? ` _[${f.mergedAgents.join(' + ')}]_` : '';
        const q = f.status === 'question' ? ' _(question)_' : '';
        lines.push(`- \`${f.file}:${f.line}\` — ${capTitle(f.title)}${tags}${q}`);
      }
      lines.push('');
    }
  }

  lines.push('### Coverage');
  lines.push('');
  lines.push('| specialist | status | model | tier¹ | findings | dropped² |');
  lines.push('|---|---|---|---|---|---|');
  for (const c of run.coverage) {
    lines.push(`| ${c.agent} | ${c.status} | \`${c.model}\` | ${c.capability} | ${c.findings} | ${c.dropped} |`);
  }
  lines.push('');
  lines.push('¹ declared model capability · ² candidates the second pass could not verify against real code (deleted, not posted)');
  lines.push('');

  if (run.gaps.length) {
    lines.push('### Files no specialist flagged (gap-check pass)');
    lines.push('');
    for (const g of run.gaps) {
      lines.push(g.clean ? `- \`${g.file}\` — clean` : `- \`${g.file}\` — ⚠️ ${g.note ?? 'flagged by gap-check'}`);
    }
    lines.push('');
  }

  if (run.notReviewed.length) {
    lines.push('### Not deeply reviewed (declared, not hidden)');
    lines.push('');
    for (const n of run.notReviewed) lines.push(`- \`${n.file}\` — ${n.reason}`);
    lines.push('');
  }

  if (!run.requirementsVerified) {
    lines.push(
      '### ⚠️ Requirements unverified',
      'No linked GitHub issue was found (flag, closing keyword, or branch convention). The Requirements specialist reviewed against the PR description only, which is a claim, not a source of truth. Link the issue with `Closes #N` for a real requirements pass.',
    );
    lines.push('');
  }

  const notes: string[] = [];
  if (run.contextTruncated) notes.push('Context was truncated to fit the configured models\' window — coverage of file contents is partial.');
  if (run.budgetUsd > 0) notes.push(`LLM budget: $${run.spentUsd.toFixed(3)} of $${run.budgetUsd.toFixed(2)} spent.`);
  // Only say it when teach mode had something to explain: an author reading a
  // review that changed nothing should not have to wonder what changed.
  if (run.teach && run.teach.eligible > 0) {
    const t = run.teach;
    notes.push(
      `Teach mode is on: ${t.taught} finding${t.taught === 1 ? '' : 's'} under the bar (${t.below}/100) explained in full — ` +
        `what the code does, why it breaks, how to fix it; ${t.fallback} kept the terse comment.`,
    );
  }
  if (notes.length) {
    lines.push('### Notes');
    for (const n of notes) lines.push(`- ${n}`);
    lines.push('');
  }

  if (run.usedBasicModel) {
    const models = [...new Set(run.modelsUsed.filter((m) => m.capability === 'basic').map((m) => m.model))];
    lines.push(
      `---\n_Models used: ${models.map((m) => '`' + m + '` (basic)').join(', ')} — expect shallower security and regression analysis; a human pass is recommended on the flagged files._`,
    );
  }

  return lines.join('\n');
}
