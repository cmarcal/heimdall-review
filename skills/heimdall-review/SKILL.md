---
name: heimdall-review
description: >
  Multi-agent GitHub PR review with evidence-backed findings. Use when the user
  invokes /heimdall-review <PR link or number> (or asks to "review this PR with
  heimdall"): fetches the PR via gh, runs 7 specialist agents (security, requirements,
  e2e-tests, architecture, regression, performance, standards), each with a mandatory second
  verification pass — a finding only survives if its evidence quote actually exists
  in the code. Dry-run first; publishes nothing without explicit user confirmation.
---

# Heimdall review (agent-native)

You are the **orchestrator**. The seven specialists and the verifier run as
subagents; you stay deterministic glue: fetch, delegate, verify with scripts,
report. You do not review the code yourself and you never vouch for a finding
whose quote the harness script did not confirm.

## Paths

- `SKILL_DIR` — the directory containing this file (resolve symlinks).
- `HEIMDALL_ROOT` = `SKILL_DIR/../..` — the heimdall repo. All the shared brain
  lives here: `$HEIMDALL_ROOT/prompts/*.md` and `config/scoring.json`.

## Hard rules (the project's constitution — apply them to yourself)

1. **Quote or it dies.** Only findings listed in a `*.final.json` produced by
   `verify-findings.mjs` may appear in the report or be posted. Never re-add a
   dropped finding, never rewrite a quote.
2. **Declared coverage beats fake coverage.** A subagent that fails is reported
   as `failed`, files cut by caps are listed, a missing ticket is stated —
   nothing is hidden or invented.
3. **The ticket is truth, the PR description is a claim.** If no linked issue
   was found, say "requirements unverified". Never invent requirements.
4. **Numbers stay private.** Sub-scores and score totals appear in the chat
   report only (the developer is you) — they must NEVER appear in anything
   posted to GitHub. Only the tier icon/label is public.
5. **Nothing is posted without explicit confirmation** in this chat ("post it",
   "publish", "yes"). Dry-run is the default state.
6. **Respect humans.** Do not reply on resolved threads, do not duplicate an
   existing human OR bot comment (Copilot, other review bots) on the same lines
   — reference it instead: a third identical opinion on a line already flagged
   twice is noise that costs credibility, even when it is right. The posting
   script also enforces self-dedupe; do not bypass it.

## Step 0 — parse the target

From the user's message take the PR link `https://github.com/<owner>/<repo>/pull/<n>`
(or a bare number → derive the repo with `gh repo view --json nameWithOwner -q .nameWithOwner`).
Set `REPO=owner/repo`, `PR=<n>`, and `WORK=/tmp/heimdall-<owner>-<repo>-<pr>-<pid>`.

## Step 1 — fetch context (deterministic script)

```bash
node "$SKILL_DIR/scripts/fetch-context.mjs" "$REPO" "$PR" "$WORK"
```

It writes: `pr.json`, `diff.patch`, `files.json` (changed files + caps),
`skipped.json` (cut files), `files/<path>` (head content), `comments.json`
(+ `threadsTrusted`), `ticket.json`, `specs.json`, `manifest.json`,
`instructions.json` (the repo's own agent-instruction files: AGENTS.md, Cursor
rules, ...), `docs/<agent>.json`. Read `pr.json`, `files.json`, `skipped.json`,
`ticket.json` before continuing. If the script fails, stop and report — do not
hand-fetch with ad-hoc gh calls.

## Step 2 — seven specialists, pass 1 (subagents, in parallel if supported)

For each enabled agent (`manifest.json` `agents[name].enabled`, default all seven:
`security requirements e2e-tests architecture regression performance standards`), spawn a
subagent with exactly this brief (fill the paths):

