import { z } from 'zod';
import type { AgentName, Manifest } from './types.js';
import { AGENT_NAMES } from './types.js';

const agentCfg = z.object({
  enabled: z.boolean().default(true),
  /** omitted => the agent's DEFAULT_DOCS are auto-discovered; [] => discover nothing */
  docs: z.array(z.string()).optional(),
});

/**
 * Docs every agent reads even when the repo ships no .pr-review.json.
 * The standards axis is meaningless without the repo's own written rules,
 * so the classics are discovered by name (a documented standard turns a smell
 * from judgement call into citable violation — and can also license it).
 */
export const DEFAULT_DOCS: Record<AgentName, string[]> = {
  security: [],
  requirements: [],
  'e2e-tests': [],
  architecture: [],
  regression: [],
  performance: [],
  standards: ['CONTRIBUTING.md', 'CODING_STANDARDS.md', 'AGENTS.md', 'CLAUDE.md', 'docs/standards/**'],
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
    agents,
  };
}
