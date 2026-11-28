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

## Production follow-up · 50 additional improvements

The November 27 release was prepared on the roadmap branch for promotion through pull request review and CI. A Wrangler dry run on the previous checkout failed at the repository root because it detected Pages Functions and had no root Worker entry point. The same command now bundles **worker/lppe-api.js** through the root **wrangler.toml**. Production App and API smoke checks use **lppe.pages.dev/fanduel** and **lppe-api.lord-joseph.workers.dev/health**. Health reports the Worker runtime revision and, for tagged deploys, the Git commit tag.

| Area | Delivered changes |
| --- | --- |
| 1–5 · Projection identity | Normalize compatibility Unicode, reject conflicting exact-ID name or team claims, protect known slate IDs from reassignment, reject explicit suffix conflicts, and require unique exact names for name fallback. |
| 6–10 · Projection evidence | Match the individual player's game date, preserve salary game dates, quarantine duplicate IDs in joins, reject conflicting point estimates, and keep point estimates and ancillary data tied to one matched evidence group. |
| 11–15 · Forecast provenance | Audit match paths and ambiguous joins, exclude future or unverifiable projection timestamps in historical runs, withhold inconsistent timestamps, withhold conflicting or below-mean ceilings, and reject conflicting salary snapshots for a repeated player ID. |
| 16–20 · Live NBA data | Propagate the public forecast's observation time, reject late or locked overlays, reject same-team or out-of-slate matchup evidence, stop projecting unavailable players with stale selection flags, and quarantine ambiguous NBA rotation histories on either side of the name join. |
| 21–25 · NBA model research | Drop suspect minutes and conflicting duplicate games, sort history before applying limits, fit role-specific minutes when there is support, shrink recency-weighted production rates toward observed pooled rates, and model integer pushes through a discrete probability distribution. |
| 26–30 · NBA simulation | Expose a reproducible unsigned seed, preserve independent comparison seeds, carry search truncation across candidate generation, use collision-safe roster identifiers, and compute rank boundaries correctly for fields smaller than the top-tail place count. |
| 31–35 · NFL simulation | Expose a reproducible unsigned seed, bound configurable opponent and scenario counts, validate available candidate projections and unique IDs, count opponent roster duplicates once, and compare equal portfolios on fresh shared fields and scoring scenarios. |
| 36–40 · NBA prop backtest | Enforce complete, calendar-matched box-score inputs, deduplicate exact athlete/game observations, reject conflicting records, restrict pregame features to earlier calendar dates, and score paired integer and half-point forecasts with Brier score, log loss, and calibration bins. |
| 41–45 · Historical reporting | Fingerprint NBA inputs, report paired coverage and equal-slate MAE improvement, report replayable NBA lineup IDs and any supplied top-3% score gap, audit archived salary and projection timestamps against capture, and expose optional independent NFL seed comparisons. |
| 46–50 · Release reliability | Make Wrangler discover the Worker from Git's root, dry-run the pinned bundle in CI, test the full suite before the authenticated production fallback, tag fallback deployments and verify their runtime revision, and mark capped or incomplete NBA results responses as partial. |

### Historical accuracy check

Used complete public NBA game results for November 18–26, 2026. The holdout began November 24. On the eligible sample of 24 players and 192 player-market forecasts, the dashboard's raw forecast MAE was 4.027 versus 4.137 for the minutes-adjusted challenger. On 925 overlapping synthetic half-point trials, dashboard Brier score was 0.2253 versus 0.2302. On 541 overlapping synthetic integer trials, the scores were 0.2685 versus 0.2788. Lower is better. Keep the challenger in research. These trials use actual box-score outcomes, with synthetic lines from prior games. Use archived offers to validate actual prop probabilities and matched contest archives to measure real top-3% lift.

### Production validation and rollback

Run the full regression suite, build Pages Functions, and dry-run Wrangler from the repository root before promoting. Validate the GitHub Actions optimizer run, Cloudflare Pages production deployment, and Worker build status for the promoted commit. Check both live endpoints and compare changed production Pages assets against Git. Native Worker deployment and the authenticated fallback share the root Worker configuration. The fallback checks the tagged deployment's production health. Restore the prior known-good Pages deployment and Worker revision in Cloudflare if a rollback is necessary, then revert the production merge in Git after review.

## November 28 · College football tournament work

The long-term goal is a first-place score in each supported sport. For CFB the portfolio target is every lineup at competition rank 10 or better. Report first-place ties and the joint result alongside the top-10 rate. Keep separate cohorts by sport and contest format. Compare equal entry counts on real, unseen slates before treating modeled success as validated.

The CFB optimizer now supports the seven-slot FanDuel Classic format with Superflex, checks matchup consistency for simulation, and uses the entire portfolio when computing its worst rank. It compares legal two-entry pairs directly and tests larger portfolios against a like-for-like projection baseline. Smaller-field simulations are ranking aids. Historical replay inserts all candidate entries into the complete observed leaderboard and verifies the archived slate label and lock timestamp. CFB salary pagination supports up to 2,400 advertised rows and reports incomplete responses explicitly.

The live November 28 Main feed returned 1,029 players after the pagination repair. The provider omitted matchups. The schedule join uses the public ESPN FBS scoreboard and a small set of confirmed team aliases. It accepts a schedule only when the full roster team set, advertised game count, and first kickoff agree. Cached provider pools can be enriched without fetching the salary pages again.

### CFB joint objective and reproducible snapshots

The opt-in **First place + every lineup in the top 10** objective prioritizes the joint event in each scenario. It counts competition-rank ties and retains first-place and all-top-10 rates separately. Complete live builds saved before lock retain the original optimizer request, exclusions, simulated results, and equal-size projection-only lineup IDs. The first completed snapshot for each slate, target, and count is kept in browser storage. Download the CFB snapshots from Review and use the archive-backed benchmark against finalized standings to score the original builds.

### Cloudflare Worker native build repair

The authenticated build log showed that the branch preview invoked **wrangler preview** without a Wrangler previews block. The Cloudflare production trigger was also pointed at the older **codex/free-prizepicks-refresh** branch and passed the relocated **worker/wrangler.toml** path. Native production targets **main** and uses the root configuration, with the deployed Worker tagged by Git commit. The GitHub Actions fallback checks for that same commit tag before deploying.

Worker previews use the dedicated **lppe-prizepicks-preview** KV namespace. It is shared by previews and separate from the production board. Check the Workers Builds result, preview health, and production health after a release. The production health response exposes the active Worker revision and commit tag.
