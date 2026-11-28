import {percentilePlaces, placeShare} from "./fanduel-contest-metrics.js";
import {buildLineups, cfbMatchupIssue, unavailable} from "./fanduel-optimizer.js";

const rosterKey = lineup => JSON.stringify([...lineup.ids].sort());

function makeRandom(seed) {
  return () => {
    seed = (Math.imul(seed,1664525)+1013904223) >>> 0;
    return (seed+0.5)/4294967296;
  };
}

function simulateFootballTournament(players,lineups,{target = "first", portfolioSize = 1,seed=0,sport="NFL",
    opponentCount=100,scenarioCount=1024} = {}) {
  if (!Number.isInteger(seed) || seed<0 || seed>0xffffffff) throw new Error("NFL scenario seed must be an unsigned 32-bit integer.");
  if (!Number.isInteger(opponentCount) || opponentCount<34 || opponentCount>1000 ||
      !Number.isInteger(scenarioCount) || scenarioCount<128 || scenarioCount>4096) {
    throw new Error("Use 34–1000 modeled opponents and 128–4096 scenarios.");
  }
  const fieldRandom = makeRandom((21839 ^ seed)>>>0);
  const scenarioRandom = makeRandom((72203 ^ seed)>>>0);
  const normal = random => Math.sqrt(-2*Math.log(random()))*Math.cos(2*Math.PI*random());
  const projected = players.filter(player => Number.isFinite(player.points) &&
    (sport!=="CFB" || !unavailable(player.status)))
    .sort((a,b) => a.id.localeCompare(b.id,"en"));
  const pool = projected.filter(player => !unavailable(player.status));
  if (sport==="CFB") {
    const issue=cfbMatchupIssue(pool);
    if (issue) throw new Error(issue);
  }
  if (new Set(projected.map(player=>player.id)).size!==projected.length) throw new Error("Duplicate NFL player ID in simulation.");
  const projectedIds=new Set(projected.map(player=>player.id));
  if (lineups.some(lineup=>lineup.picks.some(({player})=>!projectedIds.has(player.id)))) {
    throw new Error("NFL candidate player is missing a simulation projection.");
  }
  const ownershipBias = new Map();
  for (const player of pool) {
    if (!Number.isFinite(player.ownership)) continue;
    // Bound the adjustment so projected scoring and roster constraints still matter.
    const ownership = Math.min(0.95,Math.max(0.01,player.ownership));
    const oddsRelativeToTenPercent = 9*ownership/(1-ownership);
    ownershipBias.set(player.id,Math.max(-8,Math.min(8,3*Math.log(oddsRelativeToTenPercent))));
  }
  const field = [];
  for (let index = 0; index < opponentCount; index++) {
    const rankedPool = pool.map(player => ({
      ...player,selection:"available",maxExposure:100,
      points:player.points+(ownershipBias.get(player.id) ?? 0)+normal(fieldRandom)*Math.max(2,Math.abs(player.points)*0.32)
    }));
    // Mix stacked and unstacked builds. Each build represents one opponent entry.
    const {lineups:[opponent]} = buildLineups(rankedPool,1,1,5000,sport,{stack:index%3});
    if (opponent) field.push(opponent);
  }
  if (field.length < 25) throw new Error("Too few opponent lineups could be modeled from this slate.");

  const duplicates = new Map();
  for (const lineup of field) {
    const key=rosterKey(lineup);
    duplicates.set(key,(duplicates.get(key) ?? 0)+1);
  }
  const objectiveShares = new Map(lineups.map(lineup => [lineup.ids,new Float64Array(scenarioCount)]));
  const top3Places = percentilePlaces(field.length+portfolioSize);
  const top1Places = percentilePlaces(field.length+portfolioSize,1);
  const targetPlaces = target==="allTop10" ? 10 : target==="top1" ? top1Places : top3Places;
  const topTenRecords = target==="allTop10" ? new Map() : null;
  const entries = lineups.map(lineup => ({
    lineup,win:0,top:0,top3:0,top1:0,scores:[],duplicates:duplicates.get(rosterKey(lineup)) ?? 0
  }));
  if (topTenRecords) for (const {lineup} of entries) {
    topTenRecords.set(lineup.ids,{points:new Int32Array(scenarioCount),above:new Uint16Array(scenarioCount)});
  }
  const places = percentilePlaces(field.length+portfolioSize,10);
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
      const win = placeShare(above,tied,1);
      entry.win += win;
      entry.top += placeShare(above,tied,places);
      entry.top3 += placeShare(above,tied,top3Places);
      entry.top1 += placeShare(above,tied,top1Places);
      const trace=topTenRecords?.get(entry.lineup.ids);
      if (trace) {
        trace.points[index]=score;
        trace.above[index]=above;
      }
      objectiveShares.get(entry.lineup.ids)[index] = target === "first" ? win : Number(above < targetPlaces);
    }
  }
  return {
    opponents:field.length,
    ownershipPlayers:ownershipBias.size,
    fieldPlayers:pool.length,seed,requestedOpponents:opponentCount,
    firstPlaceShares:objectiveShares,topTenRecords,
    target,top3Places,top1Places,targetPlaces,
    scenarios:scenarioCount,
    lineups:entries.map(({lineup,win,top,top3,top1,scores,duplicates}) => ({
      ...lineup,tournament:{
        win:win/scenarioCount,top:top/scenarioCount,top3:top3/scenarioCount,top1:top1/scenarioCount,duplicates,
        ceiling:scores.sort((a,b) => a-b)[Math.ceil(scenarioCount*0.90)-1]/100
      }
    })).sort((a,b) => (["top1","top3"].includes(target) ? b.tournament[target]-a.tournament[target] : 0) || b.tournament.win-a.tournament.win || b.tournament.top-a.tournament.top ||
      b.tournament.ceiling-a.tournament.ceiling || a.tournament.duplicates-b.tournament.duplicates ||
      b.points-a.points)
  };
}

