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
