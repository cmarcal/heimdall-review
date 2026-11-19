import type { ResolvedModel } from './config.js';
import type { Llm, LlmResult } from './types.js';

/**
 * One client for every provider that speaks the OpenAI wire format:
 * OpenRouter, Groq, Together, Mistral, GitHub Models, Ollama (/v1), LM Studio, OpenAI.
 */
export function createOpenAiCompatibleClient(model: ResolvedModel, fetchImpl: typeof fetch = fetch): Llm {
  return {
    async complete(system: string, user: string): Promise<LlmResult> {
      const body: Record<string, unknown> = {
        model: model.model,
        temperature: 0,
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: user },
        ],
      };
      if (model.jsonMode === 'response_format') {
        body.response_format = { type: 'json_object' };
      }
      const res = await fetchImpl(`${model.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${model.apiKey}`,
        },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const text = await res.text().catch(() => '');
        throw new Error(`LLM call failed (${res.status} ${res.statusText}): ${text.slice(0, 400)}`);
      }
      const data = (await res.json()) as {
        choices?: { message?: { content?: string } }[];
        usage?: { prompt_tokens?: number; completion_tokens?: number };
      };
      const text = data.choices?.[0]?.message?.content;
      if (typeof text !== 'string') throw new Error('LLM response has no message content');
      return {
        text,
        usage: {
          inputTokens: data.usage?.prompt_tokens ?? 0,
          outputTokens: data.usage?.completion_tokens ?? 0,
        },
      };
    },
  };
}
