import type { ResolvedModel } from './config.js';
import type { Llm, LlmResult } from './types.js';

export function createAnthropicClient(model: ResolvedModel, fetchImpl: typeof fetch = fetch): Llm {
  return {
    async complete(system: string, user: string): Promise<LlmResult> {
      const res = await fetchImpl(`${model.baseUrl}/messages`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-api-key': model.apiKey,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify({
          model: model.model,
          max_tokens: 4096,
          system,
          messages: [{ role: 'user', content: user }],
        }),
      });
      if (!res.ok) {
        const text = await res.text().catch(() => '');
        throw new Error(`LLM call failed (${res.status} ${res.statusText}): ${text.slice(0, 400)}`);
      }
      const data = (await res.json()) as {
        content?: { type: string; text?: string }[];
        usage?: { input_tokens?: number; output_tokens?: number };
      };
      const text = (data.content ?? [])
        .filter((b) => b.type === 'text' && typeof b.text === 'string')
        .map((b) => b.text)
        .join('\n');
      if (!text) throw new Error('LLM response has no text content');
      return {
        text,
        usage: {
          inputTokens: data.usage?.input_tokens ?? 0,
          outputTokens: data.usage?.output_tokens ?? 0,
        },
      };
    },
  };
}
