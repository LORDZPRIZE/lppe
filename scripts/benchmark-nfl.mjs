import {selectCfbSnapshot} from "../fanduel-cfb-snapshot.js";
import {createHash} from "node:crypto";
import {finalizedField, percentilePlaces, wilsonInterval} from "../fanduel-contest-metrics.js";
import {readFileSync} from "node:fs";
import {dirname, resolve} from "node:path";
import {applyPlayerProjections, buildLineups, contestPlayerScores, importPlayers, parseCSV} from "../fanduel-optimizer.js";

import {buildFootballTournament, compareNFLPortfolios} from "../fanduel-nfl-tournament.js";
import {createContestSimulator} from "./nfl-contest-sim.mjs";

const mean = values => values.reduce((sum,value) => sum+value,0)/values.length;
const round = value => Number(value.toFixed(3));
const read = path => readFileSync(path,"utf8");

function benchmarkSlate(slate,root,count,sport,target) {
  const hashes = {};
  const readSlateFile = key => {
    const data = read(resolve(root,slate[key]));
    hashes[key] = createHash("sha256").update(data).digest("hex");
    return data;
  };
  const timestamp = value => typeof value === "string" && /T.*(?:Z|[+-]\d{2}:\d{2})$/i.test(value)
    ? Date.parse(value) : NaN;
  const captureFields = ["salary",...(slate.projections ? ["projections"] : []),
    ...(slate.scenarios ? ["scenarios","field"] : [])];
  const lockAt = timestamp(slate.lockAt);
  const archived=slate.archive ? selectCfbSnapshot(JSON.parse(readSlateFile("archive")),{
    lockAt,count,slateLabel:slate.slateLabel,target
  }) : null;
  if (archived && sport!=="CFB") throw new Error("Paired snapshot archives are only supported for CFB.");
  const timed = Boolean(archived) || captureFields.every(key => timestamp(slate[key+"CapturedAt"]) < lockAt);
  let cutoff=slate.topThreePercentScore;
  let top1Cutoff=slate.topOnePercentScore;
  let fieldSize=null;
  let standings=null;
  let fieldScores=null;
  if (slate.leaderboard) {
    standings=parseCSV(readSlateFile("leaderboard"));
    const field=finalizedField(standings);
    const east=new Intl.DateTimeFormat("en-CA",{timeZone:"America/New_York",year:"numeric",month:"2-digit",day:"2-digit"});
    const clock=new Intl.DateTimeFormat("en-GB",{timeZone:"America/New_York",hour:"2-digit",minute:"2-digit",second:"2-digit",hourCycle:"h23"});
    const expected=Number.isFinite(lockAt) ? east.format(lockAt)+" "+clock.format(lockAt)+" ET" : "";
    const label=text=>String(text ?? "").trim().toLowerCase().replace(/^(?:mon|tue|wed|thu|fri|sat|sun)\s+/, "").replace(/\s+slate$/,"");
    const info=key=>standings.find(row=>row.contestinfo===key)?.contestvalue;
    const places=field ? percentilePlaces(field.length) : 0;
    if (!places || !expected || info("Start Time")!==expected || !slate.slateLabel ||
        label(slate.slateLabel)!==label(info("Slate"))) {
      throw new Error("Leaderboard must be finalized and match the archived slate label and lock time.");
    }
    fieldSize=field.length;
    fieldScores=field.map(row=>Math.round(Number(row.points)*100));
    const observed=Number(field[places-1].points);
    if (Number.isFinite(cutoff) && cutoff!==observed) throw new Error("Provided top-3% score contradicts the finalized leaderboard.");
    cutoff=observed;
    const top1Places=percentilePlaces(fieldSize,1);
    const observedTop1=top1Places ? Number(field[top1Places-1].points) : null;
    if (Number.isFinite(top1Cutoff) && top1Cutoff!==observedTop1) {
      throw new Error("Provided top-1% score contradicts the finalized leaderboard.");
    }
    top1Cutoff=observedTop1;
  }
  if (sport==="CFB" && slate.holdout===true && (!standings || !Number.isFinite(top1Cutoff))) {
    throw new Error("A CFB holdout requires a complete finalized contest leaderboard with at least 100 scored entries.");
  }
  if (slate.holdout === true && (!timed || !slate.contestId?.trim() || !Number.isFinite(cutoff))) {
    throw new Error("Holdout slates need a contest ID, pre-lock timestamps for each model input and a numeric top-3% cutoff.");
  }
  const readActuals=()=>{
    if (!slate.actuals && !standings) throw new Error("Supply actual player scores or finalized standings.");
    if (!slate.actuals) return contestPlayerScores(standings);
    const results=new Map();
    for (const row of parseCSV(readSlateFile("actuals"))) {
      if (!row.id || !row.actualfpts || !Number.isFinite(Number(row.actualfpts)) || results.has(row.id)) {
        throw new Error("Actuals must have unique ID values and numeric Actual FPTS.");
      }
      results.set(row.id,Number(row.actualfpts));
    }
    return results;
  };
  const actuals=readActuals();
  let simulate;
  const cfbStrategy=target==="firstAndTop10" ? "CFB First + All Top 10" : "CFB All-Top-10 Portfolio";
  if (archived) {
    const toLineups=portfolio=>portfolio.map(ids=>({picks:ids.map(id=>({player:{id,name:id}}))}));
    return report([
      summarize(cfbStrategy,toLineups(archived.tournament),archived.limited),
      summarize("Projection",toLineups(archived.baseline),archived.limited)
    ],[]);
  }
  const salary=readSlateFile("salary");
  if (timed && parseCSV(salary).some(row=>row.projectionupdatedat &&
      !(timestamp(row.projectionupdatedat)<=timestamp(slate.salaryCapturedAt)))) {
    throw new Error("Salary snapshot contains a forecast updated after capture or without a verified time zone.");
  }
  const {players:salaryPlayers} = importPlayers(salary,"",sport,{slateKey:slate.slateKey});
  const {players} = slate.projections ? applyPlayerProjections(salaryPlayers,readSlateFile("projections"),sport,{
    date:slate.date,asOf:timed ? timestamp(slate.projectionsCapturedAt) : undefined
  }) : {players:salaryPlayers};
  if (Boolean(slate.scenarios) !== Boolean(slate.field)) {
    throw new Error("Contest simulation requires both scenarios and field CSVs.");
  }
  simulate = slate.scenarios ? createContestSimulator(
    readSlateFile("scenarios"),readSlateFile("field"),players,sport
  ) : null;
  const candidates = [];
  let projectionPortfolio;
  const snapshots = [
    ["Projection",players,sport==="CFB" ? 2 : 1,{}],
    ["High Ceiling",players.map(player => ({
      ...player,points:Number.isFinite(player.points) ? player.ceiling : NaN
    })),1,{}],
    ["Diversified + QB stack",players,2,{stack:1}]
  ];
  const strategies = snapshots.map(([strategy,pool,difference,options]) => {
    if (!pool.some(player => player.selection !== "exclude" && Number.isFinite(player.points))) {
      return {strategy,skipped:"No eligible players with estimates for this objective."};
    }
    const {lineups,limited} = buildLineups(pool,count,difference,160000,sport,options);
    if (lineups.length !== count) {
      return {strategy,built:lineups.length,limited,skipped:"Could not build the requested number of lineups."};
    }
    if (strategy==="Projection") projectionPortfolio=lineups;
    candidates.push(...lineups);
    return summarize(strategy,lineups,limited);
  });
  const tournament = buildFootballTournament(players,count,2,160000,{sport});
  strategies.push(tournament.lineups.length === count ?
    summarize(sport+" Tournament Simulation",tournament.lineups,tournament.limited) :
    {strategy:sport+" Tournament Simulation",built:tournament.lineups.length,limited:tournament.limited,
      skipped:"Could not build the requested number of lineups."});
  const top3 = buildFootballTournament(players,count,2,160000,{target:"top3",sport});
  strategies.push(top3.lineups.length === count ?
    summarize(sport+" Top-3% Portfolio",top3.lineups,top3.limited) :
    {strategy:sport+" Top-3% Portfolio",built:top3.lineups.length,limited:top3.limited,skipped:"Could not fill the requested portfolio."});
  const top1 = sport==="CFB" ? buildFootballTournament(players,count,2,160000,{target:"top1",sport}) : null;
  if (top1) {
    const strategy="CFB Top-1% Portfolio";
    strategies.push(top1.lineups.length===count ? summarize(strategy,top1.lineups,top1.limited) :
      {strategy,built:top1.lineups.length,limited:top1.limited,skipped:"Could not fill the requested portfolio."});
  }
  const allTop10 = sport==="CFB" ? buildFootballTournament(players,count,2,160000,{target,sport}) : null;
  if (allTop10) {
    const strategy=cfbStrategy;
    strategies.push(allTop10.lineups.length===count ? summarize(strategy,allTop10.lineups,allTop10.limited) :
      {strategy,built:allTop10.lineups.length,limited:allTop10.limited,skipped:"Could not fill the requested portfolio."});
  }
  if (simulate && candidates.length) {
    const unique = new Map(candidates.map(lineup => [JSON.stringify([...lineup.ids].sort()),lineup]));
    const ranked = [...unique.values()].sort((a,b) => {
      const left = simulate(a);
      const right = simulate(b);
      return right.top3Share-left.top3Share || right.topOnePercentShare-left.topOnePercentShare || right.winShare-left.winShare ||
        left.fieldDuplicates-right.fieldDuplicates;
    });
    if (ranked.length >= count) {
      strategies.push(summarize("Top-3% external simulation selection",ranked.slice(0,count),strategies.some(result => result.limited)));
    }
  }
  const seeds=slate.simulationSeeds ?? [];
  if (!Array.isArray(seeds) || seeds.length>8 || new Set(seeds).size!==seeds.length ||
      seeds.some(seed=>!Number.isInteger(seed) || seed<=0 || seed>0xffffffff)) {
    throw new Error("Supply up to eight distinct, nonzero NFL validation seeds.");
  }
  const validationPortfolio=allTop10 ?? top3;
  const independentSimulation = projectionPortfolio && validationPortfolio.lineups.length===count ?
    seeds.map(seed=>compareNFLPortfolios(players,validationPortfolio.lineups,projectionPortfolio,{
      seed,sport,target:sport==="CFB" ? target : "top3"
    })) : [];
  return report(strategies,independentSimulation);

  function report(strategies,independentSimulation) {
    return {strategies,independentSimulation,fieldSize,top3Cutoff:cutoff ?? null,top1Cutoff:top1Cutoff ?? null,
      provenance:{contestId:slate.contestId ?? null,lockAt:slate.lockAt ?? null,archiveUsed:Boolean(archived),
        holdout:slate.holdout === true,preLockTimestampsVerified:timed,sha256:hashes}};
  }

  function summarize(strategy,lineups,limited) {
    const scores = lineups.map(lineup => lineup.picks.reduce((sum,{player}) => {
      if (!Number.isFinite(actuals.get(player.id))) throw new Error("Missing actual score for "+player.name+" ("+player.id+").");
      return sum+actuals.get(player.id);
    },0));
    const result = {
      strategy,built:lineups.length,limited,
      lineupScores:scores.map(round),meanActualFpts:round(mean(scores)),bestActualFpts:round(Math.max(...scores))
    };
    if (fieldScores) {
      // Insert the full portfolio against the observed field. Its entries also compete with each other.
      const portfolio=scores.map(value=>Math.round(value*100));
      const ranks=portfolio.map(value=>1+fieldScores.filter(n=>n>value).length+portfolio.filter(n=>n>value).length);
      result.paperRanks=ranks;
      result.paperFirst=ranks.includes(1);
      result.paperAllTop10=ranks.every(rank=>rank<=10);
      result.paperFirstAndAllTop10=result.paperFirst && result.paperAllTop10;
      result.worstPaperRank=Math.max(...ranks);
      result.gapToFirst=round(Math.max(0,fieldScores[0]/100-Math.max(...scores)));
    }
    if (Number.isFinite(slate.cashScore)) result.cashCutoffHits = scores.filter(score => round(score) >= round(slate.cashScore)).length;
    if (Number.isFinite(top1Cutoff)) {
      result.topOnePercentCutoffHits = scores.filter(score => round(score) >= round(top1Cutoff)).length;
      result.contestTop1=result.topOnePercentCutoffHits>0;
      result.gapToTop1=round(Math.max(0,top1Cutoff-Math.max(...scores)));
    }
    if (Number.isFinite(cutoff)) {
      result.top3CutoffHits = scores.filter(score => round(score) >= round(cutoff)).length;
      result.top3EntryRate = result.top3CutoffHits / scores.length;
      result.contestTop3 = result.top3CutoffHits > 0;
      result.gapToTop3 = round(Math.max(0,cutoff-Math.max(...scores)));
    }
    if (Number.isFinite(slate.firstPlaceScore)) {
      result.firstPlaceScoreHits = scores.filter(score => round(score) >= round(slate.firstPlaceScore)).length;
    }
    if (simulate) result.contestSimulation = lineups.map(simulate);
    return result;
  }
}

