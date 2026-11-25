# LPPE FanDuel contest review

This module audits historical FanDuel contest entries and player exposure for a specific username. It is **post-slate descriptive research**, not a projection model. It does not modify the deployed optimizer, and no live decision weights are changed until validated against pre-lock inputs on held-out slates.

Run:

```bash
python3 scripts/fanduel_contest_review.py leaderboard_136799-281589257.csv --username Stayonthesidelinez --output review.json
```

The leaderboard provides gross payouts but does not itself establish contest entry fees or net ROI. Player outcomes and top-20 lineup appearances are hindsight only. Historical results must not be used as pre-lock inputs. The source file is FanDuel, regardless of older local report labels.
