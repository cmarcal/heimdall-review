/** Rough running cost. Prices are USD per million tokens, declared in models.json. */
export class Budget {
  spentUsd = 0;
  private exceeded = false;

  constructor(private maxUsd: number) {}

  get isExceeded(): boolean {
    return this.exceeded;
  }

  record(price: { input: number; output: number } | undefined, inputTokens: number, outputTokens: number): void {
    if (!price) return; // free / local model — nothing to spend
    this.spentUsd += (inputTokens / 1e6) * price.input + (outputTokens / 1e6) * price.output;
    if (this.spentUsd > this.maxUsd) this.exceeded = true;
  }

  assertCanSpend(): void {
    if (this.exceeded) {
      throw new BudgetExceededError(`budget exhausted: $${this.spentUsd.toFixed(2)} > $${this.maxUsd}`);
    }
  }
}

export class BudgetExceededError extends Error {}
