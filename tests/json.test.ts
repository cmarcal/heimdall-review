import { describe, it, expect } from 'vitest';
import { extractJson, completeJson } from '../src/llm/json.js';
import { candidateArraySchema } from '../src/lib/finding.js';
import type { LlmForRole, LlmResult } from '../src/llm/types.js';

class StubLlm implements LlmForRole {
  constructor(private replies: string[]) {}
  calls = 0;
  async complete(): Promise<LlmResult> {
    const text = this.replies[Math.min(this.calls, this.replies.length - 1)]!;
    this.calls++;
    return { text, usage: { inputTokens: 1, outputTokens: 1 } };
  }
}

const one = [{ file: 'a.js', line: 1, title: 'tttt', evidenceQuote: 'q', why: 'why why', suggestion: 'sugg sugg', impact: 1, certainty: 1, blastRadius: 1 }];

describe('extractJson', () => {
  it('parses raw JSON', () => expect(extractJson('[1,2]')).toEqual([1, 2]));
  it('parses fenced JSON', () => expect(extractJson('```json\n{"a":1}\n```')).toEqual({ a: 1 }));
  it('recovers JSON buried in prose', () => expect(extractJson('Here: [3,4] enjoy!')).toEqual([3, 4]));
  it('parses raw JSON that carries ``` fences inside string values', () =>
    expect(extractJson('{"comment":"problem\\n\\n```\\nreturn err\\n```\\n\\n**Fix:** wrap"}')).toEqual({
      comment: 'problem\n\n```\nreturn err\n```\n\n**Fix:** wrap',
    }));
});

describe('completeJson repair retry', () => {
  it('succeeds on first valid reply without retry', async () => {
    const res = await completeJson(new StubLlm([JSON.stringify(one)]), 'security', 's', 'u', candidateArraySchema);
    expect(res.repairUsed).toBe(false);
    expect(res.data).toHaveLength(1);
  });

  it('retries once when the first reply is not valid, then parses', async () => {
    const stub = new StubLlm(['sorry, prose not json', JSON.stringify(one)]);
    const res = await completeJson(stub, 'security', 's', 'u', candidateArraySchema);
    expect(res.repairUsed).toBe(true);
    expect(res.data).toHaveLength(1);
    expect(stub.calls).toBe(2);
  });

  it('gives up (throws) rather than guessing when both attempts fail', async () => {
    const stub = new StubLlm(['nope', 'still nope']);
    await expect(completeJson(stub, 'security', 's', 'u', candidateArraySchema)).rejects.toThrow();
  });
});
