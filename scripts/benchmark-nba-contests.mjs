import {readFileSync} from "node:fs";
import {createHash} from "node:crypto";
import {dirname,resolve} from "node:path";
import {parseCSV,reviewContest,scoreSavedBuilds} from "../fanduel-optimizer.js";
import {pairHeldOut,readNBAArchive,summarizeTop3Pairs} from "../fanduel-nba-review.js";

try {
  const path = process.argv[2];
  if (!path) throw new Error("Usage: node scripts/benchmark-nba-contests.mjs manifest.json");
  const {slates, holdoutFrom} = JSON.parse(readFileSync(path,"utf8"));
  const start = typeof holdoutFrom === "string" && /T.*(?:Z|[+-]\d{2}:\d{2})$/i.test(holdoutFrom)
    ? Date.parse(holdoutFrom) : NaN;
  if (!Number.isFinite(start) || !Array.isArray(slates) || !slates.length) {
    throw new Error("Supply slates and a holdoutFrom timestamp with time zone.");
  }
  const pairs = [];
  const locks = new Set();
  const results = slates.map(({leaderboard,archive}) => {
    const read = name => readFileSync(resolve(dirname(path),name),"utf8");
    const standings = read(leaderboard);
    const snapshots = read(archive);
    const hash = data => createHash("sha256").update(data).digest("hex");
    const source = {leaderboard,archive,sha256:{leaderboard:hash(standings),archive:hash(snapshots)}};
    const rows = parseCSV(standings);
    const field = reviewContest(rows);
    const replay = scoreSavedBuilds(rows,readNBAArchive(snapshots),field.cutoff);
    const pair = pairHeldOut(rows,replay,"top3");
    if (!pair) return {...source,skipped:"No complete, matched top-3% archive and finalized field."};
    const lock = Date.parse(pair.tournament.lockAt);
    if (lock < start) return {...source,skipped:"Slate predates the holdout."};
    if (locks.has(lock)) throw new Error("Use one held-out contest per slate lock.");
    locks.add(lock);
    pairs.push(pair);
    return {...source,...pair};
  });
  console.log(JSON.stringify({holdoutFrom,summary:summarizeTop3Pairs(pairs,"top3"),results},null,2));
  if (!pairs.length) process.exitCode = 1;
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
