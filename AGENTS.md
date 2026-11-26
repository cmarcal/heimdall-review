# AGENTS.md

Guidance for AI coding agents and contributors working in this repo.

Heimdall is a multi-agent GitHub PR reviewer. Seven specialists each run a find
pass and a verify pass, and a finding only ships if a deterministic harness can
quote it from the real code.

## Commands

- `npm test` - run the vitest suite in `tests/`.
- `npm run typecheck` - `tsc --noEmit`. Build is `npm run build`.
- `npm run heimdall -- eval` - offline eval, no key, deterministic. It must stay
  at recall 5/5, precision 100%, 0 hallucinations posted.
- `npm run heimdall -- review <pr> --repo owner/repo` - review a PR. Dry-run is
  the default and posts nothing; add `--post` to publish.
- `npm run install-skill` / `npm run uninstall-skill` - link the `/heimdall-review`
  agent skill into `~/.claude/skills` and `~/.agents/skills`.

Node 22+ and an authenticated `gh` are required. `npm run heimdall -- doctor`
checks the model config before you trust a run.

## Architecture

The flow is: `src/cli.ts` -> a source (`src/sources/github.ts` or
`src/sources/fixture.ts`) builds one `ReviewContext` -> `src/lib/orchestrator.ts`
runs it -> `src/agents/base.ts` (`runAgent`) packs the context (`src/agents/prompt.ts`)
and enforces the quote gate -> `src/agents/consolidator.ts` merges and rewrites ->
`src/lib/post.ts` publishes.

The shared brain is `prompts/*.md` and `config/scoring.json`. `src/lib/manifest.ts`
parses a repo's `.pr-review.json` and holds the discovery defaults (skip globs,
spec globs, `AGENT_INSTRUCTION_PATTERNS`, `MIGRATION_GLOBS`). When the diff's SQL
names tables, the source fetches the migrations naming them as schema facts
(`src/lib/schema.ts`) — a constraint claim must cite them or post as a question.

## Hard rules

- The CLI and the agent skill must stay in parity. The skill
  (`skills/heimdall-review/`) mirrors CLI behavior in plain Node scripts and reads
  the same `prompts/`. Any behavior change lands in both.
- Prefer a deterministic harness gate over trusting the model. A finding survives
  only when its `verifiedEvidence` appears verbatim in the head file content. The
  harness checks this, not the model.
- A finding needs a real quote. No quote, no finding.
- The quote gate proves the problem, never the fix. Evidence is gated deterministically; `suggestion` is not, and authors paste it verbatim — so prompts require a fix to be provably correct from the provided code or phrased as a direction, never an unverified command. A fix that reaches files the diff did not touch is phrased as a follow-up.
- Nothing posts to GitHub without `--post` (CLI) or explicit confirmation (skill).
  Dry-run is the default state.
- Declared coverage beats fake coverage. Failed specialists, dropped findings, and
  files cut by caps are always reported, never hidden.
- Prose is American English, plain and specific. Do not put a severity word in a
  comment body; the harness adds the tier prefix.
