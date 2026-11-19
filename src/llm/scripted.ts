import type { AgentRole, Capability } from '../lib/types.js';
import type { LlmResult, ReviewerLlm, UsedModelLike } from './types.js';

/** A canned reply keyed by what the call is asking for. */
export type ScriptedReply = string | ((system: string, user: string) => string);

export interface ScriptedModel {
  model?: string;
  capability?: Capability;
}

/**
 * Deterministic stand-in for a real model. Used by the eval harness (offline
 * mode) and unit tests so CI never needs a key or network. You script the
 * exact JSON each role returns; every finding the harness must DROP is left
 * out or given an evidenceQuote that is NOT in the fixture code — which proves
 * the pass-2 gate actually deletes.
 */
export class ScriptedLlm implements ReviewerLlm {
  readonly used = new Map<AgentRole, UsedModelLike>();
  readonly calls: { role: AgentRole; system: string; user: string }[] = [];

  constructor(
    private script: Partial<Record<AgentRole, ScriptedReply>>,
    private models: Record<string, ScriptedModel> = {},
  ) {}

  async complete(role: AgentRole, system: string, user: string): Promise<LlmResult> {
    this.calls.push({ role, system, user });
    this.used.set(role, this.describe(role));
    const reply = this.script[role];
    if (reply === undefined) throw new Error(`ScriptedLlm: no scripted reply for role "${role}"`);
    const text = reply === '@echo-groups' ? echoGroups(user) : typeof reply === 'function' ? reply(system, user) : reply;
    return { text, usage: { inputTokens: 100, outputTokens: 50 } };
  }

  describe(role: AgentRole): UsedModelLike {
    const m = this.models[role] ?? {};
    return { role, model: m.model ?? `scripted-${role}`, capability: m.capability ?? 'high' };
  }

  get usedBasicModel(): boolean {
    return [...this.used.values()].some((u) => u.capability === 'basic');
  }
}

/**
 * Echo the incoming findings back as one group each, so offline eval/tests
 * don't need to know the runtime-generated findingIds. Deterministic stand-in
 * for the consolidator LLM's merge+rewrite.
 */
function echoGroups(user: string): string {
  try {
    const parsed = JSON.parse(user) as { findings?: { id: string; title: string; file: string; line: number }[] };
    const groups = (parsed.findings ?? []).map((f) => ({
      ids: [f.id],
      comment: `**${f.title}**\n\n(${f.file}:${f.line})`,
    }));
    return JSON.stringify({ groups });
  } catch {
    return JSON.stringify({ groups: [] });
  }
}
