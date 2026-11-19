import { resolveModel, type ModelsConfig } from './config.js';
import { createOpenAiCompatibleClient } from './openai-compatible.js';
import { createAnthropicClient } from './anthropic.js';
import type { AgentRole, Capability } from '../lib/types.js';
import type { Llm, LlmResult, ReviewerLlm } from './types.js';
import { Budget, BudgetExceededError } from './budget.js';

export interface UsedModel {
  role: AgentRole;
  model: string;
  capability: Capability;
}

export class RoleLlm implements ReviewerLlm {
  private cache = new Map<AgentRole, Llm>();
  readonly used = new Map<AgentRole, UsedModel>();

  constructor(
    private cfg: ModelsConfig,
    private budget: Budget,
    private fetchImpl: typeof fetch = fetch,
  ) {}

  getClient(role: AgentRole): Llm {
    const cached = this.cache.get(role);
    if (cached) return cached;
    const resolved = resolveModel(this.cfg, role);
    const client =
      resolved.provider === 'anthropic'
        ? createAnthropicClient(resolved, this.fetchImpl)
        : createOpenAiCompatibleClient(resolved, this.fetchImpl);
    this.cache.set(role, client);
    this.used.set(role, { role, model: resolved.model, capability: resolved.capability });
    // stash price so complete() can charge the budget without re-resolving
    this.prices.set(role, resolved.pricePerMTok);
    return client;
  }

  private prices = new Map<AgentRole, { input: number; output: number } | undefined>();

  async complete(role: AgentRole, system: string, user: string): Promise<LlmResult> {
    this.budget.assertCanSpend();
    const result = await this.getClient(role).complete(system, user);
    this.budget.record(this.prices.get(role), result.usage.inputTokens, result.usage.outputTokens);
    return result;
  }

  get usedBasicModel(): boolean {
    return [...this.used.values()].some((u) => u.capability === 'basic');
  }

  /** Declared model info without opening a client (for budgeting pack size). */
  describe(role: AgentRole): UsedModel {
    const r = resolveModel(this.cfg, role);
    return { role, model: r.model, capability: r.capability };
  }
}

export { Budget, BudgetExceededError };
