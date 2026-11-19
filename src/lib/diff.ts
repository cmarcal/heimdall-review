import type { DiffFile } from './types.js';
import { globMatch } from './util.js';

/** Parse `git diff`-style multi-file patches (what `gh pr diff` prints). */
export function parsePatch(diffText: string): Omit<DiffFile, 'content'>[] {
  const files: Omit<DiffFile, 'content'>[] = [];
  let current: {
    path: string;
    status: DiffFile['status'];
    lines: string[];
    patchLines: string[];
    added: number;
    removed: number;
    changedLines: number[];
  } | null = null;

  const flush = () => {
    if (!current) return;
    files.push({
      path: current.path,
      status: current.status,
      patch: current.patchLines.join('\n'),
      changedLines: current.changedLines,
      added: current.added,
      removed: current.removed,
    });
    current = null;
  };

  let headLine = 0;
  let inHunk = false;
  for (const line of diffText.split('\n')) {
    if (line.startsWith('diff --git ')) {
      flush();
      const m = line.match(/ b\/(.+)$/);
      current = {
        path: m?.[1] ?? 'unknown',
        status: 'modified',
        lines: [],
        patchLines: [line],
        added: 0,
        removed: 0,
        changedLines: [],
      };
      headLine = 0;
      inHunk = false;
      continue;
    }
    if (!current) continue;
    current.patchLines.push(line);
    if (line.startsWith('new file mode')) {
      current.status = 'added';
      continue;
    }
    if (line.startsWith('deleted file mode')) {
      current.status = 'removed';
      continue;
    }
    if (line.startsWith('rename from ') || line.startsWith('rename to ')) {
      current.status = 'renamed';
      continue;
    }
    // File headers and mode/index lines never carry content — never count them.
    if (/^(---|\+\+\+|index |similarity |dissimilarity |old mode |new mode |copy from |copy to )/.test(line)) continue;

    const hunk = line.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
    if (hunk?.[1]) {
      headLine = Number(hunk[1]);
      inHunk = true;
      continue;
    }
    if (!inHunk) continue;
    if (line.startsWith('\\')) continue; // "\ No newline at end of file"
    if (line.startsWith('+')) {
      current.added++;
      current.changedLines.push(headLine);
      headLine++;
    } else if (line.startsWith('-')) {
      current.removed++;
    } else {
      headLine++;
    }
    current.lines.push(line);
  }
  flush();
  return files;
}

export interface CapDecision {
  review: Omit<DiffFile, 'content'>[];
  skipped: { file: string; reason: string }[];
}

/**
 * Caps with honest reporting: skip-globs, per-file cap, total cap.
 * What gets cut is LISTED in the summary, never silently dropped.
 */
export function applyCaps(
  files: Omit<DiffFile, 'content'>[],
  opts: { skip: string[]; maxFileChangedLines: number; maxTotalChangedLines: number },
): CapDecision {
  const skipped: { file: string; reason: string }[] = [];
  const kept: Omit<DiffFile, 'content'>[] = [];

  for (const f of files) {
    if (opts.skip.some((g) => globMatch(g, f.path))) {
      skipped.push({ file: f.path, reason: 'skip pattern' });
      continue;
    }
    if (f.added + f.removed > opts.maxFileChangedLines) {
      skipped.push({ file: f.path, reason: `over per-file cap (${f.added + f.removed} changed lines)` });
      continue;
    }
    kept.push(f);
  }

  // Total cap: keep the riskiest (most-changed) files, declare the rest.
  let total = 0;
  const review: Omit<DiffFile, 'content'>[] = [];
  const bySize = [...kept].sort((a, b) => b.added + b.removed - (a.added + a.removed));
  for (const f of bySize) {
    const size = f.added + f.removed;
    if (total + size > opts.maxTotalChangedLines) {
      skipped.push({ file: f.path, reason: 'over total cap' });
      continue;
    }
    total += size;
    review.push(f);
  }
  review.sort((a, b) => a.path.localeCompare(b.path));
  skipped.sort((a, b) => a.file.localeCompare(b.file));
  return { review, skipped };
}
