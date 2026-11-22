import { buildLineups } from "./fanduel-optimizer.js";

import { rankNFLTournament } from "./fanduel-nfl-tournament.js";

self.addEventListener("message",({data}) => {
  try {
    const {players,count,difference,sport,options,highCeiling} = data;
    const pool = highCeiling ? players.map(player => ({
      ...player,
      points:Number.isFinite(player.points) ? player.ceiling : NaN
    })) : players;
    const result = buildLineups(pool,count,difference,160000,sport,options);
    if (highCeiling) {
      const originals = new Map(players.map(player => [player.id,player]));
      for (const lineup of result.lineups) {
        lineup.ceiling = lineup.points;
        lineup.picks = lineup.picks.map(pick => ({...pick,player:originals.get(pick.player.id)}));
        lineup.points = lineup.picks.reduce((sum,{player}) => sum + player.points,0);
      }
    }
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
