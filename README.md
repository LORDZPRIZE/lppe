# lppe
Lord's PrizePicks Prop Engine

## Historical FanDuel NFL benchmark

Run `node scripts/benchmark-nfl.mjs path/to/manifest.json` with Node.js 22.7 or newer. The benchmark uses the existing NFL roster and salary rules to build the same number of lineups for each strategy on each slate. It reports actual fantasy points by lineup, mean and best score, and optional contest cutoff hits. A search that reaches its limit is flagged. Strategies that cannot build the requested number are marked as skipped.

```json
{
  "count": 5,
  "slates": [
    {
      "name": "Historical NFL Main slate",
      "salary": "salary.csv",
      "projections": "pregame-projections.csv",
      "actuals": "actuals.csv",
      "cashScore": 130,
      "topOnePercentScore": 175
    }
  ]
}
```

Paths are relative to the manifest. Use archived pre-kickoff salary, injury status, and projections for the exact FanDuel slate. The projections file is optional if the salary file already has those estimates. High Ceiling requires a numeric `Ceiling` column. The actuals file needs `ID,Actual FPTS` using the same player IDs, including defenses and zero-point players. Missing actuals for selected players stop the run.

Cutoffs are optional. Replace the sample numbers with actual contest scores. Hits include ties at the cutoff and do not measure exact payout or ROI. The diversified strategy combines a two-player minimum difference with a QB plus one teammate at WR or TE. Hold out later slates from any tuning before comparing strategies.

### Contest simulation inputs

To simulate a benchmark slate against an opponent field, add both `"scenarios": "scenarios.csv"` and `"field": "field.csv"` to that slate in the manifest.

- **Scenarios** use `Scenario,ID,FPTS`. Each scenario is a full set of joint player outcomes for the same slate. Players from the same game must share the same scenario when their scores come from a correlated game model. Supply a numeric score, including explicit zeroes, for every candidate and opponent player in each scenario.
- **Field** uses `QB,RB1,RB2,WR1,WR2,WR3,TE,FLEX,DEF` and the salary CSV's player IDs. Each row is one opponent entry. Retain repeated rosters so the benchmark counts duplicate entries.
- The benchmark reports observed duplicate rosters in the supplied field and average win and top-1% shares across scenarios. Tied entries share the places available to them. Top-1% places are rounded down, with a minimum of one, and include one candidate against the supplied field at a time.
- The simulation strategy ranks the union of candidates from the baseline strategies by top-3% share, top-1% share, win share, and then fewer field duplicates. It selects the same number of lineups and evaluates their actual scores alongside the baseline results. Use pre-kickoff simulations and a pre-kickoff modeled field for comparisons you intend to reproduce live.

## Historical FanDuel NBA forecast benchmark

Run `node scripts/benchmark-nba.mjs path/to/manifest.json` with Node.js 22.7 or newer. The benchmark compares the baseline estimates in a salary CSV with a projections CSV over the same matched, eligible players. It reports mean absolute error, root mean square error, and bias (projection minus actual). It also optimizes the top lineup under each set of inputs and scores both against actual fantasy points.

```json
{
  "slates": [
    {
      "name": "NBA Main slate",
      "date": "2026-11-22",
      "lockAt": "2026-11-22T23:00:00Z",
      "salaryCapturedAt": "2026-11-22T22:45:00Z",
      "projectionsCapturedAt": "2026-11-22T22:45:00Z",
      "salary": "salary.csv",
      "projections": "projections.csv",
      "actuals": "actuals.csv"
    }
  ]
}
```

Paths are relative to the manifest. Use slates with the current NBA Classic roster format and archive the salary pool, injury statuses, baseline estimates, and forecasts before lock for each contest. Both capture timestamps and lock time need a time zone. The actuals CSV needs `ID,Actual FPTS`, including explicit zeros for eligible players who did not play. Missing actuals for either top lineup stop the run. Use multiple unseen slates and review coverage when interpreting the accuracy and lineup results.

## NBA prop probability benchmark

