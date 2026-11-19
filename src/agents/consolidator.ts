import { completeJson } from '../llm/json.js';
import { consolidatorSchema } from '../lib/finding.js';
import { MAX_INLINE_WORDS, proseWords, tidyComment } from '../lib/format.js';
import { describeFixes, fixProse } from '../lib/prose.js';
import { loadPrompt } from './prompt.js';
import type { LlmForRole } from '../llm/types.js';
import type { VerifiedFinding } from '../lib/types.js';

export interface ConsolidatedFinding {
  finding: VerifiedFinding;
  /** final PR comment body (voice-normalized), keyed by the group's primary id */
  comment: string;
}

/**
 * The consolidator merges same-root-cause groups and rewrites comment text.
 * If it fails or misbehaves (invents ids, drops ids), we fall back to the
 * deterministic render — the review degrades, it never dies silently.
 * The prose budget is HARNESS-enforced: over-budget comments get one
 * rewrite, then the deterministic render. The prompt asks; the gate decides.
 */
export async function consolidate(
  findings: VerifiedFinding[],
  llm: LlmForRole,
  log: (msg: string) => void,
): Promise<ConsolidatedFinding[]> {
  if (!findings.length) return [];

  const input = findings.map((f) => ({
    id: f.findingId,
    agent: f.mergedAgents.join('+'),
    file: f.file,
    line: f.line,
    tier: f.tier,
    status: f.status,
    title: f.title,
    verifiedEvidence: f.verifiedEvidence,
    why: f.why,
    suggestion: f.suggestion,
  }));

  try {
    const system = `${loadPrompt('style')}\n\n---\n\n${loadPrompt('consolidator')}`;
    const res = await completeJson(llm, 'consolidator', system, JSON.stringify({ findings: input }), consolidatorSchema);
    const byId = new Map(findings.map((f) => [f.findingId, f]));

    const groups: { entry: ConsolidatedFinding; ids: string[] }[] = [];
    const seen = new Set<string>();
    for (const g of res.data.groups ?? []) {
      const primaryId = g.ids.find((id) => byId.has(id));
      if (!primaryId) {
        log(`consolidator invented unknown ids [${g.ids.join(', ')}] — group ignored`);
        continue;
      }
      const mergedAgents = [
        ...new Set(g.ids.flatMap((id) => byId.get(id)?.mergedAgents ?? [])),
      ];
      const primary = { ...byId.get(primaryId)!, mergedAgents };
      seen.add(primaryId);
      // ids the group swallowed are represented; ids it lost are re-added below
      for (const swallowed of g.ids) seen.add(swallowed);
      groups.push({ entry: { finding: primary, comment: g.comment }, ids: g.ids });
    }
    const lost = findings.filter((f) => !seen.has(f.findingId));
    if (lost.length) {
      log(`consolidator dropped ${lost.length} finding(s) — restoring deterministic comments`);
      groups.push(...lost.map((f) => ({ entry: { finding: f, comment: deterministicComment(f) }, ids: [f.findingId] })));
    }

    // Gate: prose budget. One targeted rewrite per offender, then degrade.
    const out: ConsolidatedFinding[] = [];
    for (const { entry, ids } of groups) {
      const comment = tidyComment(entry.comment);
      const words = proseWords(comment);
      if (words <= MAX_INLINE_WORDS) {
        out.push({ ...entry, comment });
        continue;
      }
      log(`comment for ${entry.finding.findingId} is ${words} prose words (cap ${MAX_INLINE_WORDS}) — one rewrite`);
      let fixed = '';
      try {
        const note =
          `Your comment was ${words} prose words; the contract is <=${MAX_INLINE_WORDS}. Rewrite the SAME group's comment, shorter: ` +
          'one problem sentence, the evidence as its own fenced code block, one why sentence, one "**Fix:**" line. Keep every id. Reply ONLY JSON.';
        const retry = await completeJson(
          llm,
          'consolidator',
          system,
          JSON.stringify({ note, findings: input.filter((x) => ids.includes(x.id)) }),
          consolidatorSchema,
        );
        fixed = tidyComment(retry.data.groups?.find((g) => g.ids.some((id) => ids.includes(id)))?.comment ?? '');
      } catch {
        /* degrade below */
      }
      if (fixed && proseWords(fixed) <= MAX_INLINE_WORDS) {
        out.push({ ...entry, comment: fixed });
      } else {
        log(`still over budget — deterministic comment for ${entry.finding.findingId}`);
        out.push({ finding: entry.finding, comment: deterministicComment(entry.finding) });
      }
    }
    return gateProse(out, log);
  } catch (err) {
    log(`consolidator failed (${(err as Error).message.slice(0, 120)}) — deterministic formatting`);
    return gateProse(findings.map((f) => ({ finding: f, comment: deterministicComment(f) })), log);
  }
}

/**
 * Prose gate: US spelling, no typos in the author voice. Every fix is
 * declared on the log — the review never silently rewrites a word it admits
 * to fixing.
 */
function gateProse(entries: ConsolidatedFinding[], log: (msg: string) => void): ConsolidatedFinding[] {
  return entries.map((c) => {
    const t = fixProse(c.finding.title);
    const cm = fixProse(c.comment);
    const fixes = [...t.fixes, ...cm.fixes];
    if (fixes.length)
      log(`prose gate: ${c.finding.file}:${c.finding.line} fixed ${describeFixes(fixes)}`);
    return { finding: { ...c.finding, title: t.text }, comment: cm.text };
  });
}

export function deterministicComment(f: VerifiedFinding): string {
  const lead =
    f.status === 'question'
      ? `Question: ${f.title}`
      : f.title;
  return [
    lead,
    '',
    '```',
    f.verifiedEvidence,
    '```',
    '',
    f.why,
    '',
    `**Fix:** ${f.suggestion}`,
  ].join('\n');
}
