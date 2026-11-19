import { mkdirSync, writeFileSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

export interface RunArtifact {
  repo: string;
  prNumber: number;
  ts: string;
  preset: string;
  verdict: string;
  prScore: number | null;
  findings: unknown[];
  coverage: unknown[];
  gaps: unknown[];
  modelsUsed: unknown[];
  spentUsd: number;
  posted: { reviewSubmitted?: boolean; summaryUrl?: string; inlineUrls?: string[]; threadReplies?: string[] };
}

/**
 * Every run lands on disk with stable finding IDs and posted-comment URLs.
 * This is the calibration dataset: score given now + what humans did later
 * (v2 joins reaction/resolution state by commentUrl) -> range tuning.
 */
export function writeRun(dir: string, artifact: RunArtifact): string {
  mkdirSync(dir, { recursive: true });
  const safeRepo = artifact.repo.replace(/[^\w.-]+/g, '_');
  const file = path.join(dir, `${safeRepo}-${artifact.prNumber}-${artifact.ts.replace(/[:]/g, '')}.json`);
  writeFileSync(file, JSON.stringify(artifact, null, 2));
  return file;
}

export function loadRunFindingIds(dir: string, repo: string, prNumber: number): Set<string> {
  const ids = new Set<string>();
  const safeRepo = repo.replace(/[^\w.-]+/g, '_');
  try {
    for (const f of readdirSync(dir)) {
      if (!f.startsWith(`${safeRepo}-${prNumber}-`) || !f.endsWith('.json')) continue;
      const data = JSON.parse(readFileSync(path.join(dir, f), 'utf8')) as RunArtifact;
      for (const raw of data.findings) {
        const fl = raw as { findingId?: string };
        if (fl.findingId) ids.add(fl.findingId);
      }
    }
  } catch {
    // no previous runs — fine
  }
  return ids;
}
