# Architecture

Heimdall is a CLI orchestrator. Every step is plain, deterministic code that calls a
pluggable LLM at the edges, so you can retry, cap cost, and test the flow without a
key.

```
sources/        where review context comes from
  github.ts       builds ReviewContext from a live PR via `gh`
  fixture.ts      builds the same ReviewContext from JSON (eval/tests)
llm/            the only place that talks to a model
  types.ts        Llm (one model) · ReviewerLlm (role routing + usage)
  config.ts       preset resolution + env/global overrides
  openai-compatible.ts  one client: OpenRouter/Groq/Ollama/OpenAI/...
  anthropic.ts    second adapter
  factory.ts      RoleLlm: routes agent role -> model, charges the budget
  json.ts         strict-JSON call with ONE repair retry, then declare failure
  budget.ts       running USD cost from per-model token prices
  scripted.ts     deterministic fake model for eval/tests
agents/         the specialists
  prompt.ts       loads prompts, packs context to the model's window
  base.ts         TWO-PASS executor + the quote gate
  consolidator.ts merges same-root-cause findings, normalizes the voice
  gap.ts          cheap second look at files nobody flagged
lib/            the plumbing
  ticket.ts       PR -> issue (flag > closing keywords > branch), never a guess
  diff.ts         git-diff parsing + size caps that DECLARE what they cut
  manifest.ts     per-repo .pr-review.json (budget/skip/specs/docs)
  dedupe.ts       deterministic close-line merge (before the LLM)
  scoring.ts      private score -> tier map + stable findingId
  summary.ts      verdict + the pinned summary comment (marker + disclosures)
  post.ts         gh api: review COMMENT/REQUEST_CHANGES, thread replies, self-dedupe
  orchestrator.ts the pipeline
```

## The pipeline (one review)

```
runReview(source)
  buildContext                 # diff, PR, issue, specs, threads, manifest, docs
  resolve preset + budget      # manifest preset < env < --preset
  for each enabled specialist (parallel):
     runAgent
       pass1 -> candidates    # JSON array, each needs file+line+quote
       filter to changed files
       pass2 (verifier)       # keep/drop/question + verifiedEvidence
       QUOTE GATE             # drop any keep/question whose quote isn't in the file
  mergeCloseFindings           # <=3 lines same file -> one, tags both categories
  gapCheckUncoveredFiles       # cheap pass on files no specialist flagged
  consolidate                  # LLM merges root-causes + rewrites to one voice
  score + tier (deterministic) # numeric stays private
  writeRun                     # artifact ALWAYS saved -> calibration dataset
  post?                        # gh: inline COMMENT + thread replies + summary
```

## Two data contracts everything hangs off

`candidateSchema` (pass 1) and `verifiedCandidateSchema` (pass 2) in `lib/finding.ts`.
Both zod-validated. A malformed model reply gets one repair attempt (`llm/json.ts`),
then the stage declares failure — it never posts half-parsed guesses.

`schemas/finding.schema.json` documents the surviving `VerifiedFinding`: the three
sub-scores (`impact`, `certainty`, `blastRadius`), the derived `score`/`tier`, and the
`verifiedEvidence` that had to survive the quote gate.

## Anti-hallucination, three layers

1. **Prompt** — pass 1 says: an empty array is a good answer, an invented finding is
   the worst.
2. **Second pass** — a fresh verifier judges each candidate against the real file and
   must reproduce an exact quote to `keep` it.
3. **Harness quote gate** — `fileContent.includes(verifiedEvidence)`, enforced in code,
   not the model. This is the layer that actually holds, because it does not trust the
   model to be honest — only to be consistent about what it quotes.

## Declared coverage beats fake coverage

The same honesty the tool demands of code, it applies to itself:

- a specialist that errors is `failed` in the coverage table, not omitted
- files over the per-file/total diff cap are listed as "not deeply reviewed"
- if GraphQL thread-resolution fails, the summary says resolution state is unknown
- if the context pack had to be truncated for a small model window, that's disclosed

## Publishing etiquette (`lib/post.ts`)

- one formal **review**: `event=COMMENT`, escalated to `REQUEST_CHANGES` when a
  blocker is posted this run — never `APPROVE`
- a **pinned summary comment** carrying a hidden marker; re-runs **update it in place**
- **self-dedupe** by `findingId` + line bucket so two runs never double-post a line
- if a human already has an unresolved thread near a finding, **reply in that thread**
  instead of dropping a fresh comment beside it; a **resolved** thread is left alone

## Extension points

- **new specialist** → add `prompts/agent-<name>.md`, add its name to `AGENT_NAMES`,
  add a model entry per preset. The executor, gate, dedupe, scoring and posting are
  reused unchanged.
- **new provider** → if it speaks OpenAI's wire format, it already works; otherwise add
  one adapter implementing `Llm` and a `provider` branch in `factory.ts`.
- **new source** (GitLab, a local diff) → implement `ReviewSource.buildContext()`; the
  whole pipeline is source-agnostic.
