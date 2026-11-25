import { globMatch, truncate } from './util.js';
import type { SpecFile } from './types.js';

/** Per-file char cap — same as diff-file head content, so one giant file
 *  cannot crowd out the rest of the repo's instruction files. */
export const INSTRUCTIONS_FILE_CAP_CHARS = 12_000;
/** Total char cap across every selected instruction file. */
export const INSTRUCTIONS_BUDGET_CHARS = 30_000;
/** Most instruction files carried into a context pack. */
export const INSTRUCTIONS_MAX_FILES = 12;

/**
 * Pick which tree paths are agent instruction files: match the patterns, drop
 * anything a skip glob catches (so node_modules/AGENTS.md dies), dedupe paths
 * matched by more than one pattern, then order root-level first and nested
 * after, alphabetical within each group. The file cap is applied here so the
 * caller fetches at most this many.
 */
export function selectAgentInstructionPaths(
  tree: string[],
  patterns: string[],
  skip: string[],
): string[] {
  const matched = new Set<string>();
  for (const path of tree) {
    if (!patterns.some((g) => globMatch(g, path))) continue;
    if (skip.some((g) => globMatch(g, path))) continue;
    matched.add(path);
  }
  const depth = (p: string) => (p.includes('/') ? 1 : 0);
  return [...matched]
    .sort((a, b) => depth(a) - depth(b) || a.localeCompare(b))
    .slice(0, INSTRUCTIONS_MAX_FILES);
}

/**
 * Fetch each selected path and assemble the pack content under a total char
 * budget. Per-file content is capped like diff files; once the budget is spent
 * the remaining files are dropped. readFile returns null when a fetch fails.
 */
export async function assembleAgentInstructions(
  paths: string[],
  readFile: (path: string) => Promise<string | null>,
  budget: number = INSTRUCTIONS_BUDGET_CHARS,
): Promise<SpecFile[]> {
  const out: SpecFile[] = [];
  let remaining = budget;
  for (const path of paths) {
    if (remaining <= 0) break;
    const raw = await readFile(path);
    if (!raw) continue;
    const cut = truncate(truncate(raw, INSTRUCTIONS_FILE_CAP_CHARS), remaining);
    out.push({ path, content: cut });
    remaining -= cut.length;
  }
  return out;
}
