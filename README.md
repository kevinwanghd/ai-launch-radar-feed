# ai-launch-radar-feed

Structured daily feed for AI Launch Radar.

This repository stores normalized daily source exports for:

- GitHub
- X
- Product Hunt

It is designed to be consumed by downstream tools such as `ai-launch-radar`, which read stable JSON files from GitHub Raw instead of performing fragile live crawling during each run.

---

## Purpose

This repository is the upstream data source for AI Launch Radar.

Its job is to:

1. collect or generate daily source data
2. normalize it into a stable schema
3. publish it to GitHub so downstream consumers can read it reliably

This repository is **not** the reporting layer.
It does not generate the final radar writeup.
It only provides structured source data.

---

## Directory structure

```text
data/
  YYYY-MM-DD/
    github.json
    x.json
    producthunt.json
    run-summary.json
```

Example:

```text
data/2026-04-17/
  github.json
  x.json
  producthunt.json
  run-summary.json
```

---

## File schema

Each source file uses this top-level shape:

```json
{
  "source": "github|x|producthunt",
  "date": "YYYY-MM-DD",
  "captured_at": "ISO-8601",
  "status": "ok|degraded|unavailable",
  "count": 0,
  "notes": [],
  "items": []
}
```

### Required files per day

- `github.json`
- `x.json`
- `producthunt.json`
- `run-summary.json`

Even if one source fails, its file should still be written with:

- `status: "unavailable"` or `status: "degraded"`
- `count: 0`
- an explanatory note in `notes`

Do not skip files just because a source failed.

---

## Run summary schema

`run-summary.json` uses this shape:

```json
{
  "date": "YYYY-MM-DD",
  "captured_at": "ISO-8601",
  "overall_status": "ok|degraded",
  "sources": {
    "github": { "status": "ok|degraded|unavailable", "count": 0 },
    "x": { "status": "ok|degraded|unavailable", "count": 0 },
    "producthunt": { "status": "ok|degraded|unavailable", "count": 0 }
  },
  "report_path": null
}
```

`overall_status` should be:

- `ok` only when all sources are `ok`
- `degraded` when any source is `degraded` or `unavailable`

---

## Raw URL pattern

Downstream consumers read files from GitHub Raw using this pattern:

```text
https://raw.githubusercontent.com/<owner>/ai-launch-radar-feed/main/data/YYYY-MM-DD/github.json
https://raw.githubusercontent.com/<owner>/ai-launch-radar-feed/main/data/YYYY-MM-DD/x.json
https://raw.githubusercontent.com/<owner>/ai-launch-radar-feed/main/data/YYYY-MM-DD/producthunt.json
```

---

## Local development

Generate the daily feed:

```bash
npm run generate
```

This writes output to:

```text
data/YYYY-MM-DD/
```

---

## Automation

This repository is intended to be updated by GitHub Actions on a schedule.

Typical workflow:

1. run generators
2. write `data/YYYY-MM-DD/*.json`
3. commit changes
4. push to `main`

---

## Design principles

- stable JSON first
- downstream consumers should not depend on live browsing
- partial source failure must not block the whole feed
- schema consistency is more important than perfect completeness
- missing data should be explicit, never hidden

---

## Status meanings

- `ok`: trustworthy structured data was generated
- `degraded`: partial or fallback data was used
- `unavailable`: no trustworthy data could be produced for that source

---

## Notes

This repository is intentionally simple.

It should start as a lightweight data feed and only grow when the feed pipeline is proven stable.
