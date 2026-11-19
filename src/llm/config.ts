import { readFileSync } from 'node:fs';
import type { AgentRole, Capability } from '../lib/types.js';

export interface ModelDef {
  model: string;
  capability: Capability;
  pricePerMTok?: { input: number; output: number };
}

export interface PresetDef {
  provider: 'openai-compatible' | 'anthropic';
  baseUrl: string;
  keyEnv: string | null;
  staticKey?: string;
  jsonMode: 'prompt' | 'response_format';
  agents: Record<AgentRole, ModelDef>;
}

export interface ModelsConfig {
  preset: string;
  presets: Record<string, PresetDef>;
}

export function loadModelsConfig(path: string): ModelsConfig {
  const raw = JSON.parse(readFileSync(path, 'utf8')) as ModelsConfig;
  const fromEnv = process.env.HEIMDALL_PRESET;
  if (fromEnv) raw.preset = fromEnv;
  if (!raw.presets[raw.preset]) {
    throw new Error(`Preset "${raw.preset}" not found in ${path}`);
  }
  return raw;
}

/** Resolved connection info for one agent role. */
export interface ResolvedModel {
  role: AgentRole;
  provider: PresetDef['provider'];
  baseUrl: string;
  apiKey: string;
  model: string;
  capability: Capability;
  jsonMode: 'prompt' | 'response_format';
  pricePerMTok?: { input: number; output: number };
}

export function resolveModel(cfg: ModelsConfig, role: AgentRole): ResolvedModel {
  const preset = cfg.presets[cfg.preset];
  if (!preset) throw new Error(`Preset "${cfg.preset}" missing`);
  const def = preset.agents[role];
  if (!def) throw new Error(`Role "${role}" missing from preset "${cfg.preset}"`);

  let apiKey = '';
  if (preset.staticKey) apiKey = preset.staticKey;
  else if (preset.keyEnv) apiKey = process.env[preset.keyEnv] ?? '';

  // Global overrides win (proxies / gateways / self-hosted OpenAI-compat).
  const baseUrl = process.env.HEIMDALL_LLM_BASE_URL || preset.baseUrl;
  const keyOverride = process.env.HEIMDALL_LLM_API_KEY;
  if (keyOverride) apiKey = keyOverride;

  return {
    role,
    provider: preset.provider,
    baseUrl: baseUrl.replace(/\/$/, ''),
    apiKey,
    model: def.model,
    capability: def.capability,
    jsonMode: preset.jsonMode,
    pricePerMTok: def.pricePerMTok,
  };
}
