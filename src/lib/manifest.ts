import { z } from 'zod';
import type { AgentName, Manifest } from './types.js';
import { AGENT_NAMES } from './types.js';

const agentCfg = z.object({
  enabled: z.boolean().default(true),
  /** omitted => the agent's DEFAULT_DOCS are auto-discovered; [] => discover nothing */
  docs: z.array(z.string()).optional(),
});

/**
 * The repo's own rule files for AI coding tools and contributors, found by
 * convention with no manifest present. These reach EVERY specialist as a
 * citable standard, not just standards: a repo's AGENTS.md binds the whole
 * team, not one review axis. Nested variants (a per-package AGENTS.md) count
 * too; anything a skip glob catches (node_modules, dist) is dropped later.
 */
export const AGENT_INSTRUCTION_PATTERNS: string[] = [
  'AGENTS.md',
  'CLAUDE.md',
  'GEMINI.md',
  '.github/copilot-instructions.md',
  '.cursorrules',
  '.cursor/rules/**',
  '.qodo/agents/**',
  '**/AGENTS.md',
  '**/CLAUDE.md',
];

/**
 * Docs every agent reads even when the repo ships no .pr-review.json.
 * The standards axis is meaningless without the repo's own written rules,
 * so the classics are discovered by name (a documented standard turns a smell
 * from judgement call into citable violation — and can also license it).
 * AGENTS.md and CLAUDE.md are NOT listed here: the shared agent-instructions
 * section already delivers every agent's instruction files, so duplicating
 * them into standards would show those files to standards twice.
 */
export const DEFAULT_DOCS: Record<AgentName, string[]> = {
  security: [],
  requirements: [],
  'e2e-tests': [],
  architecture: [],
  regression: [],
  performance: [],
  standards: ['CONTRIBUTING.md', 'CODING_STANDARDS.md', 'docs/standards/**'],
};

const manifestSchema = z.object({
  preset: z.string().nullable().default(null),
  budgetUsd: z.number().positive().default(3),
  maxFileChangedLines: z.number().int().positive().default(400),
  maxTotalChangedLines: z.number().int().positive().default(3000),
  skip: z
    .array(z.string())
    .default([
      '**/*.lock',
      '**/package-lock.json',
      '**/yarn.lock',
      '**/pnpm-lock.yaml',
      '**/dist/**',
      '**/build/**',
      '**/generated/**',
      '**/*.min.js',
      '**/*.min.css',
    ]),
  specs: z.array(z.string()).default(['docs/rfc/**', 'docs/specs/**', 'docs/prd/**', 'docs/adr/**']),
  /** array overrides the patterns; false turns detection off */
  agentInstructions: z
    .union([z.array(z.string()), z.literal(false)])
    .default(() => [...AGENT_INSTRUCTION_PATTERNS]),
  agents: z
    .record(z.enum(AGENT_NAMES as [AgentName, ...AgentName[]]), agentCfg.partial())
    .default({}),
});

export function defaultManifest(): Manifest {
  const parsed = manifestSchema.parse({});
  return finalize(parsed);
}

export function parseManifest(rawJson: string): Manifest {
  const parsed = manifestSchema.parse(JSON.parse(rawJson));
  return finalize(parsed);
}

function finalize(p: z.infer<typeof manifestSchema>): Manifest {
  const agents = {} as Manifest['agents'];
  for (const name of AGENT_NAMES) {
    const cfg = p.agents[name];
    agents[name] = { enabled: cfg?.enabled ?? true, docs: cfg?.docs ?? DEFAULT_DOCS[name] ?? [] };
  }
  return {
    preset: p.preset,
    budgetUsd: p.budgetUsd,
    maxFileChangedLines: p.maxFileChangedLines,
    maxTotalChangedLines: p.maxTotalChangedLines,
    skip: p.skip,
    specs: p.specs,
    agentInstructions: p.agentInstructions,
    agents,
  };
}
