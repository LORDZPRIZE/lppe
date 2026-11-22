import {readFile, readdir} from "node:fs/promises";
import {join} from "node:path";
import vm from "node:vm";

const [historyDir, holdoutDate] = process.argv.slice(2);
if (!historyDir || !/^\d{8}$/.test(holdoutDate ?? "")) {
  throw new Error("Usage: node scripts/benchmark-nba-props.mjs RESULTS_DIRECTORY HOLDOUT_YYYYMMDD");
}

const html = await readFile(new URL("../index.html", import.meta.url), "utf8");
function source(from, to) {
  const start = html.indexOf(from);
  const end = html.indexOf(to, start);
  if (start < 0 || end < 0) throw new Error("Could not locate the NBA estimator in index.html");
  return html.slice(start,end);
}
const {markets, stat, estimate} = vm.runInNewContext([
  source("function normalCDF", "function grade("),
  source("const modelMarketColumns", "const modelPlayerKey"),
  source("const modelSpreadFloor", "function estimateNBAProps"),
  "({markets:modelMarkets,stat:nbaStatValue,estimate:lineHitEstimate})"
].join("\n"));

const scheduled = new Map();
for (const file of (await readdir(historyDir)).sort()) {
  if (!/^\d{8}\.json$/.test(file)) continue;
  const date = file.slice(0,8);
  const data = JSON.parse(await readFile(join(historyDir,file),"utf8"));
  if (!Array.isArray(data.results) || data.partial) throw new Error("Expected complete final results in " + file);
  for (const game of data.results) {
    for (const player of game.players) {
      if (!player.id || !player.team || !Number.isFinite(player.minutes) || player.minutes <= 0 ||
          player.values?.length !== 4 || !player.values.every(Number.isFinite) || !Number.isFinite(Date.parse(game.start))) {
        throw new Error("Invalid final result in " + file);
      }
      const key = JSON.stringify([player.id,player.team,Date.parse(game.start)]);
      scheduled.set(key,{date,start:Date.parse(game.start),player});
    }
  }
}

const history = new Map();
const scores = new Map();
for (const {date,start,player} of [...scheduled.values()].sort((a,b) => a.start-b.start)) {
  const key = JSON.stringify([player.id,player.team]);
  if (!history.has(key)) history.set(key,[]);
  const previous = history.get(key);
  const games = previous.filter(game => game.start < start && start-game.start <= 11*86400000).slice(-6);
  history.set(key,[...games,{start,player}]);
  if (games.length < 4 || games.reduce((sum,game) => sum+game.player.minutes,0)/games.length < 18) continue;

  for (const market of markets) {
    const values = games.map(game => stat(game.player.values,market));
    const ordered = [...values].sort((a,b) => a-b);
    const median = (ordered[Math.floor(values.length/2)]+ordered[Math.floor((values.length-1)/2)])/2;
    const center = Math.floor(median)+0.5;
    const actual = stat(player.values,market);
    for (const offset of [-2,-1,0,1,2]) {
      const line = center+offset;
      if (line <= 0) continue;
      const outcome = Number(actual > line);
      const baseline = estimate(values,line,"MORE").chance;
      const revised = estimate(values,line,"MORE",market).chance;
      const split = date >= holdoutDate ? "Holdout" : "Development";
      for (const name of ["All markets",market]) {
        const scoreKey = JSON.stringify([split,name]);
        const score = scores.get(scoreKey) ?? {split,market:name,rows:0,baseline:0,revised:0};
        score.rows++;
        score.baseline += (baseline-outcome)**2;
        score.revised += (revised-outcome)**2;
        scores.set(scoreKey,score);
      }
    }
  }
}

if (![...scores.values()].some(score => score.split === "Holdout")) {
  throw new Error("No eligible holdout estimates. Supply more complete dates before the holdout.");
}
console.log("Synthetic half-point lines derived from prior box scores. Rows overlap by player and game.");
console.table([...scores.values()].map(({rows,baseline,revised,...group}) => ({
  ...group,rows,"Original Brier":(baseline/rows).toFixed(5),"Revised Brier":(revised/rows).toFixed(5)
})));