try {
  const input = process.argv[2];
  if (!input) throw new Error("Usage: node scripts/benchmark-nfl.mjs path/to/manifest.json");
  const {slates,count = 5,sport = "NFL",target="allTop10"} = JSON.parse(read(input));
  if (!["NFL","CFB"].includes(sport)) throw new Error("Manifest sport must be NFL or CFB.");
  if (sport==="CFB" && !["allTop10","firstAndTop10"].includes(target)) throw new Error("Choose a supported CFB benchmark target.");
  if (sport==="CFB" && count>10) throw new Error("Request up to ten lineups per strategy for the CFB top-10 comparison.");
  if (!Array.isArray(slates) || !slates.length || !Number.isInteger(count) || count < 1 || count > 20) {
    throw new Error("Supply at least one slate and request 1–20 lineups per strategy.");
  }
  const holdouts = slates.filter(slate => slate.holdout === true);
  const ids = slates.map(slate => slate.contestId?.trim()).filter(Boolean);
  if (new Set(ids).size !== ids.length) throw new Error("Duplicate contest ID in manifest.");
  const holdoutLocks = holdouts.map(slate => Date.parse(slate.lockAt));
  if (new Set(holdoutLocks).size !== holdoutLocks.length) throw new Error("Use one held-out contest per slate lock.");
  if (holdouts.length && slates.some(slate => slate.holdout !== true &&
      !(Date.parse(slate.lockAt) < Math.min(...holdoutLocks)))) {
    throw new Error("Training and evaluation periods overlap or have missing lock times.");
  }
  const results = slates.map(slate => {
    try {
      return {slate:slate.name,...benchmarkSlate(slate,dirname(resolve(input)),count,sport,target)};
    } catch (error) {
      throw new Error((slate.name || slate.salary)+": "+error.message);
    }
  });
  const metric=sport==="CFB" ? (target==="firstAndTop10" ? "paperFirstAndAllTop10" : "paperAllTop10") : "contestTop3";
  const strategy=sport==="CFB" ? (target==="firstAndTop10" ? "CFB First + All Top 10" : "CFB All-Top-10 Portfolio") : "NFL Top-3% Portfolio";
  const paired = results.filter(result => result.provenance.holdout).map(result => [
    result.strategies.find(item => item.strategy === strategy),
    result.strategies.find(item => item.strategy === "Projection")
  ]).filter(pair => pair.every(item => typeof item?.[metric] === "boolean"));
  const tournament = paired.filter(([item]) => item[metric]).length;
  const projection = paired.filter(([,item]) => item[metric]).length;
  const objective=sport==="CFB" ? {targetRank:10,allLineups:true,
    tournamentFirst:paired.filter(([item])=>item.paperFirst).length,
    projectionFirst:paired.filter(([,item])=>item.paperFirst).length,
    tournamentFirstAndAllTop10:paired.filter(([item])=>item.paperFirst && item.paperAllTop10).length,
    projectionFirstAndAllTop10:paired.filter(([,item])=>item.paperFirst && item.paperAllTop10).length
  } : {targetPercent:3};
  const holdout = {...objective,requested:holdouts.length,paired:paired.length,tournament,projection,
    improved:paired.filter(([a,b]) => a[metric] && !b[metric]).length,
    regressed:paired.filter(([a,b]) => !a[metric] && b[metric]).length,
    tournamentInterval:wilsonInterval(tournament,paired.length),
    projectionInterval:wilsonInterval(projection,paired.length)};
  console.log(JSON.stringify({sport,lineupsPerStrategy:count,holdout,results},null,2));
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
