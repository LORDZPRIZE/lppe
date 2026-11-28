import {contestHandle, percentilePlaces, rankSummary, validateContestRanks} from "../fanduel-contest-metrics.js";

// Use complete, finalized leaderboard entries only.
export function contestPerformance(entries, username) {
  if (!Array.isArray(entries) || !entries.length) throw new Error("Complete leaderboard required");
  const handle = contestHandle(username);
  if (!handle) throw new Error("Username required");
  const ids = new Set();
  const ranks = [];
  const mine = [];
  for (const entry of entries) {
    const id = String(entry?.entryid ?? "").trim();
    const rank = Number(entry?.rank);
    if (!id || ids.has(id)) throw new Error("Invalid or duplicate leaderboard entry");
    ids.add(id);
    ranks.push(rank);
    if (contestHandle(entry.entryname) === handle) mine.push(rank);
  }
  validateContestRanks(ranks);
  const fieldSize = entries.length;
  const count = percent => mine.filter(rank => rank <= percentilePlaces(fieldSize,percent)).length;
  const top5Count = count(5);
  return {
    fieldSize, entryCount:mine.length, ...rankSummary(mine,fieldSize),
    top5Count, top1Count:count(1), topPoint1Count:count(.1),
    top5Rate:mine.length ? top5Count/mine.length : null,
    contestTop5:mine.length ? top5Count>0 : null
  };
}
