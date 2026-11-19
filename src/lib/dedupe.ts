import type { VerifiedFinding } from './types.js';
import { tierWeight } from './scoring.js';

/**
 * Deterministic pre-consolidation merge: same file, line distance <= 3,
 * findings merge — highest tier wins, categories are tagged together.
 * The consolidator LLM may merge further (same root cause at a distance),
 * but never splits or invents.
 */
export function mergeCloseFindings(findings: VerifiedFinding[], maxDistance = 3): VerifiedFinding[] {
  const byFile = new Map<string, VerifiedFinding[]>();
  for (const f of findings) {
    const list = byFile.get(f.file) ?? [];
    list.push(f);
    byFile.set(f.file, list);
  }

  const merged: VerifiedFinding[] = [];
  for (const [, list] of byFile) {
    const sorted = [...list].sort((a, b) => a.line - b.line);
    for (const f of sorted) {
      const neighbor = [...merged]
        .reverse()
        .find((m) => m.file === f.file && Math.abs(m.line - f.line) <= maxDistance);
      if (neighbor) {
        neighbor.mergedAgents = [...new Set([...neighbor.mergedAgents, ...f.mergedAgents])];
        if (
          tierWeight(f.tier) > tierWeight(neighbor.tier) ||
          (f.tier === neighbor.tier && f.score > neighbor.score)
        ) {
          neighbor.title = f.title;
          neighbor.why = f.why;
          neighbor.suggestion = f.suggestion;
          neighbor.verifiedEvidence = f.verifiedEvidence;
          neighbor.tier = f.tier;
          neighbor.score = f.score;
          neighbor.status = f.status;
          neighbor.line = f.line;
        }
      } else {
        merged.push({ ...f, mergedAgents: [...f.mergedAgents] });
      }
    }
  }
  return merged;
}
