# LPPE master context

Updated 2026-11-27. Product: Lord's Sports Analytics / Lord's PrizePicks Prop Engine (LPPE).

## Mission
Build an independent mobile-first analytics platform that can compete with leading DFS and prop research tools. Identify favorable opportunities using validated estimates, never promise winners or profit. Benchmark against five comparable products using reproducible tests rather than marketing claims.

## Existing infrastructure
- Repository: LORDZPRIZE/lppe; preserve main and use reviewable branches.
- Previously deployed dashboard: https://lppe.pages.dev
- Previously deployed Worker: https://lppe-api.lord-joseph.workers.dev
- Source inspection on Nov 27 confirmed index.html and fanduel.html on main. FanDuel UI loads /fanduel-ui.js. Dashboard contains prop board, sportsbook comparisons, outside picks, builder, watchlist and results tracking. Source presence is not proof of runtime functionality.
- Historical research: Nov 22 FanDuel leaderboard CSV (not DraftKings). Preserve original datasets and provenance. Prior conversation reports a 30-slate experiment with missing pre-lock captures and roster-ID matching issues; verify against repository artifacts before counting results.

## Engineering priorities
1. Audit repository, tests, open PRs, data providers and current deployment health. Establish baseline before changing models.
2. Verify player/event identifiers, timestamps, completeness and freshness; fail closed on ambiguous joins or stale data. Respect provider terms and budgets.
3. Validate DFS roster and salary constraints, projection uncertainty, correlation and portfolio diversification. Separate contest formats and use reproducible simulation seeds.
4. Validate prop probabilities including pushes, market matching, no-vig estimates and uncertainty. Do not equate estimated probability with guaranteed results.
5. Store immutable pre-lock snapshots, actual outcomes, model versions and contest rules. Evaluate out-of-sample without leakage; record missing data explicitly.
6. Benchmark calibration (Brier score, log loss, reliability curves), projection error, lineup validity, runtime, and historical contest performance net of fees with uncertainty. Compare identical slates and inputs where possible. Select five competitors by relevance and evidence availability.
7. Improve responsive web experience, then installable PWA, then evaluate native mobile packaging and store compliance. Keep analytics separate from entry submission; no automatic paid entries.

## Release gates
Tests pass; data provenance and freshness visible; no fabricated values; no credentials in source; documented rollback; no paid provider changes without owner approval. Do not label unvalidated models as proven. Preserve working production until review.

## Continuity
Keep this document updated with verified milestones, decisions, blockers and links to tests. Record deployment details without secrets. This initial document is a partial handoff, not a complete archive of all past conversations or files. Cloudflare access, live feeds and full engine behavior remain unverified.
