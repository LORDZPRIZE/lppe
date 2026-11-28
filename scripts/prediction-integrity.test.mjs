import assert from "node:assert/strict";
import test from "node:test";
import {execFileSync,spawnSync} from "node:child_process";
import {mkdtempSync,rmSync,writeFileSync} from "node:fs";
import {join} from "node:path";
import {tmpdir} from "node:os";
import {applyPlayerProjections,importPlayers,matchName} from "../fanduel-optimizer.js";
import {addRotations,nbaRoleProjections} from "../fanduel-nba-tournament.js";
import {pregameObservations,minutesAdjustedMarket,discreteMarketProbabilities} from "../nba-projection-research.js";
import worker from "../worker/lppe-api.js";

const column = "ID,Name,Team,Projection,Ceiling,Ownership,Game Date,Projection Updated At\n";
const p=(id,name,team="DEN",gameDate)=>({id,name,team,gameDate,points:10,ceiling:25,ownership:.2});

test("projection joins preserve exact namespaces, Unicode, dates and selected-row metadata",()=>{
  const players=[p("1","Nicola Jokić","DEN","2026-11-22"),p("2","Sam Smith","KC","2026-11-23"),p("3","John Young")];
  const result=applyPlayerProjections(players,column+
    "1,Nicola Jokic,DEN,30,40,10,2026-11-22,2026-11-22T12:00Z\n"+
    "external,Sam Smith,KC,19,18,5,2026-11-23,\n"+
    "2,Sam Smith,KC,99,100,80,2026-11-22,\n"+
    "3,John Young,NYK,30,40,90,,\n"+
    ",John Young,DEN,50,60,4,,","NBA");
  assert.equal(result.players[0].points,30);
  assert.equal(result.players[0].ceiling,40);
  assert.equal(result.players[0].ownership,.10);
  assert.equal(result.players[1],players[1]);
  assert.equal(result.players[2],players[2]);
  assert.deepEqual(result.projectionMatches,{id:1,name:0,variant:0,ambiguous:2,unmatched:0});
  assert.equal(matchName("Ａdam"),"adam");
});

test("explicit suffix conflicts and known-player IDs cannot be reassigned by name",()=>{
  const players=[p("1","Alex Smith Jr."),p("2","Jay Lee"),p("3","Pat Doe"),p("5","Independent")];
  const result=applyPlayerProjections(players,column+
    ",Alex Smith Sr.,DEN,90,,,,\n"+
    "3,Jay Lee,DEN,80,,,,\n"+
    ",Pat Doe,DEN,20,,,,\n"+
    "4,Pat Doe,DEN,20,,,,\n"+
    ",Independent,DEN,11,,,,","NBA");
  assert.deepEqual(result.players.slice(0,3),players.slice(0,3));
  assert.equal(result.players[3].points,11);
  assert.equal(result.matched,1);
});

test("historical matching excludes future rows and does not inherit an incompatible ceiling",()=>{
  const players=[p("1","Adam One"),p("2","Adam Two"),p("3","Adam Three")];
  const result=applyPlayerProjections(players,column+
    "1,Adam One,DEN,30,20,30,,2026-11-22T12:00Z\n"+
    "2,Adam Two,DEN,45,90,40,,2026-11-22T15:00Z\n"+
    "3,Adam Three,DEN,15,23,40,,2026-11-22T11:00Z\n"+
    "3,Adam Three,DEN,15,34,50,,2026-11-22T11:00Z","NBA",{asOf:Date.parse("2026-11-22T13:00Z")});
  assert.equal(result.players[0].ceiling,undefined);
  assert.equal(result.players[1],players[1]);
  assert.equal(result.players[2].points,15);
  assert.equal(result.players[2].ceiling,undefined);
  assert.equal(result.players[2].ownership,.2);
  assert.throws(()=>importPlayers("ID,Name,Position,Team,Salary,Projection\n1,A,PG,DEN,6000,10\n1,A,SG,DEN,6000,11"),/Conflicting rows/);
});

const now=Date.parse("2026-11-22T18:00Z");
const logs=Array.from({length:7},(_,i)=>({date:new Date(now-(i+1)*86400000).toISOString(),
  minutes:32-i,starter:i<4,values:[12+i,6,4,2]}));

test("NBA history is sorted, deduplicated and fails closed for changed samples and ambiguous names",()=>{
  const observations=pregameObservations([logs[0],{...logs[0],minutes:30},logs[2],logs[1],logs[1],
    {...logs[0],date:new Date(now).toISOString()},{...logs[0],date:"2026-11-22T10:00Z",minutes:69}],now);
  assert.deepEqual(observations.map(g=>g.date),[logs[1].date,logs[2].date]);
  const players=[{...p("1","Chris"),source:"FanDuel FPPG",positions:["PG"]},p("2","Chris")];
  assert.deepEqual(addRotations(players,[{player:"Chris",team:"DEN",games:logs}],now),players);
  const [joined]=addRotations(players.slice(0,1),[{player:"Chris",team:"DEN",games:[...logs].reverse()}],now);
  assert.equal(joined.rotation.length,6);
  assert.equal(joined.rotation[0].minutes,32);
  const invalid={...joined,rotation:joined.rotation.slice(0,2)};
  assert.equal(nbaRoleProjections([invalid])[0],invalid);
});

