// Pure contest metrics; use complete, finalized leaderboard entries only.
export function contestPerformance(entries, username) {
  if (!Array.isArray(entries) || !entries.length) throw new Error("Complete leaderboard required");
  const handle = String(username ?? "").trim().toLowerCase();
  if (!handle) throw new Error("Username required");
  const ids = new Set();
  const n = entries.length;
  const mine = [];
  for (const e of entries) {
    const id = String(e.entryid ?? "").trim();
    const rank = Number(e.rank);
    if (!id || ids.has(id) || !Number.isInteger(rank) || rank < 1 || rank > n)
      throw new Error("Invalid or duplicate leaderboard entry");
    ids.add(id);
    if (String(e.entryname ?? "").replace(/\s*\(\d+\/\d+\)$/, "").trim().toLowerCase() === handle)
      mine.push(rank);
  }
  const count = p => mine.filter(rank => rank / n <= p).length;
  const top5 = count(.05);
  return {fieldSize:n, entryCount:mine.length, bestRank:mine.length ? mine.reduce((a,b)=>Math.min(a,b),Infinity):null,
    bestPercentile:mine.length ? 100*mine.reduce((a,b)=>Math.min(a,b),Infinity)/n:null,
    top5Count:top5, top1Count:count(.01), topPoint1Count:count(.001),
    top5Rate:mine.length ? top5/mine.length:null, contestTop5:mine.length ? top5>0:null};
}
