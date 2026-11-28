import {lateSwapLineup} from "./fanduel-nba-review.js";
import { buildLineups } from "./fanduel-optimizer.js";

import { buildNBATournament, nbaRoleProjections } from "./fanduel-nba-tournament.js";
import { buildFootballTournament } from "./fanduel-nfl-tournament.js";

self.addEventListener("message",({data}) => {
  try {
    if (data.swap) {
      const {pool,entries,games,reports,priorLocks}=data.swap;
      self.postMessage({swaps:entries.map(ids=>lateSwapLineup(pool,ids,games,reports,Date.now(),priorLocks))});
      return;
    }
    const {players,count,difference,sport,options,highCeiling} = data;
    const searchLimit = data.deep ? 1000000 : 160000;
    if (data.tournament && sport === "NBA") {
      self.postMessage(buildNBATournament(players,count,difference,searchLimit,options));
      return;
    }
    if (data.tournament && ["NFL","CFB"].includes(sport)) {
      self.postMessage(buildFootballTournament(players,count,difference,searchLimit,{...options,sport}));
      return;
    }
    const pool = highCeiling ? players.map(player => ({
      ...player,
      points:Number.isFinite(player.points) ? player.ceiling : NaN
    })) : sport==="NBA" && options?.exactFirst ? nbaRoleProjections(players) : players;
    const originals = highCeiling ? new Map(players.map(player => [player.id,player])) : null;
    function displayLineup(lineup) {
      if (!originals) return lineup;
      const picks = lineup.picks.map(pick => ({...pick,player:originals.get(pick.player.id)}));
      return {...lineup,picks,ceiling:lineup.points,
        points:picks.reduce((sum,{player}) => sum + player.points,0)};
    }
    const result = buildLineups(pool,count,difference,searchLimit,sport,{
      ...options,
      onLineup(lineup,limited) {
        self.postMessage({progress:displayLineup(lineup),limited});
      }
    });
    result.exactFirst = Boolean(options?.exactFirst && result.lineups.length);
    if (highCeiling) result.lineups = result.lineups.map(displayLineup);
    self.postMessage(result);
  } catch (error) {
    self.postMessage({error:error.message || "Could not build lineups."});
  }
});