export function rankNFLTournament(players,lineups,options) {
  const {firstPlaceShares,topTenRecords,...ranking} = simulateFootballTournament(players,lineups,options);
  return ranking;
}

export function compareNFLPortfolios(players,portfolio,baseline,{seed,opponentCount,scenarioCount,sport="NFL",target="top3"} = {}) {
  if (!portfolio.length || portfolio.length!==baseline.length) throw new Error("Compare equal, nonempty NFL portfolios.");
  if (!seed) throw new Error("Independent NFL simulation needs a nonzero seed.");
  const {firstPlaceShares,topTenRecords,scenarios,opponents,top3Places,targetPlaces} = simulateFootballTournament(players,[...portfolio,...baseline],{
    seed,opponentCount:opponentCount ?? (sport==="CFB" ? 240 : undefined),scenarioCount,sport,target,portfolioSize:portfolio.length
  });
  let tournament=0, projection=0, improved=0, regressed=0;
  for (let scenario=0;scenario<scenarios;scenario++) {
    const hit = roster=>topTenRecords ? portfolioOutcome(roster,topTenRecords,scenario).rank<=10 :
      roster.some(lineup=>firstPlaceShares.get(lineup.ids)[scenario]);
    const a=hit(portfolio);
    const b=hit(baseline);
    tournament+=Number(a);
    projection+=Number(b);
    improved+=Number(a && !b);
    regressed+=Number(b && !a);
  }
  if (!topTenRecords && !targetPlaces) throw new Error("The comparison field has no qualifying percentile places.");
  return {seed,scenarios,opponents,top3Places,targetPlaces,target,tournament,projection,improved,regressed};
}

