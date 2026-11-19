import { describe, it, expect } from 'vitest';
import { consolidate } from '../src/agents/consolidator.js';
import type { LlmForRole } from '../src/llm/types.js';
import type { VerifiedFinding } from '../src/lib/types.js';

const finding = (over: Partial<VerifiedFinding> = {}): VerifiedFinding => ({
  findingId: 'f1', agent: 'security', mergedAgents: ['security'], file: 'a.go', line: 10,
  title: 't', verifiedEvidence: 'return err', why: 'swallows the error', suggestion: 'wrap it',
  status: 'keep', impact: 5, certainty: 5, blastRadius: 5, score: 15, tier: 'minor', ...over,
});

const llmReplies = (...replies: string[]): LlmForRole => {
  let i = 0;
  return {
    complete: async () => ({
      text: replies[Math.min(i++, replies.length - 1)],
      usage: { inputTokens: 0, outputTokens: 0 },
    }),
  };
};

const json = (comment: string) => JSON.stringify({ groups: [{ ids: ['f1'], comment }] });
const overBudget = `problem ${'word '.repeat(100)} end`;

describe('consolidate prose-budget gate', () => {
  it('accepts a comment within budget', async () => {
    const logs: string[] = [];
    const res = await consolidate([finding()], llmReplies(json('**Problem.**\n\n```\nreturn err\n```\n\n**Fix:** wrap it.')), (m) => logs.push(m));
    expect(res[0]?.comment).toContain('**Problem.**');
    expect(logs.join()).not.toMatch('rewrite');
  });

  it('rewrites once when over budget and keeps the shorter reply', async () => {
    const logs: string[] = [];
    const res = await consolidate([finding()], llmReplies(json(overBudget), json('short and fenced')), (m) => logs.push(m));
    expect(res[0]?.comment).toBe('short and fenced');
    expect(logs.join(' | ')).toMatch('rewrite');
  });

  it('degrades to the deterministic comment when the rewrite is also over budget', async () => {
    const logs: string[] = [];
    const res = await consolidate([finding()], llmReplies(json(overBudget), json(overBudget)), (m) => logs.push(m));
    expect(res[0]?.comment).toContain('```\nreturn err\n```');
    expect(res[0]?.comment).toContain('**Fix:** wrap it');
    expect(logs.join(' | ')).toMatch('deterministic');
  });
});
