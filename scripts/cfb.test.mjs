import assert from "node:assert/strict";
import test from "node:test";
import {execFileSync,spawnSync} from "node:child_process";
import {mkdtempSync,rmSync,writeFileSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {cfbGameKey,cfbMatchupIssue,importPlayers} from "../fanduel-optimizer.js";
import {buildFootballTournament,compareNFLPortfolios} from "../fanduel-nfl-tournament.js";
import {providerPool} from "../functions/api/nba/fanduel.js";
import {createContestSimulator} from "./nfl-contest-sim.mjs";

function fixture() {
  const teamPairs=[["ALA","AUB"],["OSU","MICH"],["TEX","TAMU"],["USC","UCLA"]];
  const rows=teamPairs.flatMap((pair,index)=>pair.flatMap((team,side)=>["QB","RB","RB","WR","WR","TE"].map((position,i)=>[
    "137134-"+(index*12+side*6+i),team+" Player "+i,position,6500+i*400,team,24-index+i*.5,pair[1-side]
  ])));
  const csv="ID,Name,Position,Salary,Team,Projection,Opponent\n"+rows.map(row=>row.join(",")).join("\n");
  return {rows,csv,players:importPlayers(csv,"","CFB").players};
}

test("CFB imports coalesce opposite spellings and detect contradictory games",()=>{
  assert.equal(cfbGameKey("MICH @ OSU","OSU"),"MICH/OSU");
  assert.equal(cfbGameKey("OSU vs. MICH","MICH"),"MICH/OSU");
  assert.equal(cfbGameKey("OSU/MICH","ALA"),"");
  assert.equal(cfbGameKey("UNKNOWN","ALA"),"");
  const {players}=fixture();
  assert.equal(cfbMatchupIssue(players),null);
  assert.match(cfbMatchupIssue([{...players[0],game:""},...players.slice(1)]),/verified Game/);
  assert.match(cfbMatchupIssue([{...players[0],game:"different"},...players.slice(1)]),/disagree/);
});

test("CFB provider paginates a complete 901-player slate and refuses incomplete input",async()=>{
  const {rows}=fixture();
  const raw=Array.from({length:901},(_,i)=>{
    const [,name,position,salary,team,fppg,opponent]=rows[i%rows.length];
    return {id:String(i+1),name,position,roster_positions:["SFLEX"],salary,team,fppg,opponent};
  });
  const slate={starts_at:new Date(Date.now()+3600000).toISOString(),players:901,id:"large",games:4};
  const requests=[];
  const result=await providerPool(path=>{
    const query=new URL(path,"https://example.test").searchParams;
    const offset=Number(query.get("offset"));
    const limit=Number(query.get("limit"));
    requests.push([offset,limit]);
    return raw.slice(offset,offset+limit);
  },slate,"CFB");
  assert.equal(result.players.length,901);
  assert.deepEqual(requests,[[0,200],[200,200],[400,200],[600,200],[800,101]]);
  assert.ok(result.players[0].positions.includes("QB"));
  assert.equal(cfbMatchupIssue(result.players),null);
  assert.match((await providerPool(()=>[] ,slate,"CFB")).error,/0 of 901/);
  const invalid=await providerPool(()=>{throw Error("should not read");},{...slate,players:2401},"CFB");
  assert.match(invalid.error,/supported range/);
});

test("CFB joint target respects Classic slots, stacks, exposures, and portfolio rank accounting",()=>{
  const {players}=fixture();
  const options={sport:"CFB",target:"allTop10",opponentCount:120,scenarioCount:128,seed:9,stack:1,exposure:100};
  players[0].selection="lock";
  players[5].maxExposure=50;
  const build=()=>buildFootballTournament(players,2,2,12000,options);
  const result=build();
  assert.deepEqual(build(),result);
  assert.equal(result.lineups.length,2);
  assert.equal(result.baseline.length,2);
  assert.ok(result.baseline.filter(lineup=>lineup.ids.has(players[5].id)).length<=1);
  assert.ok(result.lineups.filter(lineup=>lineup.ids.has(players[5].id)).length<=1);
  assert.equal(result.simulation.target,"allTop10");
  for (const l of result.lineups) {
    assert.equal(l.ids.size,7);
    assert.ok(l.ids.has(players[0].id));
    assert.ok(l.salary<=60000);
    const picks=l.picks.map(p=>p.player);
    assert.ok(new Set(picks.map(p=>p.team)).size>=3);
    assert.ok(new Set(picks.map(p=>p.game)).size>=2);
    assert.ok(picks.slice(3,6).every(p=>p.positions.some(pos=>pos==="WR" || pos==="TE")));
    assert.ok(picks.some((p,i)=>i && p.team===picks[0].team && p.positions.some(pos=>pos==="WR"||pos==="TE")));
  }
  assert.ok([...result.lineups[1].ids].filter(id=>!result.lineups[0].ids.has(id)).length>=2);
  assert.ok(result.simulation.firstAndAllTop10Coverage<=result.simulation.allTop10Coverage);
  assert.ok(result.simulation.firstAndAllTop10Coverage<=result.simulation.firstPointsCoverage);
  const comparison=compareNFLPortfolios(players,result.lineups,result.lineups,{...options,seed:1000});
  assert.equal(comparison.tournament,comparison.projection);
  assert.equal(comparison.improved+comparison.regressed,0);
  assert.throws(()=>buildFootballTournament(players,11,2,12000,options),/at most ten/);
  assert.throws(()=>buildFootballTournament([{...players[0],game:""},...players.slice(1)],2,2,12000,options),/verified Game/);
  const top1=buildFootballTournament(players,1,1,12000,{...options,target:"top1"});
  assert.ok(top1.simulation.top1Places>0);
  assert.ok(top1.lineups[0].tournament.top1<=top1.lineups[0].tournament.top3);
  const l=result.lineups[0];
  const row=l.picks.map(({player})=>player.id).join(",");
  const evaluate=createContestSimulator("Scenario,ID,FPTS\n"+players.map(p=>"one,"+p.id+",0").join("\n"),
    "QB,RB1,RB2,WR1,WR2,WR3,SFLEX\n"+Array(99).fill(row).join("\n"),players,"CFB");
  assert.equal(evaluate(l).topOnePercentShare,.01);
});

test("CFB benchmark derives cutoffs and ranks from a finalized exact-lock leaderboard",()=>{
  const {csv,players}=fixture();
  const temp=mkdtempSync(join(tmpdir(),"lppe-cfb-"));
  try {
    writeFileSync(join(temp,"salary.csv"),csv);
    const info=[["Seats Filled","120"],["Start Time","2026-11-28 12:00:00 ET"],["Slate","Main"]];
    const lines=["EntryId,EntryName,Rank,Points,Player,FPTS,Contest Info,Contest Value"];
    for (let i=0;i<120;i++) lines.push([i+1,"Test",i+1,111-i,
      players[i] ? "Player ("+players[i].id+")" : "",players[i]?16:"",...(info[i] ?? ["",""])].join(","));
    writeFileSync(join(temp,"field.csv"),lines.join("\n"));
    const path=join(temp,"manifest.json");
    const slate={name:"Example",slateLabel:"Sat Main",leaderboard:"field.csv",salary:"salary.csv",contestId:"cfb-1",
      holdout:true,lockAt:"2026-11-28T17:00:00Z",salaryCapturedAt:"2026-11-28T16:45:00Z"};
    writeFileSync(path,JSON.stringify({sport:"CFB",count:1,slates:[slate]}));
    const args=["scripts/benchmark-nfl.mjs",path];
    const report=JSON.parse(execFileSync(process.execPath,args,{encoding:"utf8"}));
    assert.equal(report.holdout.targetRank,10);
    assert.equal(report.holdout.paired,1);
    assert.equal(report.holdout.tournamentFirst,1);
    assert.equal(report.holdout.tournamentFirstAndAllTop10,1);
    assert.equal(report.results[0].top1Cutoff,111);
    assert.match(report.results[0].provenance.sha256.leaderboard,/^[a-f0-9]{64}$/);
    writeFileSync(path,JSON.stringify({sport:"CFB",count:1,slates:[{...slate,slateLabel:"Late"}]}));
    assert.match(spawnSync(process.execPath,args,{encoding:"utf8"}).stderr,/label and lock time/);
  } finally { rmSync(temp,{recursive:true,force:true}); }
});