function selectTournamentPair(ranked,limits,difference) {
  let pair;
  let bestCoverage = -1;
  for (const [index,first] of ranked.lineups.entries()) {
    if ([...first.ids].some(id => !(limits.get(id) >= 1))) continue;
    const firstShares = ranked.firstPlaceShares.get(first.ids);
    for (const second of ranked.lineups.slice(index+1)) {
      if ([...second.ids].some(id => !(limits.get(id) >= 1))) continue;
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

export function buildNFLTournament(players,count,difference,searchLimit,options) {
  return buildFootballTournament(players,count,difference,searchLimit,options);
}

export function buildFootballTournament(players,count,difference,searchLimit,{exposure = 100,stack = 0,target = "first",
  seed,opponentCount,scenarioCount,sport="NFL",fixedSlots} = {}) {
  if (target==="allTop10" && count>10) throw new Error("Choose at most ten lineups for the all-top-10 target.");
  if (sport==="CFB") {
    const issue=cfbMatchupIssue(players.filter(p=>Number.isFinite(p.points) && !unavailable(p.status)));
    if (issue) throw new Error(issue);
  }
  const candidates = new Map();
  const limits = new Map(players.map(player => [
    player.id, player.selection === "lock" ? count :
      Math.floor(count*Math.min(exposure,player.maxExposure ?? 100)/100)
  ]));
  const pool = players.filter(player => limits.get(player.id) > 0 &&
    (sport!=="CFB" || !unavailable(player.status)))
    .map(player => ({...player,maxExposure:100}));
  const candidateCount = Math.min(20,Math.max(6,count*2));
  let limited = false;
  let restriction;
  function collectCandidates(candidatePool,minimum,slots=fixedSlots) {
    const result = buildLineups(candidatePool,candidateCount,1,searchLimit,sport,{stack:minimum,fixedSlots:slots});
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
  if ((count === 2 || sport==="CFB") && !pool.some(player => player.selection === "lock" && player.positions.includes("QB"))) {
    const quarterbacks = pool.filter(player => player.positions.includes("QB") &&
      player.selection !== "exclude" && !unavailable(player.status) && Number.isFinite(player.points))
      .sort((a,b) => b.points-a.points).slice(0,8);
    for (const qb of quarterbacks) {
      if (sport==="CFB") {
        collectCandidates(pool,stack,new Map([[0,qb.id]]));
      } else {
        const qbPool = pool.filter(player => !player.positions.includes("QB") || player.id === qb.id);
        collectCandidates(qbPool,Math.max(1,stack));
      }
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
      const result = buildLineups(variedPool,Math.min(6,count),1,searchLimit,sport,{stack,fixedSlots});
      limited ||= result.limited;
      for (const lineup of result.lineups) candidates.set(rosterKey(lineup),lineup);
    }
  }
  if (!candidates.size) return {lineups:[],limited,restriction};

  const baseline=sport==="CFB" ? buildLineups(players.filter(player=>!unavailable(player.status)),count,difference,
    searchLimit,sport,{exposure,stack,fixedSlots}) : null;
  if (baseline) {
    limited ||= baseline.limited;
    for (const lineup of baseline.lineups) {
      const key=rosterKey(lineup);
      if (!candidates.has(key)) candidates.set(key,lineup);
    }
  }
  const ranked = simulateFootballTournament(players,[...candidates.values()],{
    target:["top1","top3","allTop10"].includes(target) ? target : "first",portfolioSize:count,seed,opponentCount:opponentCount ?? (sport==="CFB" ? 240 : undefined),scenarioCount,sport
  });
  if (["top1","top3"].includes(ranked.target) && !ranked.targetPlaces) {
    throw new Error("The modeled football field is too small for this percentile. A top-1% place needs at least 100 total entries.");
  }
  const result=ranked.topTenRecords ?
    selectAllTopTenPortfolio(ranked,limits,count,difference,limited,baseline?.lineups ?? []) :
    selectTournamentPortfolio(ranked,limits,count,difference,limited);
  if (baseline) result.baseline=baseline.lineups;
  return result;
}

function portfolioOutcome(lineups,records,scenario) {
  let minimum=Infinity, tiedLowest=0, opponentsAbove=0, first=false;
  for (const lineup of lineups) {
    const trace=records.get(lineup.ids);
    const score=trace.points[scenario];
    const above=trace.above[scenario];
    if (score<minimum) {
      minimum=score;
      tiedLowest=1;
      opponentsAbove=above;
    } else if (score===minimum) tiedLowest++;
    first ||= above===0;
  }
  return {rank:1+opponentsAbove+lineups.length-tiedLowest,first};
}

function selectAllTopTenPortfolio(ranked,limits,count,difference,limited,baseline) {
  const {topTenRecords,scenarios}=ranked;
  function evaluate(lineups) {
    let all=0,first=0,both=0,excess=0;
    for (let i=0;i<scenarios;i++) {
      const outcome=portfolioOutcome(lineups,topTenRecords,i);
      const hit=outcome.rank<=10;
      all+=Number(hit);
      first+=Number(outcome.first);
      both+=Number(hit && outcome.first);
      excess+=Math.max(0,outcome.rank-10);
    }
    return {all,first,both,excess};
  }
  const better=(a,b)=>!b || (a.all-b.all || a.both-b.both || a.first-b.first || b.excess-a.excess)>0;
  const usage=new Map();
  const lineups=[];
  let current;
  while (lineups.length<count) {
    let best,bestScore;
    for (const lineup of ranked.lineups) {
      if ([...lineup.ids].some(id=>(usage.get(id) ?? 0)>=(limits.get(id) ?? 0)) ||
          lineups.some(prior=>[...lineup.ids].filter(id=>!prior.ids.has(id)).length<difference)) continue;
      const score=evaluate([...lineups,lineup]);
      if (better(score,bestScore)) {
        best=lineup;
        bestScore=score;
      }
    }
    if (!best) break;
    lineups.push(best);
    current=bestScore;
    for (const id of best.ids) usage.set(id,(usage.get(id) ?? 0)+1);
  }
  if (count===2) {
    for (const [index,a] of ranked.lineups.entries()) {
      if ([...a.ids].some(id=>!(limits.get(id)>=1))) continue;
      for (const b of ranked.lineups.slice(index+1)) {
        if ([...b.ids].some(id=>!(limits.get(id)>=1))) continue;
        const shared=[...b.ids].filter(id=>a.ids.has(id));
        if (b.ids.size-shared.length<difference || shared.some(id=>limits.get(id)<2)) continue;
        const score=evaluate([a,b]);
        if (lineups.length<2 || better(score,current)) {
          lineups.splice(0,lineups.length,a,b);
          current=score;
        }
      }
    }
  }
  if (baseline.length===count) {
    const rankedRosters=new Map(ranked.lineups.map(lineup=>[rosterKey(lineup),lineup]));
    const fallback=baseline.map(lineup=>rankedRosters.get(rosterKey(lineup)));
    const score=evaluate(fallback);
    if (lineups.length<count || better(score,current)) {
      lineups.splice(0,lineups.length,...fallback);
      current=score;
    }
  }
  return {lineups,limited,restriction:lineups.length<count ?
    "The simulated candidate pool could not fill the portfolio within your exposure and lineup difference settings." : undefined,
    simulation:{opponents:ranked.opponents,requestedOpponents:ranked.requestedOpponents,scenarios,target:"allTop10",
      seed:ranked.seed,ownershipPlayers:ranked.ownershipPlayers,fieldPlayers:ranked.fieldPlayers,
      ...(lineups.length===count ? {allTop10Coverage:current.all/scenarios,firstPointsCoverage:current.first/scenarios,
        firstAndAllTop10Coverage:current.both/scenarios} : {})}};
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
      if ([...lineup.ids].some(id => (usage.get(id) || 0) >= (limits.get(id) ?? 0))) continue;
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
      target:ranked.target,seed:ranked.seed,requestedOpponents:ranked.requestedOpponents,
      top3Places:ranked.top3Places,top1Places:ranked.top1Places,targetPlaces:ranked.targetPlaces,
      ...(["top1","top3"].includes(ranked.target) && lineups.length === count ? {
        [ranked.target+"Coverage"]:covered.reduce((sum,value) => sum+value,0)/scenarioCount
      } : {}),
      ownershipPlayers:ranked.ownershipPlayers,fieldPlayers:ranked.fieldPlayers
    }
  };
}