Run `node scripts/benchmark-nba-props.mjs RESULTS_DIRECTORY HOLDOUT_YYYYMMDD`. Save complete final response bodies from `/api/nba/model?results=YYYYMMDD` as `YYYYMMDD.json` in the directory. Include at least a week of games before the holdout. The benchmark runs the dashboard's original hit-rate estimate and its revised estimate against the same outcomes. It compares the dashboard with a minutes-adjusted challenger in a chronological holdout. It reports point forecast error, Brier score, log loss, and calibration bins for synthetic integer and half-point lines. Several test lines share the same game result. Use archived PrizePicks lines and exact payouts to evaluate actual entry performance.

## Top-3% FanDuel tournament research

In **FanDuel → Tournament simulation**, choose **At least one top-3% lineup (experimental)** for NBA or NFL. The target is one lineup at competition rank floor(3% × total entries) or better. Fields below 34 scored entries have zero qualifying places. The optimizer uses the modeled opponent field to select portfolios that cover different scoring scenarios. The lineup's modeled share splits cutoff places across tied entries, while coverage counts any tied best finish that reaches the cutoff. NBA uses the entered field size and NFL uses a fixed-size simulated opponent sample. Both are experimental and seeded. The prior targets are still available.

For an NBA paper benchmark, save the completed pre-lock top-3% build from the live slate, then export **Build history**. After settlement, use the complete FanDuel leaderboard with its contest name, slate, lock time, and seats-filled metadata. The replay inserts all hypothetical lineups alongside the actual field. It counts both strategies only when they have equal completed portfolio sizes, use the same pre-lock timestamp, and score every lineup by matching exact FanDuel IDs.

Run the offline NBA comparison with:

    node scripts/benchmark-nba-contests.mjs path/to/manifest.json

Use this manifest format. Paths are relative to the manifest.

    {
      "holdoutFrom": "2026-11-22T00:00:00Z",
      "slates": [
        {"leaderboard": "leaderboard.csv", "archive": "nba-build-history.json"}
      ]
    }

For the NFL benchmark, add a verified numeric **topThreePercentScore** from the finalized contest. A cutoff hit includes ties. For a paired holdout also set **holdout** to true, provide a unique **contestId**, and provide **lockAt** and **salaryCapturedAt** with time zones. If you also supply **projections**, **scenarios**, or **field**, provide the corresponding **projectionsCapturedAt**, **scenariosCapturedAt**, or **fieldCapturedAt**. Archive the modeled inputs before lock. The report records input hashes, counts unpaired slates, and gives per-strategy 95% Wilson intervals across paired slates. Use an unseen period and choose one contest per slate before reviewing outcomes.

Optional NFL manifest field **simulationSeeds** accepts up to eight distinct nonzero unsigned 32-bit integers. It compares the built portfolios on fresh modeled fields with shared scoring scenarios under each seed. The output is a simulation sensitivity check.

## College football Classic tournaments

Choose **College football**, load the matching FanDuel Classic salary slate, then select **Tournament simulation**. The default CFB tournament target is **every lineup in the top 10**. Use up to 10 lineups. The model ranks the portfolio together against a sampled opponent field. It reports how often all entries reach the top 10, at least one ties for first, and both occur. Top-1% and top-3% tournament targets are also available. Projection-only is the default optimization mode when switching to CFB.

For manual uploads, use the exact contest player list and include a **Game** or **Opponent** for every eligible player. The optimizer uses verified matchups for correlated outcomes. An optional custom projection file can override FanDuel FPPG using matching player IDs, or unique names plus teams.

For a historical CFB holdout, run **node scripts/benchmark-nfl.mjs path/to/manifest.json** with **sport** set to **CFB** and **count** from one to ten. For each held-out slate supply **salary**, **salaryCapturedAt**, **lockAt**, **contestId**, **slateLabel**, **leaderboard**, and **holdout** set to true. Match player IDs between the pre-lock CSV and finalized contest. Actual player scores can come from the leaderboard or a separate **actuals** file. The benchmark compares equal-sized portfolios and inserts every hypothetical lineup into the actual scoring field. Track first-place ties, all-top-10 finishes, and both outcomes on the same slate.
