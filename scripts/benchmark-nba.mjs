import {readFileSync} from "node:fs";
import {dirname, resolve} from "node:path";
import {applyPlayerProjections, buildLineups, importPlayers, parseCSV} from "../fanduel-optimizer.js";

const read = path => readFileSync(path,"utf8");
const round = value => Number(value.toFixed(3));
const timestamp = value => /T.*(?:Z|[+-]\d{2}:\d{2})$/i.test(value) ? Date.parse(value) : NaN;

function accuracy(errors) {
  if (!errors.length) return null;
  const sum = values => values.reduce((total,value) => total+value,0);
  return {
    meanAbsoluteError:round(sum(errors.map(Math.abs))/errors.length),
    rootMeanSquareError:round(Math.sqrt(sum(errors.map(error => error**2))/errors.length)),
    bias:round(sum(errors)/errors.length)
  };
}

function benchmarkSlate(slate,root) {
  const lockAt = timestamp(slate.lockAt);
  const salaryCapturedAt = timestamp(slate.salaryCapturedAt);
  const projectionsCapturedAt = timestamp(slate.projectionsCapturedAt);
  if (!(salaryCapturedAt < lockAt && projectionsCapturedAt < lockAt)) {
    throw new Error("Provide salary and projection capture timestamps before the slate lock.");
  }
  const readSlateFile = file => read(resolve(root,file));
  const {players:baseline} = importPlayers(readSlateFile(slate.salary),"","NBA");
  const projectionText = readSlateFile(slate.projections);
  if (!projectionText.trim()) throw new Error("Projection CSV is empty.");
  const {players:updated} = applyPlayerProjections(baseline,projectionText,"NBA",{date:slate.date});

  const actuals = new Map();
  for (const row of parseCSV(readSlateFile(slate.actuals))) {
    const score = row.actualfpts === "" || !Object.hasOwn(row,"actualfpts") ? NaN : Number(row.actualfpts);
    if (!row.id || !Number.isFinite(score) || actuals.has(row.id)) {
      throw new Error("Actuals must have unique ID values and numeric Actual FPTS.");
    }
    actuals.set(row.id,score);
  }

  const baselineErrors = [];
  const updatedErrors = [];
  let matchedEligible = 0;
  let missingActuals = 0;
  for (const [index,player] of baseline.entries()) {
    const forecast = updated[index];
    if (player.selection === "exclude" || forecast.source !== "Projection CSV") continue;
    matchedEligible++;
    if (!actuals.has(player.id)) {
      missingActuals++;
      continue;
    }
    if (!Number.isFinite(player.points)) continue;
    const actual = actuals.get(player.id);
    baselineErrors.push(player.points-actual);
    updatedErrors.push(forecast.points-actual);
  }

  function scoreLineup(pool) {
    const {lineups:[lineup]} = buildLineups(pool,1,1,Infinity,"NBA",{exactFirst:true});
    if (!lineup) throw new Error("Could not build a valid NBA roster from this snapshot.");
    let actual = 0;
    for (const {player} of lineup.picks) {
      if (!actuals.has(player.id)) throw new Error("Missing actual score for "+player.name+" ("+player.id+").");
      actual += actuals.get(player.id);
    }
    return {projectedFpts:round(lineup.points),actualFpts:round(actual),salary:lineup.salary};
  }

  return {
    report:{
      slate:slate.name,matchedEligible,matchedWithNoActuals:missingActuals,pairedPlayers:baselineErrors.length,
      forecastAccuracy:{baseline:accuracy(baselineErrors),updated:accuracy(updatedErrors)},
      topLineup:{baseline:scoreLineup(baseline),updated:scoreLineup(updated)}
    },
    baselineErrors,updatedErrors
  };
}

try {
  const manifest = process.argv[2];
  if (!manifest) throw new Error("Usage: node scripts/benchmark-nba.mjs path/to/manifest.json");
  const {slates} = JSON.parse(read(manifest));
  if (!Array.isArray(slates) || !slates.length) throw new Error("Supply at least one slate.");
  const results = slates.map(slate => {
    try {
      return benchmarkSlate(slate,dirname(resolve(manifest)));
    } catch (error) {
      throw new Error((slate.name || slate.salary)+": "+error.message);
    }
  });
  const baseline = results.flatMap(result => result.baselineErrors);
  const updated = results.flatMap(result => result.updatedErrors);
  console.log(JSON.stringify({
    aggregate:{pairedPlayers:baseline.length,baseline:accuracy(baseline),updated:accuracy(updated)},
    slates:results.map(result => result.report)
  },null,2));
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
