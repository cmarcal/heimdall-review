import { completeJson } from '../llm/json.js';
import { gapCheckSchema } from '../lib/finding.js';
import { loadPrompt } from './prompt.js';
import type { LlmForRole } from '../llm/types.js';
import type { GapCheckResult, ReviewContext } from '../lib/types.js';
import { mapWithConcurrency, truncate } from '../lib/util.js';

const MAX_GAP_FILES = 10;

/**
 * "Arquivos sem comentários": files no specialist reported on get a cheap
 * second look before the review claims coverage.
 */
export async function gapCheckUncoveredFiles(
  ctx: ReviewContext,
  flaggedFiles: Set<string>,
  llm: LlmForRole,
  log: (msg: string) => void,
): Promise<GapCheckResult[]> {
  const uncovered = ctx.files.filter((f) => !flaggedFiles.has(f.path) && f.content).slice(0, MAX_GAP_FILES);
  const system = loadPrompt('gap-check');

  return mapWithConcurrency(uncovered, 3, async (f) => {
    try {
      const res = await completeJson(
        llm,
        'gap-check',
        system,
        `File: ${f.path}\n\n\`\`\`\n${truncate(f.content ?? '', 8000)}\n\`\`\``,
        gapCheckSchema,
      );
      return { file: f.path, clean: res.data.clean, note: res.data.note };
    } catch (err) {
      log(`gap-check failed for ${f.path}: ${(err as Error).message.slice(0, 100)}`);
      // Unknown is never reported as clean.
      return { file: f.path, clean: false, note: 'gap-check could not run — not verified' };
    }
  });
}
