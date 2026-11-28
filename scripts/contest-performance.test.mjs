import test from "node:test";
import assert from "node:assert/strict";
import {contestPerformance} from "./contest-performance.mjs";
const field = () => Array.from({length:100},(_,i)=>({entryid:String(i+1),rank:i+1,entryname:[4,5,6].includes(i+1)?"Stayonthesidelinez (1/3)":"other"}));
test("top 5 percent includes exact boundary, counts every entry",()=>{
 const r=contestPerformance(field(),"stayonthesidelinez");
 assert.equal(r.bestRank,4);assert.equal(r.bestPercentile,4);assert.equal(r.top5Count,2);assert.equal(r.top5Rate,2/3);assert.equal(r.contestTop5,true);
});
test("absent username is not a loss",()=>assert.equal(contestPerformance(field(),"missing").contestTop5,null));
test("reject duplicate entries and impossible ranks",()=>{
 const rows=field();rows[1].entryid=rows[0].entryid;assert.throws(()=>contestPerformance(rows,"other"));
 const invalid=field();invalid[0].rank=101;assert.throws(()=>contestPerformance(invalid,"other"));
});

test("top 3% starts at 34 entries, counts tied ranks, and excludes rank four in a field of 100",()=>{
 const rows = field();
 rows[1].rank = 1;
 rows[2].entryname = " Stayonthesidelinez (1/3) ";
 assert.equal(contestPerformance(rows,"Stayonthesidelinez").top3Count,1);
 assert.equal(contestPerformance(rows,"Stayonthesidelinez").contestTop3,true);
 assert.equal(contestPerformance(rows.slice(0,33),"other").top3Places,0);
 assert.equal(contestPerformance(rows.slice(0,34),"other").top3Places,1);
 assert.equal(contestPerformance(rows,"absent").top3Rate,null);
 rows[1].rank = 3;
 assert.throws(()=>contestPerformance(rows,"other"),/competition ranks/);
});
