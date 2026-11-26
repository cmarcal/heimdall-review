# Heimdall 👁️

> The watchman of Bifröst sees everything — and reports only what is actually there.

A **multi-agent GitHub PR reviewer** that refuses to make things up. Six specialist
agents review the same PR in parallel, each with a mandatory **second pass that must
quote the real code or the finding is deleted by the harness**. A consolidator
dedupes, gap-checks the silent files, and posts one honest summary.

Built as a portfolio project to answer one question: *can an AI code review be made
trustworthy by construction, not just by prompting?*

---

## The problem it attacks

Most AI PR reviewers are noisy because they optimize for *looking* thorough:

- **Generic** — "consider adding error handling" on code that already handles it.
- **Hallucinated** — flags a null pointer on a line that checks for null two lines up.
- **Amnesiac** — ignores the linked ticket, so it never checks the PR against what was
  actually asked, and re-litigates review threads a human already resolved.
- **Padded** — mixes one real bug with eleven nits, so the real bug gets ignored.

Heimdall's stance: **a finding without a real code quote does not exist.**

---

## What makes it different

| | Most reviewers | Heimdall |
|---|---|---|
| Requirements | compared to the PR *description* (a claim) | compared to the linked **GitHub issue** (the source of truth) |
| Hallucinations | trusted to the model | killed by a **harness-enforced quote gate** |
| Existing comments | ignored | read; **replies in-thread**, never repeats a dismissed thread |
| Coverage | silent gaps | **declares** every file it did not deeply review |
| Severity | vibes | private **calibratable score map**, only the tier is published |
| Model | locked to one vendor | **any** OpenAI-compatible or Anthropic model, incl. free/local |
| Weak model | pretends it's fine | **says so in the PR** and recommends a human pass |

---

## How it works

