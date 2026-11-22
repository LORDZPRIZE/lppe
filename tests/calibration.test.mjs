import test from "node:test";
import assert from "node:assert/strict";
import {evaluatePredictions,requirePreGameSnapshot} from "../src/calibration.mjs";
const base={predictionCapturedAt:"2026-11-22T19:00:00Z",gameStartAt:"2026-11-22T20:00:00Z"};
test("perfect binary forecasts score zero brier and log loss",()=>{
 const r=evaluatePredictions([{...base,predictedProbability:1,result:"WIN"},{...base,predictedProbability:0,result:"LOSS"}],{minSamples:2});
 assert.equal(r.brier,0);assert.equal(r.logLoss,0);assert.equal(r.validated,true);
});
test("postgame forecasts excluded",()=>{
 const r=evaluatePredictions([{...base,predictionCapturedAt:"2026-11-22T21:00:00Z",predictedProbability:1,result:"WIN"}]);
 assert.equal(r.sampleSize,0);assert.equal(r.excluded,1);assert.equal(r.validated,false);
});
test("push outcomes excluded from binary calibration",()=>{
 const r=evaluatePredictions([{...base,predictedProbability:.6,result:"PUSH"}]);
 assert.equal(r.sampleSize,0);
});
test("insufficient samples never marked calibrated",()=>{
 const r=evaluatePredictions([{...base,predictedProbability:.7,result:"WIN"}]);
 assert.equal(r.validated,false);assert.ok(r.warning);
});
test("snapshot must predate tipoff",()=>{
 const r=requirePreGameSnapshot({capturedAt:"2026-11-22T20:00:00Z",gameStartAt:"2026-11-22T20:00:00Z",lineSource:"prizepicks",lineObservedAt:"2026-11-22T19:00:00Z",injuryCheckedAt:"2026-11-22T19:00:00Z",line:10.5});
 assert.equal(r.valid,false);
});
