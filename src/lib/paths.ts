import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));

/** Repo/package root — works from src/ (tsx) and dist/ (built) alike. */
export const PKG_ROOT = path.resolve(here, '..', '..');
export const CONFIG_DIR = path.join(PKG_ROOT, 'config');
export const PROMPTS_DIR = path.join(PKG_ROOT, 'prompts');