![Heimdall's three pillars: GATHER (build the truth once — diff, linked issue, specs and threads in one shared ReviewContext) → VERIFY (seven specialists in parallel, each running find + verify passes, ending in the harness-enforced quote gate) → REPORT (consolidate, declared coverage, tier verdict, comment-only publish) — all running on a pluggable, honest-about-its-limits model layer](docs/images/architecture.svg)

The same pipeline, in text:

```
                      ┌──────────────────────────────────────────┐
        Step 1        │  diff + title/body + linked issue + specs │  build once,
      (initialize)    │  + existing comment threads (via gh)      │  share with all
                      └──────────────────────────────────────────┘
                                          │
        Step 2         ┌─────────┬────────┼─────────┬──────────┬───────────┐
     (6 in parallel)   ▼         ▼        ▼         ▼          ▼           ▼
                   Security  Requirements E2E  Architecture Regression Performance
                       │         │        │         │          │           │
                       └──── each agent runs TWO passes ───────┘           │
                                  pass 1: find                              │
                                  pass 2: VERIFY against real code          │
                                          │                                 │
        Step 3          ┌─────────────────┴──────────────────────────────────┘
     (consolidate)      │  quote gate · dedupe ≤3 lines · gap-check silent files
                        ▼  merge voice → one author · compute verdict + PR score
      Review COMMENT/REQUEST_CHANGES (blockers) + pinned summary comment on the PR
```

Every stage that gives up **says so**. A specialist that fails is `failed`, not
silently skipped. A file over the size cap is listed, not hidden. The second pass
reports how many candidates it **dropped** — that number is the point.

### The quote gate (the core guarantee)

In `src/agents/base.ts`, pass 2 returns each candidate with a `verifiedEvidence`
quote. Before anything can be posted, the harness checks:

```ts
if (v.verifiedEvidence && !fileContent.includes(v.verifiedEvidence)) {
  dropped++;            // the model claimed a quote that isn't in the code
  continue;             // deleted here — not posted, not negotiated
}
```

A model can be persuasive. It cannot fake a `String.includes` against the file it did
not write. This is tested directly in `tests/anti-hallucination.test.ts`.

### The prose gate (one voice on GitHub)

Models also wobble between Englishes — `initialised` next to `behavior` — and typo.
Nothing wrong-spelled reaches a PR: in `src/lib/prose.ts` (mirrored by the skill's
publisher), before posting the harness fixes a curated map of common misspellings
and en-GB spellings to their US forms and collapses duplicated words (`the the`).
Prose only — fenced evidence and `identifiers` are never touched — every fix is
meaning-preserving, and every fix is **declared** (`prose gate: a.go:12 fixed
initialised→initialized`), never silent.

---

## Quick start

Requires **Node 22+** and an authenticated **`gh`** (`gh auth login`). The LLM is
pluggable — pick any preset.

```bash
npm install
cp .env.example .env          # add ONE provider key

# 1. check your model config is honest (auth, latency, JSON compliance)
npm run heimdall -- doctor

# 2. dry-run a PR — prints the exact report, posts nothing (default)
npm run heimdall -- review 123 --repo owner/repo

# 3. when you trust it, publish
npm run heimdall -- review 123 --repo owner/repo --post

# 4. grade the reviewer itself
npm run heimdall -- eval              # offline, deterministic, needs no key
npm run heimdall -- eval --live       # against your real configured model
```

After `npm run build`, the `heimdall` binary is on your PATH via `npm link`.

Dry-run is the default on purpose: you watch it work before it ever touches a real PR.

---

## Use it as an agent skill: `/heimdall-review <pr-link>`

The daily-driver UX — inside Claude Code or opencode, no separate API key: your
session agent becomes the orchestrator, the seven specialists run as subagents
using the same `prompts/` contracts, and the anti-hallucination gate is enforced
by dependency-free scripts (`gh` for facts, a Node script for the quote check),
not by trusting the model.

```bash
npm run install-skill      # symlinks the skill into ~/.claude/skills and ~/.agents/skills
```

Then, in a fresh agent session:

```
/heimdall-review https://github.com/acme/repo/pull/123
```

The skill reuses everything this project stands for: the hidden score map, the
mandatory second pass with a **script-enforced** quote gate (the orchestrating
agent is not allowed to vouch for quotes itself), declared coverage, ticket as
source of truth, dry-run first — it prints the full report in chat and posts
nothing until you say so. Re-runs update its own summary comment and never
duplicate its own lines. `npm run uninstall-skill` removes the links.

The CLI remains the deterministic path for CI and calibration runs; both share
one brain (`prompts/`, `config/scoring.json`) and one id/dedupe scheme, so a
skill run and a CLI run never post over each other's findings.

---

## Model presets (no vendor lock-in)

One OpenAI-compatible client reaches OpenRouter, Groq, Together, Mistral, GitHub
Models, Ollama, LM Studio and OpenAI. Anthropic is a second adapter. The default
preset uses a **free** OpenRouter model so a stranger clones, adds one key, and runs.

```bash
npm run heimdall -- review 123 --repo owner/repo --preset anthropic
npm run heimdall -- review 123 --repo owner/repo --preset ollama-local   # fully offline/private
```

Set the per-role model and its declared capability in [`config/models.json`](config/models.json).
`heimdall doctor` probes each model and refuses to let you over-declare a weak model
as "high". When any specialist runs on a `basic` model, the PR summary says so —
honest about its own limits, like it demands of the code.

---

## Per-repo configuration

Drop a `.pr-review.json` in the reviewed repo (see [`.pr-review.example.json`](.pr-review.example.json))
to set the budget, skip globs, spec-file locations, which specialists are on, and
the repo docs each specialist should read (`docs/security.md`, testing guide, ADRs…).
Zero-config still works — sensible defaults.

### Heimdall reads the repo's agent instructions

Beyond the docs you list, Heimdall finds the repo's own AI-tool rule files by
convention and gives them to every specialist as a citable standard: `AGENTS.md`,
`CLAUDE.md`, `GEMINI.md`, `.github/copilot-instructions.md`, `.cursorrules`,
`.cursor/rules/**`, `.qodo/agents/**`, plus nested `AGENTS.md` and `CLAUDE.md`.
Files a skip glob catches (for example under `node_modules`) are ignored.
Detection is capped at 12 files and 30k characters, and the run log declares what
it found (`agent instructions: …`, or `none detected`).

Set `agentInstructions` in `.pr-review.json` to your own glob list to override the
defaults, or `false` to turn detection off.

### Migrations are schema facts

When the diff's SQL names a table (`FROM`, `JOIN`, `UPDATE`, `INSERT INTO`,
`CREATE/ALTER/DROP TABLE`), Heimdall fetches the migrations whose file names
mention those tables and packs them for every specialist as **schema facts**.
A constraint defined outside the diff — like a `UNIQUE (order_id, sku)`
you cannot see from a `:many` query — is what turns a false
"this column is not unique" Major into a dropped candidate before it ever
posts. Constraint claims must cite these files or degrade to a question.

