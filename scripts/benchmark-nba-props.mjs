import {readFile,readdir} from "node:fs/promises";
import {createHash} from "node:crypto";
import {join} from "node:path";
import vm from "node:vm";
import {pregameObservations,minutesAdjustedMarket,discreteMarketProbabilities} from "../nba-projection-research.js";

const [historyDir,holdoutDate] = process.argv.slice(2);
function validDate(date) {
  if (!/^\d{8}$/.test(date ?? "")) return false;
  const iso=date.slice(0,4)+"-"+date.slice(4,6)+"-"+date.slice(6);
  const parsed=Date.parse(iso);
  return Number.isFinite(parsed) && new Date(parsed).toISOString().slice(0,10)===iso;
}
if (!historyDir || !validDate(holdoutDate)) {
  throw new Error("Usage: node scripts/benchmark-nba-props.mjs RESULTS_DIRECTORY HOLDOUT_YYYYMMDD");
}

const html = await readFile(new URL("../index.html",import.meta.url),"utf8");
function source(from,to) {
  const start=html.indexOf(from);
  const end=html.indexOf(to,start);
  if (start<0 || end<0) throw new Error("Could not locate the NBA estimator in index.html");
  return html.slice(start,end);
}
const {markets,stat,estimate,floors} = vm.runInNewContext([
  source("function normalCDF","function grade("),
  source("const modelMarketColumns","const modelPlayerKey"),
  source("const modelSpreadFloor","function estimateNBAProps"),
  "({markets:modelMarkets,stat:nbaStatValue,estimate:lineHitEstimate,floors:modelSpreadFloor})"
].join("\n"));

const eastern = new Intl.DateTimeFormat("en-CA",{timeZone:"America/New_York",day:"2-digit",month:"2-digit",year:"numeric"});
const historicalDay = date => eastern.format(date).replaceAll("-","");
const scheduled = new Map();
const hashes = {};
for (const file of (await readdir(historyDir)).sort()) {
  if (!/^\d{8}\.json$/.test(file)) continue;
  const day=file.slice(0,8);
  const raw=await readFile(join(historyDir,file),"utf8");
  const data=JSON.parse(raw);
  if (!validDate(day) || !Array.isArray(data.results) || data.partial!==false) throw new Error("Expected complete final results in "+file);
  hashes[file]=createHash("sha256").update(raw).digest("hex");
  for (const game of data.results) {
    const start=Date.parse(game?.start);
    if (!Number.isFinite(start) || historicalDay(start)!==day || !Array.isArray(game.players) || !game.players.length) {
      throw new Error("Invalid game or date in "+file);
    }
    for (const player of game.players) {
      if (!String(player?.id ?? "").trim() || !String(player.team ?? "").trim() ||
          !Number.isFinite(player.minutes) || !(player.minutes>0 && player.minutes<=68) ||
          player.values?.length!==4 || !player.values.every(value=>Number.isInteger(value) && value>=0)) {
        throw new Error("Invalid final result in "+file);
      }
      const key=JSON.stringify([String(player.id),start]);
      const observation={day,start,player:{id:String(player.id),team:player.team,minutes:player.minutes,
        starter:player.starter,values:player.values}};
      const prior=scheduled.get(key);
      if (prior && JSON.stringify(prior)!==JSON.stringify(observation)) throw new Error("Conflicting player-game result in "+file);
      scheduled.set(key,observation);
    }
  }
}

