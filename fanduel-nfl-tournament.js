import {buildLineups, unavailable} from "./fanduel-optimizer.js";

const fieldSize = 100;
const scenarioCount = 1024;
const rosterKey = lineup => JSON.stringify([...lineup.ids].sort());

function makeRandom(seed) {
  return () => {
    seed = (Math.imul(seed,1664525)+1013904223) >>> 0;
    return (seed+0.5)/4294967296;
  };
}

function simulateNFLTournament(players,lineups) {
  const fieldRandom = makeRandom(21839);
  const scenarioRandom = makeRandom(72203);
  const normal = random => Math.sqrt(-2*Math.log(random()))*Math.cos(2*Math.PI*random());
  const projected = players.filter(player => Number.isFinite(player.points))
    .sort((a,b) => a.id.localeCompare(b.id,"en"));
  const pool = projected.filter(player => !unavailable(player.status));
  const ownershipBias = new Map();
  for (const player of pool) {
    if (!Number.isFinite(player.ownership)) continue;
    // Bound the adjustment so projected scoring and roster constraints still matter.
    const ownership = Math.min(0.95,Math.max(0.01,player.ownership));
    const oddsRelativeToTenPercent = 9*ownership/(1-ownership);
    ownershipBias.set(player.id,Math.max(-8,Math.min(8,3*Math.log(oddsRelativeToTenPercent))));
  }
  const field = [];
  for (let index = 0; index < fieldSize; index++) {
    const rankedPool = pool.map(player => ({
      ...player,selection:"available",maxExposure:100,
      points:player.points+(ownershipBias.get(player.id) ?? 0)+normal(fieldRandom)*Math.max(2,Math.abs(player.points)*0.32)
    }));
    // Mix stacked and unstacked builds. Each build represents one opponent entry.
    const {lineups:[opponent]} = buildLineups(rankedPool,1,1,5000,"NFL",{stack:index%3});
    if (opponent) field.push(opponent);
  }
  if (field.length < 25) throw new Error("Too few opponent lineups could be modeled from this slate.");

  const fieldKeys = field.map(rosterKey);
  const firstPlaceShares = new Map(lineups.map(lineup => [lineup.ids,new Float64Array(scenarioCount)]));
  const entries = lineups.map(lineup => ({
    lineup,win:0,top:0,scores:[],duplicates:fieldKeys.filter(key => key === rosterKey(lineup)).length
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
      entry.scores.push(score);
      let above = 0;
      let tied = 1;
      for (const opponentScore of opponentScores) {
        if (opponentScore > score) above++;
        if (opponentScore === score) tied++;
      }
      if (above === 0) {
        const share = 1/tied;
        entry.win += share;
        firstPlaceShares.get(entry.lineup.ids)[index] = share;
      }
      entry.top += Math.max(0,Math.min(tied,places-above))/tied;
    }
  }
  return {
    opponents:field.length,
    ownershipPlayers:ownershipBias.size,
    fieldPlayers:pool.length,
    firstPlaceShares,
    scenarios:scenarioCount,
    lineups:entries.map(({lineup,win,top,scores,duplicates}) => ({
      ...lineup,tournament:{
        win:win/scenarioCount,top:top/scenarioCount,duplicates,
        ceiling:scores.sort((a,b) => a-b)[Math.ceil(scenarioCount*0.90)-1]/100
      }
    })).sort((a,b) => b.tournament.win-a.tournament.win || b.tournament.top-a.tournament.top ||
      b.tournament.ceiling-a.tournament.ceiling || a.tournament.duplicates-b.tournament.duplicates ||
      b.points-a.points)
  };
}

export function rankNFLTournament(players,lineups) {
  const {firstPlaceShares,...ranking} = simulateNFLTournament(players,lineups);
  return ranking;
}

function selectTournamentPair(ranked,limits,difference) {
  let pair;
  let bestCoverage = -1;
  for (const [index,first] of ranked.lineups.entries()) {
    const firstShares = ranked.firstPlaceShares.get(first.ids);
    for (const second of ranked.lineups.slice(index+1)) {
      const shared = [...second.ids].filter(id => first.ids.has(id));
      if (second.ids.size-shared.length < difference || shared.some(id => limits.get(id) < 2)) continue;
      const secondShares = ranked.firstPlaceShares.get(second.ids);
      let coverage = 0;
      for (let scenario = 0; scenario < ranked.scenarios; scenario++) {
        coverage += Math.max(firstShares[scenario],secondShares[scenario]);
      }
      if (coverage > bestCoverage+1e-9) {
        pair = [first,second];
        bestCoverage = coverage;
      }
    }
  }
  return pair;
}

export function buildNFLTournament(players,count,difference,searchLimit,{exposure = 100,stack = 0} = {}) {
  const candidates = new Map();
  const limits = new Map(players.map(player => [
    player.id, player.selection === "lock" ? count :
      Math.floor(count*Math.min(exposure,player.maxExposure ?? 100)/100)
  ]));
  const pool = players.filter(player => limits.get(player.id) > 0)
    .map(player => ({...player,maxExposure:100}));
  const candidateCount = Math.min(20,Math.max(6,count*2));
  let limited = false;
  let restriction;
  function collectCandidates(candidatePool,minimum) {
    const result = buildLineups(candidatePool,candidateCount,1,searchLimit,"NFL",{stack:minimum});
    limited ||= result.limited;
    restriction ||= result.restriction;
    for (const lineup of result.lineups) candidates.set(rosterKey(lineup),lineup);
    return result.lineups[0];
  }

  // Sample double stacks separately so the projection search cannot crowd them out.
  for (let minimum = stack; minimum <= 2; minimum++) {
    const lead = collectCandidates(pool,minimum);
    if (count !== 2 || !lead) continue;
    // An exposure cap can make every top projected roster incompatible with the lead.
    const capped = new Set([...lead.ids].filter(id => limits.get(id) === 1));
    if (capped.size) collectCandidates(pool.filter(player => !capped.has(player.id)),minimum);
  }
  // Give each eligible quarterback a separate candidate search for two-entry GPPs.
  // Preserve explicit locks and the user's minimum stack setting.
  if (count === 2 && !pool.some(player => player.selection === "lock" && player.positions.includes("QB"))) {
    const quarterbacks = pool.filter(player => player.positions.includes("QB") &&
      player.selection !== "exclude" && !unavailable(player.status) && Number.isFinite(player.points))
      .sort((a,b) => b.points-a.points).slice(0,8);
    for (const qb of quarterbacks) {
      const qbPool = pool.filter(player => !player.positions.includes("QB") || player.id === qb.id);
      collectCandidates(qbPool,Math.max(1,stack));
    }
  }
  // Generate alternative roster cores for multi-entry GPP portfolios. The original
  // projection-first search can return near-identical candidates, leaving exposure
  // constraints impossible to satisfy even when other valid rosters exist.
  // These are pre-lock projection-based candidates, not hindsight substitutions.
  if (count > 2 && candidates.size) {
    const baseline = [...candidates.values()];
    const frequency = new Map();
    for (const lineup of baseline) {
      for (const id of lineup.ids) frequency.set(id,(frequency.get(id) || 0)+1);
    }
    const alternatives = [...frequency.entries()]
      .filter(([id]) => !players.some(player => player.id === id && player.selection === "lock"))
      .sort((a,b) => b[1]-a[1] || a[0].localeCompare(b[0]))
      .slice(0,Math.min(8,count*2));
    for (const [excludedId] of alternatives) {
      const variedPool = pool.filter(player => player.id !== excludedId);
      const result = buildLineups(variedPool,Math.min(6,count),1,searchLimit,"NFL",{stack});
      limited ||= result.limited;
      for (const lineup of result.lineups) candidates.set(rosterKey(lineup),lineup);
    }
  }
  if (!candidates.size) return {lineups:[],limited,restriction};

  const ranked = simulateNFLTournament(players,[...candidates.values()]);
  return selectTournamentPortfolio(ranked,limits,count,difference,limited);
}

export function selectTournamentPortfolio(ranked,limits,count,difference,limited) {
  const scenarioCount = ranked.scenarios;
  const pair = count === 2 ? selectTournamentPair(ranked,limits,difference) : undefined;
  const selectionPool = pair ?? ranked.lineups;
  const usage = new Map();
  const lineups = [];
  const covered = new Float64Array(scenarioCount);
  while (lineups.length < count) {
    let best;
    let bestGain = -1;
    for (const lineup of selectionPool) {
      if ([...lineup.ids].some(id => (usage.get(id) || 0) >= limits.get(id))) continue;
      if (lineups.some(prior => [...lineup.ids].filter(id => !prior.ids.has(id)).length < difference)) continue;
      const shares = ranked.firstPlaceShares.get(lineup.ids);
      let gain = 0;
      for (let index = 0; index < scenarioCount; index++) {
        gain += Math.max(0,shares[index]-covered[index]);
      }
      if (gain > bestGain+1e-9) {
        best = lineup;
        bestGain = gain;
      }
    }
    if (!best) break;
    lineups.push({...best,tournament:{...best.tournament,addedWinCoverage:bestGain/scenarioCount}});
    for (const id of best.ids) usage.set(id,(usage.get(id) || 0)+1);
    const shares = ranked.firstPlaceShares.get(best.ids);
    for (let index = 0; index < scenarioCount; index++) {
      covered[index] = Math.max(covered[index],shares[index]);
    }
  }
  return {
    lineups,limited,
    restriction:lineups.length < count ?
      "The simulated candidate pool could not fill the portfolio within your exposure and lineup difference settings." : undefined,
    simulation:{
      opponents:ranked.opponents,scenarios:ranked.scenarios,
      ownershipPlayers:ranked.ownershipPlayers,fieldPlayers:ranked.fieldPlayers
    }
  };
}
