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