const history = new Map();
const scores = new Map();
const reportGroups = new Map();
const labels=["original","dashboard","minutesAdjusted"];
function categorize(values,line,result) {
  if (!result) return null;
  const push=Number.isInteger(line) ? (result.ties+.5)/(values.length+1) : 0;
  return {more:result.chance*(1-push),less:(1-result.chance)*(1-push),push};
}
function score(group,prediction,outcome) {
  group.rows++;
  group.brier+=["more","less","push"].reduce((sum,key)=>sum+(prediction[key]-Number(outcome===key))**2,0)/2;
  group.logLoss-=Math.log(Math.max(1e-12,prediction[outcome]));
  const bin=Math.min(9,Math.floor(prediction.more*10));
  const stats=group.moreCalibration[bin];
  stats.n++;
  stats.total+=prediction.more;
  stats.observed+=Number(outcome==="more");
}
function writeScore(split,market,lineKind,label,prediction,outcome) {
  const key=JSON.stringify([split,market,lineKind,label]);
  const group=scores.get(key) ?? {split,market,lineKind,label,rows:0,brier:0,logLoss:0,
    moreCalibration:Array.from({length:10},()=>({n:0,total:0,observed:0}))};
  score(group,prediction,outcome);
  scores.set(key,group);
}
for (const {day,start,player} of [...scheduled.values()].sort((a,b)=>a.start-b.start || a.player.id.localeCompare(b.player.id))) {
  const key=JSON.stringify([player.id,player.team]);
  const prior=history.get(key) ?? [];
  const games=pregameObservations(prior.filter(game=>game.day<day),start,{windowDays:11,limit:6});
  history.set(key,[...prior.filter(game=>start-Date.parse(game.date)<=14*86400000),
    {day,date:new Date(start).toISOString(),...player}]);
  if (games.length<4 || games.reduce((sum,game)=>sum+game.minutes,0)/games.length<18) continue;

  const split=day>=holdoutDate ? "Holdout" : "Development";
  for (const market of markets) {
    const value=values=>stat(values,market);
    const values=games.map(game=>value(game.values));
    const ordered=[...values].sort((a,b)=>a-b);
    const median=(ordered[Math.floor(values.length/2)]+ordered[Math.floor((values.length-1)/2)])/2;
    const actual=value(player.values);
    // The most recent prior role is observable before this game.
    const model=minutesAdjustedMarket(games,value,{starter:games[0].starter,marketFloor:floors[market]});
    if (!model) continue;
    const coverage=reportGroups.get(split) ?? {games:new Set(),players:new Set(),mae:{dashboard:0,minutesAdjusted:0},forecasts:0};
    coverage.games.add(start);
    coverage.players.add(player.id);
    coverage.forecasts++;
    coverage.mae.dashboard+=Math.abs(actual-values.reduce((sum,n)=>sum+n,0)/values.length);
    coverage.mae.minutesAdjusted+=Math.abs(actual-model.projection);
    reportGroups.set(split,coverage);
    for (const offset of [-2,-1,0,1,2]) {
      for (const fraction of [0,.5]) {
        const line=Math.floor(median)+offset+fraction;
        if (line<=0) continue;
        const predictions=[categorize(values,line,estimate(values,line,"MORE")),
          categorize(values,line,estimate(values,line,"MORE",market)),discreteMarketProbabilities(model,line)];
        if (predictions.some(prediction=>!prediction)) continue;
        const outcome=actual>line ? "more" : actual<line ? "less" : "push";
        for (const [i,label] of labels.entries()) {
          for (const name of ["All markets",market]) writeScore(split,name,fraction ? "half point" : "integer",label,predictions[i],outcome);
        }
      }
    }
  }
}

if (![...scores.values()].some(score=>score.split==="Holdout")) {
  throw new Error("No eligible holdout estimates. Supply more complete dates before the holdout.");
}
const coverage=Object.fromEntries([...reportGroups].map(([split,g])=>[split,{
  playerCount:g.players.size,tipoffCount:g.games.size,forecasts:g.forecasts,
  meanAbsoluteError:Object.fromEntries(Object.entries(g.mae).map(([name,total])=>[name,total/g.forecasts]))
}]));
console.log(JSON.stringify({holdoutDate,provenance:{lineSource:"synthetic from pregame box scores",overlappingRows:true,sha256:hashes},
  coverage,scores:[...scores.values()].map(g=>({...g,brier:g.brier/g.rows,logLoss:g.logLoss/g.rows,
    moreCalibration:g.moreCalibration.map(({n,total,observed},i)=>({bin:i,count:n,meanPrediction:n?total/n:null,observedRate:n?observed/n:null}))
  }))},null,2));
