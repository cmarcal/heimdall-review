import { describe, it, expect } from 'vitest';
import { AGENT_INSTRUCTION_PATTERNS, MIGRATION_GLOBS, defaultManifest, parseManifest } from '../src/lib/manifest.js';

// The agent-instructions axis: a repo's own AI-tool rule files (AGENTS.md,
// CLAUDE.md, GEMINI.md, Copilot/Cursor/Qodo config, nested variants) are
// detected for every specialist through one manifest key.

describe('agentInstructions manifest key', () => {
  it('carries the convention patterns by default', () => {
    const m = defaultManifest();
    expect(m.agentInstructions).toEqual(AGENT_INSTRUCTION_PATTERNS);
    for (const p of [
      'AGENTS.md',
      'CLAUDE.md',
      'GEMINI.md',
      '.github/copilot-instructions.md',
      '.cursorrules',
      '.cursor/rules/**',
      '.qodo/agents/**',
      '**/AGENTS.md',
      '**/CLAUDE.md',
    ]) {
      expect(AGENT_INSTRUCTION_PATTERNS).toContain(p);
    }
  });

  it('false disables detection', () => {
    const m = parseManifest(JSON.stringify({ agentInstructions: false }));
    expect(m.agentInstructions).toBe(false);
  });

  it('a custom array replaces the defaults', () => {
    const m = parseManifest(JSON.stringify({ agentInstructions: ['RULES.md'] }));
    expect(m.agentInstructions).toEqual(['RULES.md']);
  });

  it('gives each default parse its own array (no shared mutable default)', () => {
    const a = defaultManifest();
    const b = defaultManifest();
    expect(a.agentInstructions).not.toBe(b.agentInstructions);
  });

  it('leaves the other manifest keys untouched', () => {
    const m = parseManifest(JSON.stringify({ budgetUsd: 9 }));
    expect(m.budgetUsd).toBe(9);
    expect(m.skip.length).toBeGreaterThan(0);
    expect(m.agents.security.enabled).toBe(true);
  });
});

describe('standards DEFAULT_DOCS no longer overlaps the instruction section', () => {
  it('keeps the classic standards docs but drops AGENTS.md/CLAUDE.md', () => {
    const docs = defaultManifest().agents.standards.docs;
    expect(docs).toEqual(
      expect.arrayContaining(['CONTRIBUTING.md', 'CODING_STANDARDS.md', 'docs/standards/**']),
    );
    expect(docs).not.toContain('AGENTS.md');
    expect(docs).not.toContain('CLAUDE.md');
  });
});

// The migrations axis: when the diff's SQL names a table, migrations naming
// that table are fetched as schema facts, so a constraint claim must cite them
// or degrade to a question (see src/lib/schema.ts).
describe('migrations manifest key', () => {
  it('defaults to the migration-dir globs', () => {
    expect(defaultManifest().migrations).toEqual(MIGRATION_GLOBS);
  });

  it('is overridable by the repo', () => {
    const m = parseManifest(JSON.stringify({ migrations: ['sql/migrations/**'] }));
    expect(m.migrations).toEqual(['sql/migrations/**']);
  });
});
