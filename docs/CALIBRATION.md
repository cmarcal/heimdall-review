# Calibration

Every finding carries **three sub-scores the author never sees**:

| sub-score | 0–10 | the question it answers |
|---|---|---|
| `impact` | | how bad if it ships (10 = data loss / breach / broken feature) |
| `certainty` | | how sure the model is the code really does this (10 = traced end to end) |
| `blastRadius` | | how much of the system / how many users it touches |

They combine (weighted sum) into one `score`, and a **private map** turns `score` into
one of four public tiers:

```jsonc
// config/scoring.json  — this whole file is the calibration surface
{
  "weights": { "impact": 1, "certainty": 1, "blastRadius": 1 },
  "tiers": [
    { "id": "blocker", "min": 24 },   // 💀
    { "id": "major",   "min": 16 },   // 🔴
    { "id": "minor",   "min": 8 },    // 🟡
    { "id": "nit",     "min": 0 }     // 🔵
  ],
  "question": { "certaintyCap": 3, "maxTier": "minor" }
}
```

The numbers **never appear on the PR** — only the tier. The map lives in the harness,
not in the reviewed repo, so calibration is one file edit that applies everywhere.
`npm run heimdall -- doctor --scoring` prints the current map.

## The question clamp

Pass 2 can grade a candidate `question`: plausible, but **not confirmable from the
provided code**. A finder's `certainty` on such a finding is by definition not
"traced end to end", so the harness scores questions with `certainty` capped at
`certaintyCap` and clamps the public tier to `maxTier` — an unconfirmed concern
never posts as Major, whatever the finder claimed. The stored record keeps the
finder's original sub-scores: seeing over-claims is the point of the dataset.

This exists because of a real PR on a private app repo: a `regression` question —
"does login ever run before `init()`?" — whose premise lived outside the diff,
posted as 🔴 Major with the hypothetical damage written as confirmed. The author's
reply was a two-line factual rebuttal. Tier must never exceed evidence.

## Why three numbers, not one

One opaque number gives you one lever ("lower the blocker bar") and no idea why.
Three let you fix the *actual* failure mode:

- blockers too noisy because models over-claim severity → lower `impact` weight
- models flagging speculative bugs as blockers → weight `certainty`
- broad-but-mundane stuff under-rated → raise `blastRadius`

## The dataset already exists

Every run writes `runs/<repo>-<pr>-<ts>.json` with every finding's sub-scores, its
stable `findingId`, and the URL of the comment that was posted. `findingId` is
`sha1(file + lineBucket + agent)` — stable across runs, tolerant to a 2-line drift.

That file is the join key for calibration:

```
finding score given  ──┐
                      ├── joined by findingId / commentUrl
what humans did later ─┘   (resolved? dismissed? 👍/👎? same line re-flagged?)
```

v1 stores the left side. v2 scrapes the reaction/resolution state back via
`gh api` and joins it — with zero schema rework, because the IDs are already frozen.

## A calibration pass, concretely

1. Run reviews on real PRs for a while (artifacts accumulate in `runs/`).
2. Join artifact scores with what humans did (did they fix it or push back?).
3. For tiers where humans repeatedly disagreed, look at *which sub-score* the model
   over- or under-shot — that tells you which weight to nudge.
4. Edit `config/scoring.json` weights or `min` thresholds.
5. Re-run `npm run heimdall -- eval --live` to confirm recall didn't collapse.

Keep this in mind: the eval harness measures *did it find the planted bugs*, which is
necessary but not sufficient — a calibrated severity map is about whether it **ranks**
them the way humans would. Both matter; don't tune one against the other blindly.
