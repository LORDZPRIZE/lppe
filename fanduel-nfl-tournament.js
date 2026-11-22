import {buildLineups, unavailable} from "./fanduel-optimizer.js";

const fieldSize = 100;
const scenarioCount = 256;
const rosterKey = lineup => JSON.stringify([...lineup.ids].sort());

function makeRandom(seed) {
  return () => {
    seed = (Math.imul(seed,1664525)+1013904223) >>> 0;
    return (seed+0.5)/4294967296;
  };
}

export function rankNFLTournament(players,lineups) {
  const fieldRandom = makeRandom(21839);
  const scenarioRandom = makeRandom(72203);
  const normal = random => Math.sqrt(-2*Math.log(random()))*Math.cos(2*Math.PI*random());
  const projected = players.filter(player => Number.isFinite(player.points))
    .sort((a,b) => a.id.localeCompare(b.id,"en"));
  const pool = projected.filter(player => !unavailable(player.status));
  const field = [];
  for (let index = 0; index < fieldSize; index++) {
    const rankedPool = pool.map(player => ({
      ...player,selection:"available",maxExposure:100,
      points:player.points+normal(fieldRandom)*Math.max(2,Math.abs(player.points)*0.32)
    }));
    // Mix stacked and unstacked builds. Each build represents one opponent entry.
    const {lineups:[opponent]} = buildLineups(rankedPool,1,1,5000,"NFL",{stack:index%3 ? 1 : 0});
    if (opponent) field.push(opponent);
  }
  if (field.length < 25) throw new Error("Too few opponent lineups could be modeled from this slate.");

  const fieldKeys = field.map(rosterKey);
  const entries = lineups.map(lineup => ({
    lineup,win:0,top:0,duplicates:fieldKeys.filter(key => key === rosterKey(lineup)).length
  }));
  const places = Math.floor((field.length+1)/10);
  for (let index = 0; index < scenarioCount; index++) {
    const gameFactors = new Map();
    const teamFactors = new Map();
    const playerScores = new Map();
    // Use the same outcomes for a slate even when the candidate portfolio changes.
    for (const player of projected) {
      const game = player.game || player.team;
      if (!gameFactors.has(game)) gameFactors.set(game,normal(scenarioRandom));
      if (!teamFactors.has(player.team)) teamFactors.set(player.team,normal(scenarioRandom));
      const individual = normal(scenarioRandom);
      const defense = player.positions.includes("DEF");
      const mean = player.points;
      // Shared game and team shocks link teammates. Individual noise preserves variance.
      const shock = 0.30*gameFactors.get(game)+0.40*teamFactors.get(player.team)+Math.sqrt(0.75)*individual;
      const score = defense ? mean+5*individual : Math.max(0,mean)*Math.exp(0.55*shock-0.55**2/2);
      playerScores.set(player.id,Math.round(score*100));
    }
    const scoreLineup = lineup => lineup.picks.reduce((sum,{player}) => sum+playerScores.get(player.id),0);
    const opponentScores = field.map(scoreLineup);
    for (const entry of entries) {
      const score = scoreLineup(entry.lineup);
      let above = 0;
      let tied = 1;
      for (const opponentScore of opponentScores) {
        if (opponentScore > score) above++;
        if (opponentScore === score) tied++;
      }
      entry.win += above === 0 ? 1/tied : 0;
      entry.top += Math.max(0,Math.min(tied,places-above))/tied;
    }
  }
  return {
    opponents:field.length,
    scenarios:scenarioCount,
    lineups:entries.sort((a,b) => b.top-a.top || b.win-a.win || a.duplicates-b.duplicates || b.lineup.points-a.lineup.points)
      .map(({lineup,win,top,duplicates}) => ({
        ...lineup,tournament:{win:win/scenarioCount,top:top/scenarioCount,duplicates}
      }))
  };
}
