import { describe, it, expect } from 'vitest';
import { Budget, BudgetExceededError } from '../src/llm/budget.js';

describe('budget', () => {
  it('tracks spend from per-model token prices', () => {
    const b = new Budget(5);
    b.record({ input: 3, output: 15 }, 1_000_000, 500_000); // $3 + $7.5
    expect(b.spentUsd).toBeCloseTo(10.5, 5);
    expect(b.isExceeded).toBe(true);
  });

  it('free/local models (no price) never trip the budget', () => {
    const b = new Budget(1);
    b.record(undefined, 10_000_000, 10_000_000);
    expect(b.isExceeded).toBe(false);
    expect(() => b.assertCanSpend()).not.toThrow();
  });

  it('refuses to start a new call once exceeded', () => {
    const b = new Budget(1);
    b.record({ input: 100, output: 100 }, 1_000_000, 1_000_000);
    expect(() => b.assertCanSpend()).toThrow(BudgetExceededError);
  });
});
