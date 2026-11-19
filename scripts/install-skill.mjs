#!/usr/bin/env node
/**
 * Link the heimdall-review skill into your agent tools. One source of truth
 * stays in this repo; the tools get symlinks. Re-run any time (it updates).
 *
 * usage: install-skill.mjs [--claude] [--agents] [--force] [--uninstall]
 *   --claude   ~/.claude/skills/heimdall-review   (Claude Code)
 *   --agents   ~/.agents/skills/heimdall-review   (opencode + multi-agent standard)
 *   default: both. --force replaces a non-symlink directory. --uninstall removes links.
 */
import { existsSync, lstatSync, mkdirSync, rmSync, symlinkSync, realpathSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const [,, ...argv] = process.argv;
const flag = (f) => argv.includes(`--${f}`);
const SKILL = path.resolve(path.dirname(realpathSync(fileURLToPath(import.meta.url))), '..', 'skills', 'heimdall-review');
if (!existsSync(path.join(SKILL, 'SKILL.md'))) {
  console.error(`skill not found at ${SKILL}`);
  process.exit(1);
}

const targets = [];
if (flag('claude') || (!flag('claude') && !flag('agents'))) targets.push(path.join(os.homedir(), '.claude', 'skills', 'heimdall-review'));
if (flag('agents') || (!flag('claude') && !flag('agents'))) targets.push(path.join(os.homedir(), '.agents', 'skills', 'heimdall-review'));

for (const target of targets) {
  if (flag('uninstall')) {
    if (existsSync(target) || isLink(target)) {
      rmSync(target, { recursive: true, force: true });
      console.log(`removed  ${target}`);
    } else console.log(`nothing  ${target}`);
    continue;
  }
  mkdirSync(path.dirname(target), { recursive: true });
  const existing = isLink(target) ? 'link' : existsSync(target) ? 'dir' : null;
  if (existing === 'link') {
    rmSync(target, { force: true });
  } else if (existing === 'dir') {
    if (!flag('force')) {
      console.log(`SKIP     ${target} — a real directory is there; use --force to replace it`);
      continue;
    }
    rmSync(target, { recursive: true, force: true });
  }
  symlinkSync(SKILL, target, 'junction');
  console.log(`linked   ${target}  ->  ${SKILL}`);
}

function isLink(p) {
  try {
    return lstatSync(p).isSymbolicLink();
  } catch {
    return false;
  }
}