> You are the **<agent>** specialist in a multi-agent PR review.
> Read these files and follow them as your instructions:
> - `$HEIMDALL_ROOT/prompts/style.md`
> - `$HEIMDALL_ROOT/prompts/agent-<agent>.md`
> - `$HEIMDALL_ROOT/prompts/contract-pass1.md`
> Context to review:
> - PR: `$WORK/pr.json`
> - Ticket (or the "unverified" note): `$WORK/ticket.json`
> - Specs: `$WORK/specs.json` · your repo docs: `$WORK/docs/<agent>.json`
> - Repo agent instructions (citable standards): `$WORK/instructions.json`
> - Existing PR comments (do not repeat them): `$WORK/comments.json`
> - The diff: `$WORK/diff.patch`; full head content per file in `$WORK/files/`
> - Only these files are in scope: <list from files.json>
> Report ONLY findings inside your specialty, introduced by this diff.
> Write your JSON array (empty if nothing) to `$WORK/agents/<agent>.candidates.json`
> and reply with just the array.

If your runtime cannot spawn subagents, do each agent's job yourself in
sequence, one fresh mindset per agent, still writing the same files.

## Step 3 — pass 2: the verifier (fresh subagent per specialist)

For every agent whose candidates file is non-empty, spawn a **fresh** verifier
subagent (fresh eyes — never the same one that found things):

> You are the verifier. Read `$HEIMDALL_ROOT/prompts/contract-pass2.md` and
> follow it exactly. Candidates: `$WORK/agents/<agent>.candidates.json`.
> The REAL head code is in `$WORK/files/` — re-read the actual file for each
> candidate before deciding. `verifiedEvidence` must be a character-for-character
> quote from those files. Write the full JSON array (every candidate, with
> `status` and `verifiedEvidence`) to `$WORK/agents/<agent>.verified.json`.

## Step 4 — the harness gate (script, not your judgment)

For each agent that ran:

```bash
node "$SKILL_DIR/scripts/verify-findings.mjs" --dir "$WORK" --agent <agent>
```

It drops (silently to GitHub, loudly in the report) every finding whose
`verifiedEvidence` is not really in `files/`, scores survivors with the private
map (`config/scoring.json`), assigns stable `findingId`s, and writes
`agents/<agent>.final.json` printing `{kept, question, dropped, droppedQuote}`.
These numbers feed the coverage table — the dropped count is a feature.

## Step 4.5 — answer your own questions (before anyone else has to)

Every surviving `question` finding asks something the provided code could not
confirm. Before consolidating, try to answer each one from the repository
itself: `gh api "search/code?q=<symbol>+repo:<owner>/<repo>"` or fetch the
specific unchanged file (`gh api repos/<owner>/<repo>/contents/<path>` — take
`content` base64-decoded) to locate the call sites, lifecycle order or config
the finding depends on. Copy any file that decides the answer into
`$WORK/files/<path>` — quotes verify against that folder. When the question
depends on a **sibling repository the PR itself names** (a chart,
deploy-config, or consumer repo referenced in the description or ticket) and it
is readable, run the same contents fetch against that repo — a blind spot is
only blind if you did not look; quote the deciding file in the answer. Probe
only a repo the PR explicitly references, never roam the org. Then:

- the probe **disproves** the concern → delete the finding from that agent's
  `agents/<agent>.verified.json`, re-run Step 4, and count it as dropped in
  the coverage table (rule 2 — declared coverage).
- the probe **confirms** it → re-run Step 3 (fresh verifier, the folder now
  holds the deciding file) and Step 4, so the finding stands on evidence
  instead of a question.
- still unresolved → it stays a question. The harness already clamped it to
  ≤ 🟡 Minor; never re-inflate the tier, and the comment must name what you
  probed and could not see.

A question you could have answered but posted anyway is a review defect, even
when the answer would have been "keep".

## Step 5 — consolidate (you do this, no LLM)

1. Merge survivors from all final.json: same file and line distance ≤ 3 → one
   finding, `mergedAgents` lists all agents, highest tier wins.
2. Rewrite each survivor's PR comment in the voice of `prompts/style.md`:
   problem → evidence as its own fenced code block → why it matters here →
   a fix safe to apply as written — when one cannot be proven, the
   direction of the change instead; anything reaching files the diff did not
   touch is phrased as a follow-up. ≤ 80 prose words. A code quote never sits
   inside a sentence:
   short references in backticks, multi-line quotes fenced. No severity word
   (the harness adds the tier prefix). American English in prose
   (`initialize`, `behavior`) — re-read every comment for typos before
   writing it. "question" findings
   become one polite, quoted question: the concern stated conditionally, one
   line naming what you probed and could not see, and the question itself —
   never a consequence cascade that reads like confirmed damage. The harness
   clamps questions to ≤ 🟡 Minor; rewriting a question’s prose may not
   change that tier.