test("research estimate caps usage, models pushes and produces coherent probabilities",()=>{
  const model=minutesAdjustedMarket(logs,v=>v[0],{starter:true,marketFloor:4});
  assert.equal(model.roleGames,4);
  assert.ok(model.minutes>28 && model.minutes<=32);
  assert.ok(model.projection>0 && model.spread>=4);
  assert.equal(minutesAdjustedMarket(logs.slice(0,3),v=>v[0]),null);
  for (const line of [0,15,15.5]) {
    const {more,less,push}=discreteMarketProbabilities(model,line);
    assert.ok(Math.abs(more+less+push-1)<1e-12);
    assert.equal(push>0,Number.isInteger(line));
    if (!line) assert.equal(less,0);
  }
});

test("NBA prop backtest measures complete calendar-split evidence and rejects conflicting box scores",()=>{
  const root=mkdtempSync(join(tmpdir(),"lppe-props-"));
  try {
    const player={id:"1",team:"DEN",minutes:30,starter:true,values:[12,6,4,2]};
    for(let i=1;i<=8;i++) {
      const day="2026110"+i;
      const game={start:"2026-11-0"+i+"T23:00:00Z",players:[player]};
      writeFileSync(join(root,day+".json"),JSON.stringify({results:[game],partial:false}));
    }
    const args=["scripts/benchmark-nba-props.mjs",root,"20261107"];
    const report=JSON.parse(execFileSync(process.execPath,args,{encoding:"utf8"}));
    assert.equal(report.coverage.Holdout.forecasts,16);
    assert.ok(report.scores.some(row=>row.lineKind==="integer" && row.label==="minutesAdjusted"));
    assert.ok(report.scores.every(row=>Number.isFinite(row.logLoss) && row.moreCalibration.reduce((sum,b)=>sum+b.count,0)===row.rows));
    assert.match(report.provenance.sha256["20261107.json"],/^[a-f0-9]{64}$/);
    const game={start:"2026-11-08T23:00:00Z",players:[player,{...player,values:[11,6,4,2]}]};
    writeFileSync(join(root,"20261108.json"),JSON.stringify({results:[game],partial:false}));
    assert.match(spawnSync(process.execPath,args,{encoding:"utf8"}).stderr,/Conflicting player-game/);
  } finally {
    rmSync(root,{recursive:true,force:true});
  }
});

test("Worker health exposes deployment metadata without sending a provider request",async()=>{
  const response=await worker.fetch(new Request("https://lppe.example/health"),{LPPE_VERSION:{id:"test-id",tag:"test-tag"}});
  assert.equal(response.status,200);
  const body=await response.json();
  assert.equal(body.version,"0.7");
  assert.equal(body.revision,"test-id");
  assert.equal(body.tag,"test-tag");
});

test("NBA forecast benchmark audits matching inputs, full roster IDs and claimed timing",()=>{
  const root=mkdtempSync(join(tmpdir(),"lppe-forecast-"));
  try {
    const rows=Array.from({length:30},(_,i)=>[String(i+1),"Player "+i,["PG","SG","SF","PF","C"][i%5],
      ["DEN","NYK","LAL","BOS"][i%4],5000,20]);
    writeFileSync(join(root,"salary.csv"),"ID,Name,Position,Team,Salary,FPPG\n"+rows.map(row=>row.join(",")).join("\n"));
    const otherRows=rows.map(row=>row[0]+",24,2026-11-22T16:00Z");
    writeFileSync(join(root,"projection.csv"),"ID,Projection,Projection Updated At\n"+otherRows.join("\n"));
    writeFileSync(join(root,"actuals.csv"),"ID,Actual FPTS\n"+rows.map(row=>row[0]+",25").join("\n"));
    const slate={name:"Fixture",date:"2026-11-22",lockAt:"2026-11-22T19:00Z",salaryCapturedAt:"2026-11-22T15:00Z",
      projectionsCapturedAt:"2026-11-22T17:00Z",salary:"salary.csv",projections:"projection.csv",actuals:"actuals.csv",topThreePercentScore:225};
    const manifest=join(root,"slates.json");
    const args=["scripts/benchmark-nba.mjs",manifest];
    writeFileSync(manifest,JSON.stringify({slates:[slate]}));
    const report=JSON.parse(execFileSync(process.execPath,args,{encoding:"utf8"}));
    assert.equal(report.aggregate.equalSlateMeanAbsoluteErrorImprovement,4);
    assert.equal(report.slates[0].topLineup.updated.playerIds.length,9);
    assert.equal(report.slates[0].topLineup.updated.reachedTop3Cutoff,true);
    assert.match(report.slates[0].provenance.sha256.projections,/^[a-f0-9]{64}$/);
    writeFileSync(manifest,JSON.stringify({slates:[{...slate,projectionsCapturedAt:"2026-11-22T15:00Z"}]}));
    assert.notEqual(spawnSync(process.execPath,args,{encoding:"utf8"}).status,0);
  } finally {
    rmSync(root,{recursive:true,force:true});
  }
});
