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
- The simulation strategy ranks the union of candidates from the baseline strategies by top-1% share, win share, and then fewer field duplicates. It selects the same number of lineups and evaluates their actual scores alongside the baseline results. Use pre-kickoff simulations and a pre-kickoff modeled field for comparisons you intend to reproduce live.

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