3. Write `$WORK/consolidated.json`:
   `[{"findingId","file","line","tier","title","status","mergedAgents":[],"comment":"...","replyTo":null}]`
   — `replyTo` = an existing human thread's commentId (from comments.json) when
   an UNRESOLVED human comment touches the same lines (≤ 3); then keep only
   what genuinely adds to it in `comment`. For an unresolved BOT comment on the
   same lines, keep `replyTo` null but open the comment by referencing it
   ("Building on Copilot's note above: …") and ship only what genuinely adds.

## Step 6 — gap-check silent files

Every in-scope file with no finding gets one quick subagent: "does this file
contain an obvious blocker (cannot work / security hole / data loss)? Style is
not a blocker. Reply {"clean":true} or {"clean":false,"note":"..."}" — using
`$HEIMDALL_ROOT/prompts/gap-check.md`. Record results for the summary; a failed
check counts as NOT verified, never as clean.

## Step 7 — report in chat, then stop and ask

Build `$WORK/summary.md` with: marker line `<!-- heimdall:summary -->`, verdict
(💀>0 → Needs work; 🔴>0 → Needs work; else Comment only / Nits / All clean),
findings grouped by tier, coverage table (agent | status | kept | dropped),
gap-check list, files not deeply reviewed (skipped.json), the requirements
unverified note when ticket.json says so, and footer:
`_Reviewed by Heimdall skill — model: <your model id> — advisory: never approves; a blocker requests changes._`

**Print the full report to the chat** — LEAD with the headline score, computed
deterministically the same way as the CLI:
`## 🎯 PR Score  <n>/100  <icon> <band>` where
`n = max(0, 100 − 40·blockers − 15·majors − 5·minors − 1·nits)`;
band: any blocker → `💀 Blocked`, else ≥90 `🟢 Ready`, ≥75 `🔵 Nearly ready`,
≥50 `🟠 Needs work`, below that `🔴 At risk`.
Then every finding's comment text. End with:
"Nothing has been posted. Reply 'post it' to publish N inline comments + summary to the PR."
Do not proceed without an explicit yes.

## Step 8 — publish (script, --post)

```bash
node "$SKILL_DIR/scripts/post-review.mjs" --dir "$WORK" --post
```

It posts one review with `event=COMMENT`, or `event=REQUEST_CHANGES` when a
blocker is posted this run (never approve),
replies in human threads where you set `replyTo`, updates the existing summary
comment in place on re-runs, skips lines this same gh user already commented
under the heimdall footer, and refuses to publish numbers-only text. It also
runs a **prose gate**: curated misspellings and en-GB spellings
(`initialised`, `behaviour`, `recieve`) and duplicated words are auto-fixed in
titles, comments and the summary — meaning-preserving, code and backticked
text untouched — and every fix is declared on stderr and in the result JSON
(`proseFixes`). Report the posted URLs. It never touches human comments.

**Reading the run.** Progress lines go to stderr (`heimdall post: posting review
with 12 inline comment(s)…`); stdout is the single result JSON — parse stdout,
don't judge liveness by it. Posting is a handful of gh API calls, so a normal run
is seconds. Any single call that stalls past `HEIMDALL_GH_TIMEOUT_MS` (default
120s) is killed and the script exits 1 with one line,
`heimdall post failed: gh api … failed: <reason>` — read that reason instead of
waiting. A silent, output-less run that lasts minutes means gh itself is blocked,
usually on an interactive auth/keychain prompt: run `gh auth status` and re-run.
`reviewError` / `replyErrors` in the result JSON name any post that was refused
(GitHub rejects an inline comment whose line is outside the diff — fix the line in
`consolidated.json` and re-run; the dedupe guard keeps the already-posted lines
from duplicating).
