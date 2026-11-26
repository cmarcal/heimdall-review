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

  const specsSection = ctx.specs.length
    ? `\n## Spec files\n${ctx.specs.map((s) => `### ${s.path}\n${s.content}`).join('\n\n')}`
    : '';

  // The repo's own AI-tool rule files: a citable standard for every specialist,
  // placed right after the specs.
  const instructions = ctx.agentInstructions ?? [];
  const instructionsSection = instructions.length
    ? `\n## Repo agent instructions — the repo's own rules for AI tools and contributors. Cite them like documented standards.\n${instructions
        .map((s) => `### ${s.path}\n${s.content}`)
        .join('\n\n')}`
    : '';

  const commentsSection = ctx.comments.length
    ? `\n## Existing PR comments — respect them. Do not repeat what a human already raised or dismissed.\n${ctx.comments
        .map((c) => {
          const where = c.file ? ` (${c.file}:${c.line ?? '?'}${c.resolved ? ', resolved thread' : ''})` : '';
          const trust = ctx.threadsTrusted || c.resolved === undefined ? '' : ' (resolution state unknown)';
          return `- ${c.author}${where}${trust}: ${truncate(c.body.replace(/\s+/g, ' '), 400)}`;
        })
        .join('\n')}`
    : '';

  const agentDocs = ctx.docs.filter((d) => d.agent === agent);
  const docsSection = agentDocs.length
    ? `\n## Repo docs for your specialty\n${agentDocs.map((d) => `### ${d.path}\n${d.content}`).join('\n\n')}`
    : '';

  // Migrations for tables the diff's SQL names, fetched by the source. A
  // constraint defined here is a fact: uniqueness/FK claims about these tables
  // must cite it or become a question about it.
  const migrations = ctx.migrations ?? [];
  const migrationsSection = migrations.length
    ? `\n## Migrations for tables this diff touches — schema facts. A claim that a constraint is absent on these tables must cite a line here; when the deciding migration could live outside these files, ask a question instead of asserting.\n${migrations
        .map((s) => `### ${s.path}\n${s.content}`)
        .join('\n\n')}`
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

  const top = head.join('\n');
  let truncated = false;

  // Cut in order of least trustworthiness when the window is tight: per-agent
  // repo docs first, then the migrations section, then agent instructions,
  // then specs cut last (the spec is the requirements axis's source of truth,
  // so it is the last thing to go).
  const withDocs = `${top}${specsSection}${instructionsSection}${commentsSection}${docsSection}${migrationsSection}\n${filesSection}`;
  const withoutDocs = `${top}${specsSection}${instructionsSection}${commentsSection}${migrationsSection}\n${filesSection}`;
  const withoutMigrations = `${top}${specsSection}${instructionsSection}${commentsSection}\n${filesSection}`;
  const withoutInstructions = `${top}${specsSection}${commentsSection}\n${filesSection}`;
  const bare = `${top}${commentsSection}\n${filesSection}`;

  let pack = withDocs;
  if (pack.length > maxChars) {
    pack = withoutDocs;
    truncated = true;
  }
  if (pack.length > maxChars) {
    pack = withoutMigrations;
    truncated = true;
  }
  if (pack.length > maxChars) {
    pack = withoutInstructions;
    truncated = true;
  }
  if (pack.length > maxChars) {
    pack = bare;
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
