import {test} from "node:test";
import assert from "node:assert/strict";
import {execFileSync,spawnSync} from "node:child_process";
import {mkdtempSync,rmSync,writeFileSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {finalizedField,wilsonInterval} from "../fanduel-contest-metrics.js";
import {reviewContest,scoreSavedBuilds} from "../fanduel-optimizer.js";
import {pairHeldOut,readNBAArchive,summarizeTop3Pairs} from "../fanduel-nba-review.js";

function fixture() {
  const lineup=Array.from({length:9},(_,i)=>({id:"123-"+i}));
  const alternative=Array.from({length:9},(_,i)=>({id:"234-"+i}));
  const snapshot={sport:"NBA",slate:"Main",capturedAt:"2026-11-24T22:00:00Z",
    lockAt:"2026-11-25T00:00:00Z",requested:1,target:"top3",lineups:[lineup]};
  const records=[{initialTop3:snapshot,initialTop3Baseline:{...snapshot,lineups:[alternative]}}];
  const rows=Array.from({length:100},(_,i)=>({entryid:String(i+1),
    entryname:i===2 ? "Joey (1/2)" : i===3 ? "Joey (2/2)" : "Opponent",rank:String(i+1),points:String(108-i),won:"$0.00",
    ...(i<18 ? {player:"Player ("+(i<9 ? lineup[i] : alternative[i-9]).id+")",fpts:i<9 ? "12" : "11"} : {})}));
  const info={"Start Time":"2026-11-24 19:00:00 ET","Contest Name":"Contest 123",Slate:"Main","Seats Filled":"100"};
  for (const [index,[contestinfo,contestvalue]] of Object.entries(info).entries()) Object.assign(rows[index],{contestinfo,contestvalue});
  return {rows,records};
}

test("observed top 3% validates field size, ranks and cutoff without counting empty seats",()=>{
 const {rows}=fixture();
 const result=reviewContest(rows,"Joey");
 assert.equal(result.top3.top3Count,1);
 assert.equal(result.top3.top3Rate,.5);
 assert.equal(result.top3.bestPercentile,3);
 assert.equal(result.top3Cutoff,106);
 assert.equal(reviewContest(rows.slice(0,-1),"Joey").top3,null);
 const empty={...rows.at(-1),points:"null",lineup:""};
 assert.equal(finalizedField([...rows.slice(0,-1),empty]).length,99);
 assert.equal(reviewContest([...rows.slice(0,-1),empty],"Joey").top3.top3Places,2);
 assert.equal(finalizedField([...rows,{contestinfo:"Seats Filled",contestvalue:"99"}]),null);
 rows[2].rank="2";
 assert.equal(finalizedField(rows),null);
});

test("paper replay avoids partial portfolios, counts own entries and requires an exact slate match",()=>{
 const {rows,records}=fixture();
 const parsed=readNBAArchive(JSON.stringify(records));
 const cutoff=reviewContest(rows).cutoff;
 const replay=scoreSavedBuilds(rows,parsed,cutoff);
 const pair=pairHeldOut(rows,replay,"top3");
 assert.equal(pair.tournament.top3.bestRank,1);
 assert.equal(pair.projection.top3.contestTop3,false);
 assert.equal(pairHeldOut(rows,replay),null);
 assert.equal(pairHeldOut(rows,replay.map(r=>({...r,slate:"Late"})),"top3"),null);
 assert.equal(pairHeldOut(rows,replay.map(r=>({...r,requested:2})),"top3"),null);
 assert.equal(summarizeTop3Pairs([pair],"top3").improved,1);
 assert.equal(summarizeTop3Pairs([pair],"first").count,0);
 assert.deepEqual(wilsonInterval(0,0),null);
 assert.equal(wilsonInterval(1,1)[1],1);
 assert.equal(wilsonInterval(0,1)[0],0);
 const partial={...records[0].initialTop3,lineups:[records[0].initialTop3.lineups[0],[{id:"missing"}]]};
 assert.equal(scoreSavedBuilds(rows,[{latest:partial}],cutoff)[0].top3,null);
});

test("NBA contest command reproduces paired holdout results from files and rejects duplicate slate evidence",()=>{
 const {rows,records}=fixture();
 const root=mkdtempSync(join(tmpdir(),"lppe-nba-test-"));
 try {
   const columns=[...new Set(rows.flatMap(Object.keys))];
   const csv=[columns.join(","),...rows.map(row=>columns.map(key=>row[key]??"").join(","))].join("\n");
   writeFileSync(join(root,"field.csv"),csv);
   writeFileSync(join(root,"archive.json"),JSON.stringify(records));
   const manifest=join(root,"manifest.json");
   const slate={leaderboard:"field.csv",archive:"archive.json"};
   const run=(slates,holdoutFrom="2026-11-24T00:00:00Z")=>{
     writeFileSync(manifest,JSON.stringify({slates,holdoutFrom}));
     return [process.execPath,["scripts/benchmark-nba-contests.mjs",manifest]];
   };
   const report=JSON.parse(execFileSync(...run([slate]),{encoding:"utf8"}));
   assert.equal(report.summary.improved,1);
   assert.match(report.results[0].sha256.archive,/^[a-f0-9]{64}$/);
   assert.match(spawnSync(...run([slate,slate]),{encoding:"utf8"}).stderr,/one held-out contest/);
   assert.equal(spawnSync(...run([slate],"2026-11-26T00:00:00Z")).status,1);
 } finally {
   rmSync(root,{recursive:true,force:true});
 }
});
