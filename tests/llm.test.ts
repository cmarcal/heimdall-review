import { describe, it, expect, vi } from 'vitest';
import { createOpenAiCompatibleClient } from '../src/llm/openai-compatible.js';
import { createAnthropicClient } from '../src/llm/anthropic.js';
import type { ResolvedModel } from '../src/llm/config.js';

const base: ResolvedModel = {
  role: 'security', provider: 'openai-compatible', baseUrl: 'https://x.test', apiKey: 'k',
  model: 'm', capability: 'high', jsonMode: 'prompt',
};

function stubFetch(payload: unknown, captured?: { url?: string; init?: RequestInit }) {
  return vi.fn(async (url: string, init: RequestInit) => {
    if (captured) {
      captured.url = url;
      captured.init = init;
    }
    return { ok: true, status: 200, statusText: 'OK', json: async () => payload, text: async () => '' } as Response;
  }) as unknown as typeof fetch;
}

describe('openai-compatible adapter', () => {
  it('posts chat messages and reads content + usage', async () => {
    const cap: { url?: string; init?: RequestInit } = {};
    const client = createOpenAiCompatibleClient(base, stubFetch(
      { choices: [{ message: { content: '[]' } }], usage: { prompt_tokens: 5, completion_tokens: 2 } },
      cap,
    ));
    const res = await client.complete('sys', 'usr');
    expect(res.text).toBe('[]');
    expect(res.usage).toEqual({ inputTokens: 5, outputTokens: 2 });
    expect(cap.url).toBe('https://x.test/chat/completions');
    const body = JSON.parse(String(cap.init?.body));
    expect(body.model).toBe('m');
    expect(body.messages).toEqual([
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'usr' },
    ]);
    expect(String((cap.init?.headers as Record<string, string>).authorization)).toContain('Bearer k');
  });

  it('adds response_format only when the preset declares response_format mode', async () => {
    const cap: { init?: RequestInit } = {};
    const client = createOpenAiCompatibleClient({ ...base, jsonMode: 'response_format' }, stubFetch({ choices: [{ message: { content: '[]' } }] }, cap));
    await client.complete('s', 'u');
    expect(JSON.parse(String(cap.init?.body)).response_format).toEqual({ type: 'json_object' });
  });
});

describe('anthropic adapter', () => {
  it('posts messages and joins text blocks', async () => {
    const cap: { url?: string; init?: RequestInit } = {};
    const client = createAnthropicClient({ ...base, provider: 'anthropic' }, stubFetch(
      { content: [{ type: 'text', text: 'Hello' }], usage: { input_tokens: 3, output_tokens: 1 } },
      cap,
    ));
    const res = await client.complete('sys', 'usr');
    expect(res.text).toBe('Hello');
    expect(res.usage).toEqual({ inputTokens: 3, outputTokens: 1 });
    expect(cap.url).toBe('https://x.test/messages');
    expect((cap.init?.headers as Record<string, string>)['x-api-key']).toBe('k');
  });
});
