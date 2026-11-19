import { existsSync, readFileSync } from 'node:fs';

/**
 * Minimal .env loader (no dependency). Existing process.env always wins, so
 * an explicitly exported key overrides the file. Silently ignores a missing
 * file — running without .env is a valid state.
 */
export function loadEnvFile(path = '.env'): void {
  if (!existsSync(path)) return;
  for (const rawLine of readFileSync(path, 'utf8').split('\n')) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq < 0) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (key && process.env[key] === undefined) process.env[key] = value;
  }
}
