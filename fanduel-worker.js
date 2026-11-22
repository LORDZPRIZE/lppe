import { buildLineups } from "./fanduel-optimizer.js";

import { rankNFLTournament } from "./fanduel-nfl-tournament.js";

self.addEventListener("message",({data}) => {
  try {
    const {players,count,difference,sport,options,highCeiling} = data;
    const pool = highCeiling ? players.map(player => ({
      ...player,
      points:Number.isFinite(player.points) ? player.ceiling : NaN
    })) : players;
    const originals = highCeiling ? new Map(players.map(player => [player.id,player])) : null;
    function displayLineup(lineup) {
      if (!originals) return lineup;
      const picks = lineup.picks.map(pick => ({...pick,player:originals.get(pick.player.id)}));
      return {...lineup,picks,ceiling:lineup.points,
        points:picks.reduce((sum,{player}) => sum + player.points,0)};
    }
    const result = buildLineups(pool,count,difference,data.deep ? 1000000 : 160000,sport,{
      ...options,
      onLineup(lineup,limited) {
        self.postMessage({progress:displayLineup(lineup),limited});
      }
    });
    result.exactFirst = Boolean(options?.exactFirst && result.lineups.length);
    if (highCeiling) result.lineups = result.lineups.map(displayLineup);
    if (data.tournament && sport === "NFL" && result.lineups.length) {
      const simulated = rankNFLTournament(players,result.lineups);
      result.lineups = simulated.lineups;
      result.simulation = {opponents:simulated.opponents,scenarios:simulated.scenarios};
    }
    self.postMessage(result);
  } catch (error) {
    self.postMessage({error:error.message || "Could not build lineups."});
  }
});
