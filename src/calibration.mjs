/**
 * Probability calibration and reliability metrics.
 * All inputs must be archived before game start; outcomes are appended after settlement.
 * No probability is advertised as calibrated without out-of-sample evaluation.
 */
const valid = n => typeof n === "number" && Number.isFinite(n);
export function evaluatePredictions(rows, { bins = 10, minSamples = 100 } = {}) {
  if (!Number.isInteger(bins) || bins < 2 || bins > 100) throw Error("Invalid bins");
  const validRows = (rows || []).filter(r =>
    valid(r.predictedProbability) && r.predictedProbability >= 0 &&
    r.predictedProbability <= 1 && ["WIN","LOSS"].includes(r.result) &&
    typeof r.predictionCapturedAt === "string" && typeof r.gameStartAt === "string" &&
    Number.isFinite(Date.parse(r.predictionCapturedAt)) &&
    Number.isFinite(Date.parse(r.gameStartAt)) &&
    Date.parse(r.predictionCapturedAt) < Date.parse(r.gameStartAt));
  const n = validRows.length;
  const buckets = Array.from({length: bins}, (_, i) => ({ bin: i, count: 0, predictedSum: 0, wins: 0 }));
  let brier = 0, logLoss = 0;
  for (const row of validRows) {
    const p = row.predictedProbability, y = row.result === "WIN" ? 1 : 0;
    brier += (p-y)**2;
    logLoss += -(y*Math.log(Math.max(p,1e-12)) + (1-y)*Math.log(Math.max(1-p,1e-12)));
    const b = buckets[Math.min(bins-1,Math.floor(p*bins))];
    b.count++; b.predictedSum += p; b.wins += y;
  }
  return {
    sampleSize:n, excluded:(rows||[]).length-n,
    validated:n>=minSamples,
    warning:n<minSamples?"Insufficient held-out settled observations for calibration claims":null,
    brier:n?brier/n:null, logLoss:n?logLoss/n:null,
    reliability:buckets.map(b=>({bin:b.bin,count:b.count,
      meanPredicted:b.count?b.predictedSum/b.count:null,
      observedWinRate:b.count?b.wins/b.count:null}))
  };
}
export function requirePreGameSnapshot(snapshot) {
  const reasons=[];
  const captured=Date.parse(snapshot?.capturedAt||"");
  const start=Date.parse(snapshot?.gameStartAt||"");
  if (!Number.isFinite(captured)||!Number.isFinite(start)||captured>=start)
    reasons.push("Snapshot must be captured before game start");
  if (!snapshot?.lineSource || !snapshot?.lineObservedAt || !snapshot?.injuryCheckedAt)
    reasons.push("Missing line/injury provenance");
  if (!Number.isFinite(snapshot?.line) || snapshot.line < 0)
    reasons.push("Missing or invalid line");
  return {valid:reasons.length===0,reasons};
}
