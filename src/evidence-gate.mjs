/**
 * LPPE evidence gate. Pure functions: no network calls, no invented props.
 * Input is normalized by the data ingestion layer.
 */
export const MAX_LINE_AGE_MS = 5 * 60_000;
export const MAX_INJURY_AGE_MS = 60 * 60_000;
const finite = x => typeof x === "number" && Number.isFinite(x);
const age = (now, timestamp) => {
  const t = Date.parse(timestamp || "");
  return Number.isFinite(t) && t <= now ? now - t : Infinity;
};
export function assessProp(prop, { now = Date.now(), maxLineAgeMs = MAX_LINE_AGE_MS, maxInjuryAgeMs = MAX_INJURY_AGE_MS } = {}) {
  const reasons = [];
  if (!prop || typeof prop !== "object") return { eligible: false, reasons: ["Missing prop record"], confidence: null };
  if (!prop.playerId || !prop.gameId || !prop.market || !["MORE","LESS"].includes(prop.side))
    reasons.push("Incomplete player, game, market or direction");
  if (!finite(prop.line) || prop.line < 0) reasons.push("Invalid or missing posted line");
  if (!prop.lineSource || !prop.lineSource.includes("prizepicks"))
    reasons.push("PrizePicks source not verified");
  if (age(now, prop.lineObservedAt) > maxLineAgeMs) reasons.push("Posted line is stale or timestamp missing");
  if (!["standard","goblin","demon"].includes(prop.offerType))
    reasons.push("Offer type unverified");
  if (!["active","available","probable"].includes(prop.availability))
    reasons.push("Player availability unresolved");
  if (age(now, prop.injuryCheckedAt) > maxInjuryAgeMs)
    reasons.push("Injury information stale or missing");
  if (!finite(prop.projectedMinutes) || prop.projectedMinutes <= 0)
    reasons.push("Minutes projection unavailable");
  if (!finite(prop.projection) || !finite(prop.standardDeviation) || prop.standardDeviation <= 0)
    reasons.push("Independent projection or dispersion missing");
  if (!prop.projectionSource || !prop.projectionObservedAt)
    reasons.push("Projection provenance missing");
  if (prop.gameStarted === true) reasons.push("Game already started");
  if (prop.offerType === "goblin" && prop.side === "LESS")
    reasons.push("Unsupported Goblin LESS selection");
  return { eligible: reasons.length === 0, reasons, confidence: null,
    label: reasons.length ? "NO PLAY — insufficient verified evidence" : "RESEARCH ELIGIBLE — probability uncalibrated" };
}
/** Distinguishes sportsbook win-at-threshold from pick'em strict MORE/LESS. */
export function settles(stat, line, side) {
  if (![stat,line].every(finite) || !["MORE","LESS"].includes(side)) throw Error("Invalid settlement input");
  if (stat === line) return "PUSH";
  return (side === "MORE" ? stat > line : stat < line) ? "WIN" : "LOSS";
}
/** Avoid treating correlated selections as independent. */
export function assessEntry(legs) {
  if (!Array.isArray(legs) || !legs.length) return { eligible: false, reasons: ["No legs"] };
  const reasons = [];
  if (legs.some(x => !x?.eligible)) reasons.push("At least one leg failed evidence gate");
  const ids = legs.map(x => x?.prop?.playerId + ":" + x?.prop?.market + ":" + x?.prop?.gameId);
  if (new Set(ids).size !== ids.length) reasons.push("Duplicate player-market selections");
  if (legs.some(x => !x?.correlationReviewed)) reasons.push("Correlation not reviewed");
  return { eligible: reasons.length === 0, reasons };
}
