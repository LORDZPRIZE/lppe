import test from "node:test";
import assert from "node:assert/strict";
import {assessProp, settles, assessEntry} from "../src/evidence-gate.mjs";
const now=Date.parse("2026-11-22T20:00:00Z");
const prop={playerId:"123",gameId:"game1",market:"rebounds",side:"MORE",line:10,
 lineSource:"prizepicks-public",lineObservedAt:"2026-11-22T19:58:00Z",offerType:"standard",
 availability:"active",injuryCheckedAt:"2026-11-22T19:45:00Z",projectedMinutes:32,
 projection:11.2,standardDeviation:3,projectionSource:"model-v1",projectionObservedAt:"2026-11-22T19:50:00Z",gameStarted:false};
test("eligible evidence passes without claiming calibrated confidence",()=>{const r=assessProp(prop,{now});assert.equal(r.eligible,true);assert.equal(r.confidence,null)});
test("missing current line fails closed",()=>assert.equal(assessProp({...prop,lineObservedAt:null},{now}).eligible,false));
test("questionable injury fails closed",()=>assert.equal(assessProp({...prop,availability:"questionable"},{now}).eligible,false));
test("stale injury fails closed",()=>assert.equal(assessProp({...prop,injuryCheckedAt:"2026-11-22T18:00:00Z"},{now}).eligible,false));
test("goblin less fails closed",()=>assert.equal(assessProp({...prop,offerType:"goblin",side:"LESS"},{now}).eligible,false));
test("whole-number threshold pushes",()=>{assert.equal(settles(10,10,"MORE"),"PUSH");assert.equal(settles(11,10,"MORE"),"WIN");assert.equal(settles(9,10,"LESS"),"WIN")});
test("builder blocks unreviewed correlation",()=>assert.equal(assessEntry([{eligible:true,prop,correlationReviewed:false}]).eligible,false));
