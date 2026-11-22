import {readFileSync} from "node:fs";
import {dirname, resolve} from "node:path";
import {buildLineups, importPlayers, parseCSV} from "../fanduel-optimizer.js";

const mean = values => values.reduce((sum,value) => sum+value,0)/values.length;
const round = value => Number(value.toFixed(3));
const read = path => readFileSync(path,"utf8");

function benchmarkSlate(slate,root,count) {
  const readSlateFile = path => read(resolve(root,path));
  const {players} = importPlayers(
    readSlateFile(slate.salary),slate.projections ? readSlateFile(slate.projections) : "","NFL"
  );
  const actuals = new Map();
  for (const row of parseCSV(readSlateFile(slate.actuals))) {
    if (!row.id || !row.actualfpts || !Number.isFinite(Number(row.actualfpts)) || actuals.has(row.id)) {
      throw new Error("Actuals must have unique ID values and numeric Actual FPTS.");
    }
    actuals.set(row.id,Number(row.actualfpts));
  }
  const snapshots = [
    ["Projection",players,1,{}],
    ["High Ceiling",players.map(player => ({
      ...player,points:Number.isFinite(player.points) ? player.ceiling : NaN
    })),1,{}],
    ["Diversified + QB stack",players,2,{stack:1}]
  ];
  return snapshots.map(([strategy,pool,difference,options]) => {
    if (!pool.some(player => player.selection !== "exclude" && Number.isFinite(player.points))) {
      return {strategy,skipped:"No eligible players with estimates for this objective."};
    }
    const {lineups,limited} = buildLineups(pool,count,difference,160000,"NFL",options);
    if (lineups.length !== count) {
      return {strategy,built:lineups.length,limited,skipped:"Could not build the requested number of lineups."};
    }
    const scores = lineups.map(lineup => lineup.picks.reduce((sum,{player}) => {
      if (!actuals.has(player.id)) throw new Error("Missing actual score for "+player.name+" ("+player.id+").");
      return sum+actuals.get(player.id);
    },0));
    const result = {
      strategy,built:count,limited,
      lineupScores:scores.map(round),meanActualFpts:round(mean(scores)),bestActualFpts:round(Math.max(...scores))
    };
    if (Number.isFinite(slate.cashScore)) result.cashCutoffHits = scores.filter(score => round(score) >= round(slate.cashScore)).length;
    if (Number.isFinite(slate.topOnePercentScore)) {
      result.topOnePercentCutoffHits = scores.filter(score => round(score) >= round(slate.topOnePercentScore)).length;
    }
    return result;
  });
}

try {
  const input = process.argv[2];
  if (!input) throw new Error("Usage: node scripts/benchmark-nfl.mjs path/to/manifest.json");
  const {slates,count = 5} = JSON.parse(read(input));
  if (!Array.isArray(slates) || !slates.length || !Number.isInteger(count) || count < 1 || count > 20) {
    throw new Error("Supply at least one slate and request 1–20 lineups per strategy.");
  }
  const results = slates.map(slate => {
    try {
      return {slate:slate.name,strategies:benchmarkSlate(slate,dirname(resolve(input)),count)};
    } catch (error) {
      throw new Error((slate.name || slate.salary)+": "+error.message);
    }
  });
  console.log(JSON.stringify({lineupsPerStrategy:count,results},null,2));
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
