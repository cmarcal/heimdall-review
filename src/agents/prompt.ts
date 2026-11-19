import { readFileSync } from 'node:fs';
import path from 'node:path';
import { PROMPTS_DIR } from '../lib/paths.js';
import type { AgentName, Capability, ReviewContext } from '../lib/types.js';
import { truncate } from '../lib/util.js';

const cache = new Map<string, string>();

export function loadPrompt(name: string): string {
  const hit = cache.get(name);
  if (hit) return hit;
  const text = readFileSync(path.join(PROMPTS_DIR, `${name}.md`), 'utf8');
  cache.set(name, text);
  return text;
}

/** Rough char budget for the whole pack, by declared model capability. */
export function packBudget(capability: Capability): number {
  if (capability === 'high') return 300_000;
  if (capability === 'standard') return 120_000;
  return 40_000;
}

export interface ContextPack {
  pack: string;
  truncated: boolean;
}

/**
 * Everything a specialist sees, in one text pack. Sections that get cut when
 * the model window is small are reported via `truncated` — declared coverage,
 * never silent loss.
 */
export function buildContextPack(
  ctx: ReviewContext,
  agent: AgentName,
  maxChars: number,
): ContextPack {
  const head: string[] = [];
  head.push(`# PR #${ctx.pr.number}: ${ctx.pr.title}`);
  head.push(`Author: ${ctx.pr.author} — ${ctx.pr.url}`);
  head.push(`Branch: ${ctx.pr.headRef} -> ${ctx.pr.baseRef}`);
  head.push(`\n## PR description\n${ctx.pr.body || '(empty)'}`);

  if (ctx.pr.commits?.length) {
    const lines = ctx.pr.commits.map((c) => `- ${c.subject}`);
    head.push(
      `\n## Commits — the author's stated intent per change\n${lines.join('\n')}`,
    );
  }

  if (ctx.ticket) {
    head.push(
      `\n## Linked ticket #${ctx.ticket.number}: ${ctx.ticket.title}\nSource of truth for requirements.\n\n${truncate(ctx.ticket.body, 20_000)}`,
    );
  } else {
    head.push(
      '\n## Linked ticket\nNO TICKET LINKED — requirements are UNVERIFIED. Do not invent requirements.',
    );
  }

  if (ctx.specs.length) {
    const specs = ctx.specs.map((s) => `### ${s.path}\n${s.content}`).join('\n\n');
    head.push(`\n## Spec files\n${specs}`);
  }

  if (ctx.comments.length) {
    const lines = ctx.comments.map((c) => {
      const where = c.file ? ` (${c.file}:${c.line ?? '?'}${c.resolved ? ', resolved thread' : ''})` : '';
      const trust = ctx.threadsTrusted || c.resolved === undefined ? '' : ' (resolution state unknown)';
      return `- ${c.author}${where}${trust}: ${truncate(c.body.replace(/\s+/g, ' '), 400)}`;
    });
    head.push(
      `\n## Existing PR comments — respect them. Do not repeat what a human already raised or dismissed.\n${lines.join('\n')}`,
    );
  }

  const agentDocs = ctx.docs.filter((d) => d.agent === agent);
  const docsSection = agentDocs.length
    ? `\n## Repo docs for your specialty\n${agentDocs.map((d) => `### ${d.path}\n${d.content}`).join('\n\n')}`
    : '';

  const filesSection =
    '\n## Changed files\n' +
    ctx.files
      .map((f) => {
        const meta = `### ${f.path} (${f.status}, +${f.added}/-${f.removed}, changed lines: ${summarizeLines(f.changedLines)})`;
        const patch = f.patch ? `\`\`\`diff\n${f.patch}\n\`\`\`` : '';
        const content =
          f.content !== null
            ? `\`\`\`\n${f.content}\n\`\`\``
            : f.status === 'removed'
              ? '(file removed)'
              : '(content unavailable)';
        return `${meta}\n${patch}\nFull head content:\n${content}`;
      })
      .join('\n\n');

  const essential = head.join('\n');
  let truncated = false;

  // Cut in order of least trustworthiness: repo docs first, then specs.
  let pack = `${essential}${docsSection}\n${filesSection}`;
  if (pack.length > maxChars) {
    pack = `${essential}\n${filesSection}`;
    truncated = true;
  }
  if (pack.length > maxChars) {
    const specsIdx = pack.indexOf('\n## Spec files');
    if (specsIdx >= 0) {
      const filesIdx = pack.indexOf('\n## Changed files');
      pack = pack.slice(0, specsIdx) + pack.slice(filesIdx);
    } else {
      pack = pack.slice(0, maxChars);
    }
    truncated = true;
  }
  if (pack.length > maxChars) {
    pack = pack.slice(0, maxChars);
    truncated = true;
  }
  return { pack, truncated };
}

function summarizeLines(lines: number[]): string {
  if (!lines.length) return 'none';
  if (lines.length > 40) return `${lines[0]}..${lines[lines.length - 1]}`;
  return lines.join(',');
}

export function pass1System(agent: AgentName): string {
  return [loadPrompt('style'), loadPrompt(`agent-${agent}`), loadPrompt('contract-pass1')].join('\n\n---\n\n');
}

export function pass2System(): string {
  return [loadPrompt('style'), loadPrompt('contract-pass2')].join('\n\n---\n\n');
}
