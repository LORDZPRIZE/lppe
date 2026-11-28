import {createHash} from "node:crypto";
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
  const hashes={};
  const readSlateFile = key => {
    const raw=read(resolve(root,slate[key]));
    hashes[key]=createHash("sha256").update(raw).digest("hex");
    return raw;
  };
  const salary=readSlateFile("salary");
  if (parseCSV(salary).some(row=>row.projectionupdatedat && !(timestamp(row.projectionupdatedat)<=salaryCapturedAt))) {
    throw new Error("Salary snapshot contains a forecast updated after capture or without a verified time zone.");
  }
  const {players:baseline} = importPlayers(salary,"","NBA");
  const projectionText = readSlateFile("projections");
  if (!projectionText.trim()) throw new Error("Projection CSV is empty.");
  const {players:updated} = applyPlayerProjections(baseline,projectionText,"NBA",{date:slate.date,asOf:projectionsCapturedAt});

  const actuals = new Map();
  for (const row of parseCSV(readSlateFile("actuals"))) {
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
  let missingBaseline = 0;
  for (const [index,player] of baseline.entries()) {
    const forecast = updated[index];
    if (player.selection === "exclude" || forecast.source !== "Projection CSV") continue;
    matchedEligible++;
    if (!actuals.has(player.id)) {
      missingActuals++;
      continue;
    }
    if (!Number.isFinite(player.points)) { missingBaseline++; continue; }
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
    return {projectedFpts:round(lineup.points),actualFpts:round(actual),salary:lineup.salary,
      playerIds:lineup.picks.map(({player})=>player.id),
      ...(Number.isFinite(slate.topThreePercentScore) ? {
        reachedTop3Cutoff:round(actual)>=round(slate.topThreePercentScore),
        gapToTop3:round(Math.max(0,slate.topThreePercentScore-actual))
      } : {})};
  }

  return {
    report:{
      slate:slate.name,matchedEligible,matchedWithNoActuals:missingActuals,missingBaseline,pairedPlayers:baselineErrors.length,
      provenance:{lockAt:slate.lockAt,salaryCapturedAt:slate.salaryCapturedAt,projectionsCapturedAt:slate.projectionsCapturedAt,sha256:hashes},
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
  const locks=slates.map(slate=>timestamp(slate.lockAt));
  if (new Set(locks).size!==locks.length) throw new Error("Use one NBA comparison per slate lock.");
  const results = slates.map(slate => {
    try {
      return benchmarkSlate(slate,dirname(resolve(manifest)));
    } catch (error) {
      throw new Error((slate.name || slate.salary)+": "+error.message);
    }
  });
  const baseline = results.flatMap(result => result.baselineErrors);
  const updated = results.flatMap(result => result.updatedErrors);
  const comparable = results.filter(result=>result.baselineErrors.length);
  const improvements = comparable.map(({baselineErrors,updatedErrors})=>
    baselineErrors.reduce((sum,value,i)=>sum+Math.abs(value)-Math.abs(updatedErrors[i]),0)/baselineErrors.length);
  const equalSlateMeanAbsoluteErrorImprovement=improvements.length ?
    round(improvements.reduce((sum,value)=>sum+value,0)/improvements.length) : null;
  console.log(JSON.stringify({
    aggregate:{pairedPlayers:baseline.length,pairedSlates:comparable.length,equalSlateMeanAbsoluteErrorImprovement,
      baseline:accuracy(baseline),updated:accuracy(updated)},
    slates:results.map(result => result.report)
  },null,2));
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
