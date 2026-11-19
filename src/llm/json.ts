import type { z } from 'zod';
import type { LlmForRole } from './types.js';
import type { AgentRole } from '../lib/types.js';

/** Pull a JSON value out of an LLM reply: raw, fenced, or buried in prose. */
export function extractJson(text: string): unknown {
  const trimmed = text.trim();
  const fence = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/)?.[1];
  // Raw first: a valid reply may legitimately carry ``` fences INSIDE strings
  // (e.g. a consolidator comment with fenced evidence). The fence regex would
  // tear it apart.
  const candidates = fence === undefined ? [trimmed] : [trimmed, fence];
  for (const candidate of candidates) {
    try {
      return JSON.parse(candidate);
    } catch {
      /* next candidate */
    }
  }
  for (const candidate of candidates) {
    const startArr = candidate.indexOf('[');
    const startObj = candidate.indexOf('{');
    let start = -1;
    let close = '';
    if (startArr >= 0 && (startObj < 0 || startArr < startObj)) {
      start = startArr;
      close = ']';
    } else if (startObj >= 0) {
      start = startObj;
      close = '}';
    }
    const end = candidate.lastIndexOf(close);
    if (start >= 0 && end > start) {
      try {
        return JSON.parse(candidate.slice(start, end + 1));
      } catch {
        /* next candidate */
      }
    }
  }
  throw new Error('no JSON found in LLM reply');
}

export interface JsonCall<T> {
  data: T;
  raw: string;
  repairUsed: boolean;
}

/**
 * Strict-JSON call with ONE repair retry: weak models drift (prose, fences,
 * trailing commas). Second chance, and if it still fails we declare the
 * failure — never guess.
 */
export async function completeJson<T>(
  llm: LlmForRole,
  role: AgentRole,
  system: string,
  user: string,
  schema: z.ZodType<T>,
): Promise<JsonCall<T>> {
  const first = await llm.complete(role, system, user);
  const attempt = (raw: string): T => schema.parse(extractJson(raw));
  try {
    return { data: attempt(first.text), raw: first.text, repairUsed: false };
  } catch (err) {
    const repairUser =
      `${user}\n\n---\nYour previous reply was not valid for this contract: ${(err as Error).message.slice(0, 300)}\n` +
      'Reply again with ONLY the JSON, no prose, no markdown fences.';
    const second = await llm.complete(role, system, repairUser);
    return { data: attempt(second.text), raw: second.text, repairUsed: true };
  }
}