Selection is deterministic (directory glob + filename match, capped at 20 files
and 30k characters) and the fetch log declares how many tables and migrations
were picked up. Point `migrations` in `.pr-review.json` at your migration
directories if the default (`**/*migrat*/**`) misses your layout.

---

## Results

### Pipeline correctness (offline eval — `npm run heimdall -- eval`)

Deterministic, no key, runs with `npm test`. Proves find→verify→drop→dedupe→score→consolidate
is wired correctly and that fabricated quotes are deleted, not posted:

| suite | result |
|---|---|
| unit tests | **151 passing** |
| eval fixtures (6) | **recall 6/6 · precision 100% · hallucinations posted 0** |

Each fixture plants one real bug and a decoy; the security fixture also feeds the
verifier a KEEP verdict backed by a quote that **is not in the code** — and it is
dropped. One fixture proves the schema-fact rule the other way: a candidate whose
premise a migration refutes must die in the verify pass, not post as a question.

### Examples are fiction

Every fixture and every example in this repo is an invented company (`acme/*`)
with an invented schema. Heimdall gets better by reviewing real private
repositories, and a real table name pasted into a fixture "as an example"
publishes somebody's production schema. So the check is an **allowlist**:
`config/fixture-vocabulary.json` declares the orgs, repos, tables, columns and
constraint names that fiction may use, and `npm test` fails on anything else — in
a fixture, a prompt, a doc, or the SQL inside a unit test. Adding an invented
name to that registry is how you add a fixture; a denylist of real names is never
the answer, because it publishes what it forbids.

### Model quality (live eval — the number that actually matters)

Run `npm run heimdall -- eval --live --preset <name>` and paste the real
precision/recall per preset. Free/local models will score lower on Security and the
second pass — that is exactly why the eval exists, and why the tool discloses which
model reviewed your PR.

| preset | recall | precision | hallucinations |
|---|---|---|---|
| `anthropic` | _fill from `eval --live`_ | | |
| `openrouter` (free) | | | |
| `ollama-local` | | | |

---

## What it will not do

- It **never approves**. It posts `event=COMMENT`; when a **blocker** survives the run it
  posts `event=REQUEST_CHANGES` — the condition that blocks the merge. Merging itself stays a human call.
- It **never invents a ticket or a requirement**. No linked issue means "requirements
  unverified", stated in the PR, not fabricated.
- It **never posts the hidden numeric score**. Authors see the tier, not a number.

---

## Docs

- [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) — pipeline, data shapes, extension points
- [`docs/images/`](docs/images/) — the hand-drawn diagram above, generated from `generate-architecture.js` (rough.js / Excalidraw style)
- [`docs/CALIBRATION.md`](docs/CALIBRATION.md) — tuning the private score map over time
- [`skills/heimdall-review/SKILL.md`](skills/heimdall-review/SKILL.md) — the agent-native slash-command workflow
- [`schemas/finding.schema.json`](schemas/finding.schema.json) — the finding contract

## License

MIT — see [LICENSE](LICENSE).
