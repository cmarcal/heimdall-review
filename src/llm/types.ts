import type { AgentRole, Capability } from '../lib/types.js';

export interface LlmUsage {
  inputTokens: number;
  outputTokens: number;
}

export interface LlmResult {
  text: string;
  usage: LlmUsage;
}

/** The only interface the rest of the harness knows about. */
export interface Llm {
  complete(system: string, user: string): Promise<LlmResult>;
}

export interface LlmForRole {
  complete(role: AgentRole, system: string, user: string): Promise<LlmResult>;
}

export interface UsedModelLike {
  role: AgentRole;
  model: string;
  capability: Capability;
}

/** The surface the orchestrator needs: role routing + usage reporting. */
export interface ReviewerLlm extends LlmForRole {
  describe(role: AgentRole): UsedModelLike;
  readonly used: Map<AgentRole, UsedModelLike>;
  readonly usedBasicModel: boolean;
}
