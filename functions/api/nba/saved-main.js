import { attachSlateGames } from "./fanduel.js";

function verifiedMain(pool,date,now) {
  if (pool?.poolType !== "salary feed" || pool.date !== date || !(pool.lockAt > now) ||
      !Number.isInteger(pool.gameCount) || pool.gameCount < 2 ||
      !Array.isArray(pool.players) || pool.players.length < 9 ||
      pool.listedPlayerCount !== pool.players.length) return null;
  const ids = new Set();
  const games = new Map();
  const slateId = pool.players[0]?.id?.split("-")[0];
  for (const player of pool.players) {
    if (!/^\d+-\d+$/.test(player?.id) || player.id.split("-")[0] !== slateId ||
        ids.has(player.id) || !player.game || !Number.isFinite(player.gameStart) ||
        player.gameStart < pool.lockAt ||
        (games.has(player.game) && games.get(player.game) !== player.gameStart)) return null;
    ids.add(player.id);
    games.set(player.game,player.gameStart);
  }
  return games.size === pool.gameCount && Math.min(...games.values()) === pool.lockAt ? slateId : null;
}

async function recoverMain(read,date) {
  const slates = await read("slates");
  if (!Array.isArray(slates)) return null;
  const day = new Intl.DateTimeFormat("en-US",{timeZone:"America/New_York",month:"numeric",day:"numeric",year:"numeric"});
  const targetDay = day.format(Date.parse(date+"T12:00:00Z"));
  const candidates = slates.filter(slate => {
    const lock = Date.parse(slate?.starts_at);
    return lock > Date.now() && day.format(lock) === targetDay &&
      /^(?:NBA )?Main(?: Slate)?$/i.test((slate.label || "").trim()) &&
      /^[a-z0-9_-]{1,128}$/i.test(String(slate.id));
  });
  if (candidates.length !== 1) return null;
  const [slate] = candidates;
  const lockAt = Date.parse(slate.starts_at);
  const matchingPool = pool => pool?.date === date && pool.lockAt === lockAt &&
    pool.gameCount === slate.games && pool.listedPlayerCount === Number(slate.players);

  let pool = await read("provider/"+slate.id);
  let slateId = matchingPool(pool) && verifiedMain(pool,date,Date.now());
  if (!slateId) {
    pool = await read("nba-salaries/"+slate.id);
    if (!matchingPool(pool) || pool.poolType !== "salary feed" ||
        pool.players?.length !== pool.listedPlayerCount) return null;
    const response = await fetch("https://site.api.espn.com/apis/site/v2/sports/basketball/nba/scoreboard?dates="+
      date.replaceAll("-",""),{signal:AbortSignal.timeout(3500)});
    if (!response.ok) return null;
    const {events} = await response.json();
    if (!Array.isArray(events)) return null;
    pool = attachSlateGames(pool,events,Date.now());
    slateId = verifiedMain(pool,date,Date.now());
  }
  // The source timestamps still describe when salary and projections were read.
  return slateId ? {...pool,slateId,providerSlateId:String(slate.id)} : null;
}

// Recovery only uses cached salaries and a public schedule.
export async function onRequestGet({request}) {
  const date = new URL(request.url).searchParams.get("date") || "";
  const reply = (body,status) => Response.json(body,{status,headers:{"Cache-Control":"no-store"}});
  const parsed = Date.parse(date+"T00:00:00Z");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !Number.isFinite(parsed) ||
      new Date(parsed).toISOString().slice(0,10) !== date) {
    return reply({error:"Provide a valid NBA Main slate date (YYYY-MM-DD)."},400);
  }
  const read = async suffix => {
    const key = new Request(new URL("/lppe-internal/fanduel-v9/NBA/"+suffix,request.url));
    const cached = await caches.default.match(key).catch(() => null);
    return cached ? cached.json().catch(() => null) : null;
  };
  const snapshot = await read("saved-main/"+date);
  const slateId = verifiedMain(snapshot,date,Date.now());
  if (slateId && slateId === snapshot.slateId) {
    return reply(snapshot,200);
  }
  const recovered = await recoverMain(read,date).catch(() => null);
  if (recovered && recovered.lockAt > Date.now()) return reply(recovered,200);
  return reply({error:"No saved pre-lock NBA Main pool is available here for this date."},404);
}
