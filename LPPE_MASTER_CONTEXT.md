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

## Top-3% FanDuel release

The primary contest metric is the fraction of held-out slates on which an equal-size LPPE portfolio places at least one lineup at rank floor(0.03 × field size) or better, including competition-rank ties. Also report the per-entry hit rate and compare both rates with a projection-only baseline. Use separate NBA and NFL cohorts. Keep the experimental modeled target opt-in until real pre-lock archives and finalized standings establish lift.

At the baseline, all 50 existing tests passed. The Pages site and the existing roadmap preview served the FanDuel page, and the production API health endpoint responded. The repository and available file search yielded no matched November 22 standings and pre-lock archive. No historical slate was counted. Open PR #95 tracks NFL snapshot capture and PR #82 tracks prop evidence validation. Those are separate from this release.

### 50 changes

| Area | Delivered changes |
| --- | --- |
| 1–5 · Rank metrics | Exact top-3% place count, best rank, best percentile, per-entry hit rate, and contest-level hit status. |
| 6–10 · Standings integrity | Validates competition ranks, rejects duplicate entry IDs, checks complete seat totals, excludes verified empty trailing seats, and verifies finishing ranks against sorted final scores. |
| 11–15 · NBA selection | Adds the opt-in target, rejects fields without a qualifying place, computes split top-3% shares, selects for distinct top-3% scenario coverage, and computes top-3% outcomes in the independent baseline comparison. |
| 16–20 · NFL selection | Adds the opt-in target, incorporates portfolio size in the percentile, computes split top-3% shares, selects by incremental top-3% coverage, and uses top-3% share as the leading candidate tie-breaker. |
| 21–25 · Optimizer display | Sport-specific target controls, simulated rank threshold in build status, modeled top-3% share per lineup, incremental coverage per lineup, and top-3% baseline counts and batch comparisons. |
| 26–30 · Historic review | Displays the observed cutoff score, shows the user's rank and percentile, preserves a distinct first complete top-3% build, preserves its same-time projection baseline, and keeps the new paired history independent of legacy top-20 reviews. |
| 31–35 · Paper replay | Inserts the entire hypothetical portfolio into standings, considers higher-scoring portfolio entries in rank calculations, blocks partial portfolio scoring, requires exact slate and lock matching for paired results, and reports the improved and regressed slate counts with confidence intervals. |
| 36–40 · External NFL simulation | Detects duplicate salary IDs, validates candidate rosters, validates positive salaries and known teams, reports modeled top-3% share and competition-rank hit rate, and ranks external simulation candidates by top-3% share. |
| 41–45 · NFL holdout reporting | Adds the NFL top-3% strategy, captures the per-slate cutoff and score gap, validates pre-lock timestamps, rejects overlapping periods and duplicate contests, and fingerprints files with SHA-256. |
| 46–50 · Release checks | Adds a file-based NBA holdout command, blocks duplicate NBA slate locks in that command, fingerprints NBA archives and leaderboards, enables the full regression suite on the roadmap branch and PRs, and extends JavaScript syntax checks to all tracked modules. |

### Validation and rollout

- Run the regression suite with **node --test scripts/*.test.mjs scripts/test-*.mjs worker/*.test.mjs**. The new fixtures cover tie boundaries, valid NBA and NFL portfolio constraints, deterministic NFL selection, paired historical replay, and both benchmark commands.
- Validate actual results with the documented holdout commands in the [README](README.md). Fixture data verifies software behavior. Changes to lineup quality require real, matched holdout data.
- Review the [Cloudflare Pages preview](https://lppe-product-roadmap.lppe.pages.dev/fanduel) from **lppe-product-roadmap**. Smoke-test the dashboard, optimizer, browser worker, and shared metric module against the released files. The standalone production Worker is outside the changed code.
- To roll back this preview, revert the release commit on the roadmap branch and verify that Pages redeploys the restored files. Production promotion proceeds through review against **main**.
