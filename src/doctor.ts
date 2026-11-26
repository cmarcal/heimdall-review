import { readFileSync } from 'node:fs';
import path from 'node:path';
import { CONFIG_DIR } from './lib/paths.js';
import { DEFAULT_TEACH_BELOW, DEFAULT_TEACH_MAX_SCORE } from './lib/scoring.js';
import { loadModelsConfig, resolveModel } from './llm/config.js';
import { createOpenAiCompatibleClient } from './llm/openai-compatible.js';
import { createAnthropicClient } from './llm/anthropic.js';
import type { AgentRole, Capability } from './lib/types.js';

const ROLES: AgentRole[] = [
  'security',
  'requirements',
  'e2e-tests',
  'architecture',
  'regression',
  'performance',
  'standards',
  'verifier',
  'consolidator',
  'teach',
  'gap-check',
];

const PROBE_SYSTEM = 'You are a JSON compliance probe. Reply with ONLY this JSON array and nothing else: [{"ok":true}]';
const PROBE_USER = 'Return the JSON array now.';

/**
 * Honesty check for the declared model tier. Runs a tiny JSON-compliance and
 * latency probe against every distinct model in the active preset and warns
 * when a model declared "high" behaves like "basic". Never blocks — it informs.
 */
export async function runDoctor(presetOverride?: string): Promise<void> {
  const cfg = loadModelsConfig(path.join(CONFIG_DIR, 'models.json'));
  if (presetOverride) cfg.preset = presetOverride;
  const preset = cfg.presets[cfg.preset]!;
  process.stdout.write(`preset: ${cfg.preset}  provider: ${preset.provider}  baseUrl: ${preset.baseUrl}\n`);

  const missingKey = preset.keyEnv && !process.env[preset.keyEnv] && !preset.staticKey && !process.env.HEIMDALL_LLM_API_KEY;
  if (missingKey) {
    process.stdout.write(`⚠️  ${preset.keyEnv} is not set — calls will fail until you export it or run heimdall with --env-file.\n`);
  }

  // Probe each distinct model once, not once per role.
  const seen = new Map<string, { capability: Capability; roles: AgentRole[] }>();
  for (const role of ROLES) {
    const def = preset.agents[role];
    if (!def) continue;
    const rec = seen.get(def.model) ?? { capability: def.capability, roles: [] };
    rec.roles.push(role);
    seen.set(def.model, rec);
  }

  for (const [model, rec] of seen) {
    const resolved = resolveModel(cfg, rec.roles[0]!);
    resolved.model = model;
    const client =
      resolved.provider === 'anthropic' ? createAnthropicClient(resolved) : createOpenAiCompatibleClient(resolved);
    const t0 = Date.now();
    let verdict = '';
    try {
      const res = await client.complete(PROBE_SYSTEM, PROBE_USER);
      const ms = Date.now() - t0;
      const ok = /\[\s*\{\s*"ok"\s*:\s*true\s*\}\s*\]/.test(res.text);
      verdict = ok ? `JSON probe OK in ${ms}ms` : `WEAK JSON compliance (did not return the exact array) — ${ms}ms`;
      if (rec.capability === 'high' && !ok) {
        verdict += '  ← declared "high" but failed the probe; expect to drop precision/recall. Re-declare in config/models.json if honest.';
      }
    } catch (err) {
      verdict = `FAILED: ${(err as Error).message.slice(0, 120)}`;
    }
    process.stdout.write(`  ${rec.capability.padEnd(9)} ${model.padEnd(42)} ${verdict}\n`);
  }

  if ([...seen.values()].some((v) => v.capability === 'basic')) {
    process.stdout.write('\nNote: a basic-capability model is in use. Heimdall will disclose this in the PR summary and recommend a human pass on flagged files.\n');
  }
}

export function describeScoring(): void {
  const cfg = JSON.parse(readFileSync(path.join(CONFIG_DIR, 'scoring.json'), 'utf8')) as {
    weights: Record<string, number>;
    tiers: { id: string; min: number }[];
    teach?: { below?: number; maxScore?: number };
  };
  process.stdout.write(`scoring weights: ${JSON.stringify(cfg.weights)}\n`);
  for (const t of [...cfg.tiers].sort((a, b) => b.min - a.min)) {
    process.stdout.write(`  ${t.id.padEnd(8)} score >= ${t.min}\n`);
  }
  // The teaching bar is calibrated against this same map, so it is printed with
  // it — as a share of the maximum, which is what keeps its meaning after a
  // recalibration.
  const below = cfg.teach?.below ?? DEFAULT_TEACH_BELOW;
  const maxScore = cfg.teach?.maxScore ?? DEFAULT_TEACH_MAX_SCORE;
  process.stdout.write(
    `teach bar    ${below}/${maxScore}  (--teach explains findings under it: prose only, no score or tier moves)\n`,
  );
}
