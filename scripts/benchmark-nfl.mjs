import {createHash} from "node:crypto";
import {wilsonInterval} from "../fanduel-contest-metrics.js";
import {readFileSync} from "node:fs";
import {dirname, resolve} from "node:path";
import {buildLineups, importPlayers, parseCSV} from "../fanduel-optimizer.js";

import {buildNFLTournament} from "../fanduel-nfl-tournament.js";
import {createContestSimulator} from "./nfl-contest-sim.mjs";

const mean = values => values.reduce((sum,value) => sum+value,0)/values.length;
const round = value => Number(value.toFixed(3));
const read = path => readFileSync(path,"utf8");

function benchmarkSlate(slate,root,count) {
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
  const timed = captureFields.every(key => timestamp(slate[key+"CapturedAt"]) < lockAt);
  if (slate.holdout === true && (!timed || !slate.contestId?.trim() || !Number.isFinite(slate.topThreePercentScore))) {
    throw new Error("Holdout slates need a contest ID, pre-lock timestamps for each model input and a numeric top-3% cutoff.");
  }
  const {players} = importPlayers(
    readSlateFile("salary"),slate.projections ? readSlateFile("projections") : "","NFL"
  );
  const actuals = new Map();
  for (const row of parseCSV(readSlateFile("actuals"))) {
    if (!row.id || !row.actualfpts || !Number.isFinite(Number(row.actualfpts)) || actuals.has(row.id)) {
      throw new Error("Actuals must have unique ID values and numeric Actual FPTS.");
    }
    actuals.set(row.id,Number(row.actualfpts));
  }
  if (Boolean(slate.scenarios) !== Boolean(slate.field)) {
    throw new Error("Contest simulation requires both scenarios and field CSVs.");
  }
  const simulate = slate.scenarios ? createContestSimulator(
    readSlateFile("scenarios"),readSlateFile("field"),players
  ) : null;
  const candidates = [];
  const snapshots = [
    ["Projection",players,1,{}],
    ["High Ceiling",players.map(player => ({
      ...player,points:Number.isFinite(player.points) ? player.ceiling : NaN
    })),1,{}],
    ["Diversified + QB stack",players,2,{stack:1}]
  ];
  const strategies = snapshots.map(([strategy,pool,difference,options]) => {
    if (!pool.some(player => player.selection !== "exclude" && Number.isFinite(player.points))) {
      return {strategy,skipped:"No eligible players with estimates for this objective."};
    }
    const {lineups,limited} = buildLineups(pool,count,difference,160000,"NFL",options);
    if (lineups.length !== count) {
      return {strategy,built:lineups.length,limited,skipped:"Could not build the requested number of lineups."};
    }
    candidates.push(...lineups);
    return summarize(strategy,lineups,limited);
  });
  const tournament = buildNFLTournament(players,count,2,160000);
  strategies.push(tournament.lineups.length === count ?
    summarize("NFL Tournament Simulation",tournament.lineups,tournament.limited) :
    {strategy:"NFL Tournament Simulation",built:tournament.lineups.length,limited:tournament.limited,
      skipped:"Could not build the requested number of lineups."});
  const top3 = buildNFLTournament(players,count,2,160000,{target:"top3"});
  strategies.push(top3.lineups.length === count ?
    summarize("NFL Top-3% Portfolio",top3.lineups,top3.limited) :
    {strategy:"NFL Top-3% Portfolio",built:top3.lineups.length,limited:top3.limited,skipped:"Could not fill the requested portfolio."});
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
  return {strategies,provenance:{contestId:slate.contestId ?? null,lockAt:slate.lockAt ?? null,
    holdout:slate.holdout === true,preLockTimestampsVerified:timed,sha256:hashes}};

  function summarize(strategy,lineups,limited) {
    const scores = lineups.map(lineup => lineup.picks.reduce((sum,{player}) => {
      if (!actuals.has(player.id)) throw new Error("Missing actual score for "+player.name+" ("+player.id+").");
      return sum+actuals.get(player.id);
    },0));
    const result = {
      strategy,built:lineups.length,limited,
      lineupScores:scores.map(round),meanActualFpts:round(mean(scores)),bestActualFpts:round(Math.max(...scores))
    };
    if (Number.isFinite(slate.cashScore)) result.cashCutoffHits = scores.filter(score => round(score) >= round(slate.cashScore)).length;
    if (Number.isFinite(slate.topOnePercentScore)) {
      result.topOnePercentCutoffHits = scores.filter(score => round(score) >= round(slate.topOnePercentScore)).length;
    }
    if (Number.isFinite(slate.topThreePercentScore)) {
      result.top3CutoffHits = scores.filter(score => round(score) >= round(slate.topThreePercentScore)).length;
      result.top3EntryRate = result.top3CutoffHits / scores.length;
      result.contestTop3 = result.top3CutoffHits > 0;
      result.gapToTop3 = round(Math.max(0,slate.topThreePercentScore-Math.max(...scores)));
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
  const {slates,count = 5} = JSON.parse(read(input));
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
      return {slate:slate.name,...benchmarkSlate(slate,dirname(resolve(input)),count)};
    } catch (error) {
      throw new Error((slate.name || slate.salary)+": "+error.message);
    }
  });
  const paired = results.filter(result => result.provenance.holdout).map(result => [
    result.strategies.find(item => item.strategy === "NFL Top-3% Portfolio"),
    result.strategies.find(item => item.strategy === "Projection")
  ]).filter(pair => pair.every(item => typeof item?.contestTop3 === "boolean"));
  const tournament = paired.filter(([item]) => item.contestTop3).length;
  const projection = paired.filter(([,item]) => item.contestTop3).length;
  const holdout = {requested:holdouts.length,paired:paired.length,tournament,projection,
    improved:paired.filter(([a,b]) => a.contestTop3 && !b.contestTop3).length,
    regressed:paired.filter(([a,b]) => !a.contestTop3 && b.contestTop3).length,
    tournamentInterval:wilsonInterval(tournament,paired.length),
    projectionInterval:wilsonInterval(projection,paired.length)};
  console.log(JSON.stringify({lineupsPerStrategy:count,holdout,results},null,2));
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
