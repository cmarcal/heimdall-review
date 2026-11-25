import { describe, it, expect } from 'vitest';
import {
  INSTRUCTIONS_BUDGET_CHARS,
  INSTRUCTIONS_MAX_FILES,
  assembleAgentInstructions,
  selectAgentInstructionPaths,
} from '../src/lib/instructions.js';
import { AGENT_INSTRUCTION_PATTERNS, defaultManifest } from '../src/lib/manifest.js';

// Convention detection: which repo files count as agent instructions, in what
// order, and how the per-file / total caps bite. Unit over a fake tree — no gh.

const skipWithNodeModules = [...defaultManifest().skip, 'node_modules/**'];

describe('selectAgentInstructionPaths', () => {
  it('matches root, nested and tool-specific instruction files', () => {
    const tree = [
      'AGENTS.md',
      'packages/x/AGENTS.md',
      '.cursor/rules/style.mdc',
      '.github/copilot-instructions.md',
      '.qodo/agents/reviewer.md',
      'README.md',
      'src/index.ts',
    ];
    const got = selectAgentInstructionPaths(tree, AGENT_INSTRUCTION_PATTERNS, []);
    expect(got).toEqual(
      expect.arrayContaining([
        'AGENTS.md',
        'packages/x/AGENTS.md',
        '.cursor/rules/style.mdc',
        '.github/copilot-instructions.md',
        '.qodo/agents/reviewer.md',
      ]),
    );
    expect(got).not.toContain('README.md');
    expect(got).not.toContain('src/index.ts');
  });

  it('drops files a skip glob catches (node_modules, dist)', () => {
    const tree = [
      'AGENTS.md',
      'node_modules/foo/AGENTS.md',
      'dist/AGENTS.md',
    ];
    const got = selectAgentInstructionPaths(tree, AGENT_INSTRUCTION_PATTERNS, skipWithNodeModules);
    expect(got).toEqual(['AGENTS.md']);
  });

  it('dedupes a file matched by both a root and a nested pattern', () => {
    const got = selectAgentInstructionPaths(['AGENTS.md'], AGENT_INSTRUCTION_PATTERNS, []);
    expect(got).toEqual(['AGENTS.md']);
  });

  it('orders root-level first, then nested, alphabetical within each group', () => {
    const tree = ['b/AGENTS.md', 'a/CLAUDE.md', 'z.md', 'CLAUDE.md', 'AGENTS.md'];
    const got = selectAgentInstructionPaths(tree, AGENT_INSTRUCTION_PATTERNS, []);
    expect(got).toEqual(['AGENTS.md', 'CLAUDE.md', 'a/CLAUDE.md', 'b/AGENTS.md']);
  });

  it('caps selection at the max file count', () => {
    const tree = Array.from({ length: 20 }, (_, i) => `pkg${i}/AGENTS.md`);
    const got = selectAgentInstructionPaths(tree, AGENT_INSTRUCTION_PATTERNS, []);
    expect(got).toHaveLength(INSTRUCTIONS_MAX_FILES);
  });

  it('returns nothing when no path matches', () => {
    expect(selectAgentInstructionPaths(['README.md'], AGENT_INSTRUCTION_PATTERNS, [])).toEqual([]);
  });
});

describe('assembleAgentInstructions', () => {
  const reader = (contents: Record<string, string>) => async (p: string) => contents[p] ?? null;

  it('reads each selected file and returns it in order', async () => {
    const got = await assembleAgentInstructions(
      ['AGENTS.md', 'a/AGENTS.md'],
      reader({ 'AGENTS.md': 'root rules', 'a/AGENTS.md': 'nested rules' }),
    );
    expect(got).toEqual([
      { path: 'AGENTS.md', content: 'root rules' },
      { path: 'a/AGENTS.md', content: 'nested rules' },
    ]);
  });

  it('skips a file whose read returns null', async () => {
    const got = await assembleAgentInstructions(['AGENTS.md', 'x/AGENTS.md'], reader({ 'AGENTS.md': 'r' }));
    expect(got.map((f) => f.path)).toEqual(['AGENTS.md']);
  });

  it('applies the 12k per-file cap', async () => {
    const big = 'x'.repeat(20_000);
    const got = await assembleAgentInstructions(['AGENTS.md'], reader({ 'AGENTS.md': big }));
    expect(got[0]!.content.length).toBeLessThan(20_000);
    expect(got[0]!.content).toContain('truncated');
  });

  it('drops later files once the total char budget runs out, in order', async () => {
    const file = 'y'.repeat(10_000);
    const paths = ['a.md', 'b.md', 'c.md', 'd.md', 'e.md'];
    const contents = Object.fromEntries(paths.map((p) => [p, file]));
    const got = await assembleAgentInstructions(paths, reader(contents));
    const total = got.reduce((s, f) => s + f.content.length, 0);
    expect(got.length).toBeLessThan(paths.length);
    expect(total).toBeLessThanOrEqual(INSTRUCTIONS_BUDGET_CHARS);
    // the survivors are the deterministic prefix, never a later one out of order
    expect(got.map((f) => f.path)).toEqual(paths.slice(0, got.length));
  });

  it('is empty when no paths were selected', async () => {
    expect(await assembleAgentInstructions([], reader({}))).toEqual([]);
  });
});
