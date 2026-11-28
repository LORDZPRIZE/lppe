export function percentilePlaces(fieldSize, percent = 3) {
  return Math.floor(fieldSize * percent / 100);
}

export function placeShare(above, tied, places) {
  return Math.max(0, Math.min(tied, places - above)) / tied;
}

// FanDuel uses competition ranks: 1, 1, 3 for two entries tied at first.
export function validateContestRanks(ranks) {
  const sorted = [...ranks].sort((a,b) => a-b);
  for (const [index,rank] of sorted.entries()) {
    if (!Number.isInteger(rank) || (rank !== sorted[index-1] && rank !== index+1)) {
      throw new Error("Invalid competition ranks in leaderboard.");
    }
  }
}

export function contestHandle(value) {
  return String(value ?? "").trim().replace(/\s*\(\d+\/\d+\)$/, "").trim().toLowerCase();
}

export function rankSummary(ranks, fieldSize) {
  const places = percentilePlaces(fieldSize);
  const bestRank = ranks.length ? ranks.reduce((best,rank) => Math.min(best,rank),Infinity) : null;
  const top3Count = ranks.filter(rank => rank <= places).length;
  return {
    bestRank,
    bestPercentile: bestRank === null ? null : 100 * bestRank / fieldSize,
    top3Places: places,
    top3Count,
    top3Rate: ranks.length ? top3Count / ranks.length : null,
    contestTop3: ranks.length ? top3Count > 0 : null
  };
}

// Seat metadata and settled scores are required for a historical benchmark.
export function finalizedField(rows) {
  const seatCounts = rows.filter(row => row.contestinfo === "Seats Filled")
    .map(row => String(row.contestvalue ?? "").trim());
  const seats = seatCounts[0];
  if (!/^(?:\d+|\d{1,3}(?:,\d{3})+)$/.test(seats ?? "") ||
      seatCounts.some(count => count !== seats)) return null;
  const entries = rows.filter(row => row.entryid);
  if (!entries.length || Number(seats.replaceAll(",","")) !== entries.length ||
      new Set(entries.map(row => String(row.entryid).trim())).size !== entries.length ||
      entries.some(row => !String(row.entryid).trim())) return null;
  const active = entries.filter(row => row.points !== "null");
  if (!active.length || active.some(row => !String(row.points ?? "").trim() ||
      !Number.isFinite(Number(row.points)))) return null;
  const empty = entries.filter(row => row.points === "null");
  if (empty.some(row => row.lineup !== "" || row.won !== "$0.00" ||
      Number(row.rank) !== active.length+1)) return null;
  const sorted = [...active].sort((a,b) => Number(b.points)-Number(a.points));
  let rank = 1;
  for (const [index,row] of sorted.entries()) {
    if (index && Number(row.points) !== Number(sorted[index-1].points)) rank = index+1;
    if (Number(row.rank) !== rank) return null;
  }
  return sorted;
}

export function wilsonInterval(hits, count) {
  if (!count) return null;
  const z = 1.959963984540054;
  const rate = hits / count;
  const scale = 1+z*z/count;
  const center = (rate+z*z/(2*count))/scale;
  const radius = z*Math.sqrt((rate*(1-rate)+z*z/(4*count))/count)/scale;
  return [hits === 0 ? 0 : center-radius, hits === count ? 1 : center+radius];
}
