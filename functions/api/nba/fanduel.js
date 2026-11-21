import { importPlayers, profiles, salaryCap, teamCode } from "../../../fanduel-optimizer.js";

const source = "https://www.dailyfantasyfuel.com/nba/projections/fanduel/";
const scoreboard = "https://site.api.espn.com/apis/site/v2/sports/basketball/nba/scoreboard?dates=";
const eastern = new Intl.DateTimeFormat("en-CA",{timeZone:"America/New_York",year:"numeric",month:"2-digit",day:"2-digit"});
const salaryProvider = "https://fanduelapi.com/api/v1";
const noStore = {"Cache-Control":"no-store"};

function reply(data,status = 200) {
  return Response.json(data,{status,headers:noStore});
}

function easternDay(timestamp) {
  const parts = Object.fromEntries(eastern.formatToParts(timestamp).map(({type,value}) => [type,value]));
  return parts.year + "-" + parts.month + "-" + parts.day;
}

export async function readPublicSlate(response) {
  const rows = [];
  let updatedAt;
  const document = new HTMLRewriter()
    .on('[itemprop="dateModified"]',{
      element(element) { updatedAt = element.getAttribute("datetime") || updatedAt; }
    })
    .on("tr.projections-listing",{
      element(element) {
        const attr = key => element.getAttribute("data-"+key) || "";
        rows.push({date:attr("start_date"),id:attr("player_id"),name:attr("name"),
          positions:[attr("pos"),attr("pos_alt")].filter(Boolean).join("/"),
          team:attr("team"),opponent:attr("opp"),salary:attr("salary"),
          points:attr("ppg_proj"),injury:attr("inj")});
      }
    }).transform(response);
  await document.text();
  return {rows,updatedAt};
}

const pairing = (team,opponent) => [teamCode(team),teamCode(opponent)].sort().join(":");
const csvCell = value => '"' + String(value).replaceAll('"','""') + '"';

export function normalizePublicSlate({rows,updatedAt},events,now) {
  const dates = new Set(rows.map(row => row.date));
  const [date] = dates;
  const age = now-Date.parse(updatedAt);
  if (dates.size !== 1 || !/^\d{4}-\d{2}-\d{2}$/.test(date) ||
      date < easternDay(now) || date > easternDay(now+86400000) ||
      !(age >= -120000 && age <= 24*60*60000)) return {error:"No current public FanDuel slate is available."};
  const games = new Map();
  for (const event of events) {
    const teams = event.competitions?.[0]?.competitors?.map(item => item.team?.abbreviation);
    const starts = Date.parse(event.date);
    if (teams?.length !== 2 || !teams.every(Boolean) || !Number.isFinite(starts)) continue;
    const key = pairing(...teams);
    games.set(key,games.has(key) ? null : {starts,upcoming:event.status?.type?.state === "pre"});
  }
  const usedGames = new Map();
  for (const row of rows) {
    const key = pairing(row.team,row.opponent);
    const game = games.get(key);
    if (!game) return {error:"The public player pool could not be matched to the NBA schedule."};
    if (!game.upcoming || game.starts <= now) return {error:"At least one game in the public pool has started. Import your specific slate to build for another contest."};
    usedGames.set(key,game.starts);
  }
  const csv = ["ID,Name,Position,Team,Salary,Projection,Injury Indicator",
    ...rows.map(row => [row.id,row.name,row.positions,row.team,row.salary,row.points,row.injury].map(csvCell).join(","))].join("\n");
  const {players,skipped} = importPlayers(csv);
  const usable = players.filter(player => player.selection !== "exclude" && Number.isFinite(player.points));
  if (usable.length < 9 || usedGames.size < 2) return {error:"The public pool does not have enough eligible players."};
  const cheapest = usable.map(player=>player.salary).sort((a,b)=>a-b).slice(0,9);
  if (cheapest.reduce((total,salary)=>total+salary,0) > salaryCap) {
    return {error:"The public preview omits the lower-salary players needed to build under $60,000. Connect the salary API or import your contest CSV."};
  }
  for (const player of players) if (player.source) player.source = "Daily Fantasy Fuel";
  return {date,updatedAt,lockAt:Math.min(...usedGames.values()),gameCount:usedGames.size,players,skipped,
    provider:"Daily Fantasy Fuel",poolType:"public preview",label:"Published FanDuel pool"};
}

export function selectProviderSlate(data,now,sport = "NBA") {
  const profile = profiles[sport];
  return data.filter(slate => {
    const starts = Date.parse(slate.starts_at);
    return (slate.sport === sport || (sport === "CFB" && slate.sport === "NCAAF")) &&
      slate.started === false && slate.salary_cap === profile.salaryCap &&
      slate.games >= 2 && slate.players >= profile.roster.length && /^[a-z0-9_-]+$/i.test(String(slate.id)) &&
      starts > now && easternDay(starts) <= easternDay(now+86400000) &&
      !/single|showdown|quarter|half|tiers|mvp|express/i.test(slate.label || "");
  }).sort((a,b) => easternDay(Date.parse(a.starts_at)).localeCompare(easternDay(Date.parse(b.starts_at))) ||
    Number(/main/i.test(b.label))-Number(/main/i.test(a.label)) ||
    b.games-a.games || Date.parse(a.starts_at)-Date.parse(b.starts_at))[0];
}

export function normalizeProviderPlayers(data,slate,sport = "NBA") {
  const profile = profiles[sport];
  const csv = ["ID,Name,Position,Team,Salary,FPPG,Injury Indicator,Game",
    ...data.map(row => {
      const positions = row.roster_positions || row.positions || row.position || "";
      const status = row.injury_status || row.injury_indicator || row.status || "";
      return [row.id ?? row.player_id ?? "",row.name ?? row.player ?? "",
        Array.isArray(positions) ? positions.join("/") : positions,row.team ?? "",row.salary ?? "",
        row.fppg ?? row.fantasy_points_per_game ?? "",status,row.game_id ?? row.game ?? ""].map(csvCell).join(",");
    })].join("\n");
  const {players,skipped} = importPlayers(csv,"",sport);
  if (players.filter(player => Number.isFinite(player.points) && player.selection !== "exclude").length < profile.roster.length) {
    return {error:"The supplied salary slate has too few eligible players with FPPG."};
  }
  return {date:easternDay(Date.parse(slate.starts_at)),updatedAt:slate.players_read_at || null,
    lockAt:Date.parse(slate.starts_at),gameCount:slate.games,players,skipped,
    provider:"FanDuelAPI.com",poolType:"salary feed",label:slate.label || "FanDuel " + profile.name + " Classic"};
}

async function providerPool(env,sport) {
  const headers = {Authorization:"Bearer "+env.FANDUEL_API_KEY,Accept:"application/json",
    "X-User-Request":"Load an upcoming FanDuel " + profiles[sport].name + " Classic slate and its salaries for LPPE"};
  async function read(path) {
    const response = await fetch(salaryProvider+path,{headers,signal:AbortSignal.timeout(8000)});
    if (response.status === 429) throw new Error("The FanDuel salary provider has reached its usage limit.");
    if (response.status === 401) throw new Error("The FanDuel salary API key was rejected.");
    if (!response.ok) throw new Error("The FanDuel salary API is unavailable.");
    const body = await response.json();
    if (!Array.isArray(body.data)) throw new Error("The FanDuel salary API returned an unexpected response.");
    return body.data;
  }
  let slate = selectProviderSlate(await read("/dfs/slates?sport="+sport+"&started=false&limit=50"),Date.now(),sport);
  if (!slate && sport === "CFB") {
    slate = selectProviderSlate(await read("/dfs/slates?sport=NCAAF&started=false&limit=50"),Date.now(),sport);
  }
  if (!slate) return {error:"No upcoming " + profiles[sport].name + " Classic slate was returned by the salary provider."};
  const rows = [];
  while (rows.length < slate.players && rows.length < 800) {
    const limit = Math.min(200,slate.players-rows.length);
    const page = await read("/dfs/slates/"+encodeURIComponent(slate.id)+"/players?limit="+limit+"&offset="+rows.length);
    if (!page.length) break;
    rows.push(...page);
  }
  if (rows.length < slate.players) return {error:"The salary provider returned an incomplete player pool."};
  if (Date.parse(slate.starts_at) <= Date.now()) return {error:"The salary slate has already locked."};
  return normalizeProviderPlayers(rows,slate,sport);
}

async function publicPool() {
  const publicPage = await fetch(source,{signal:AbortSignal.timeout(12000)});
  if (!publicPage.ok) throw new Error("Public source unavailable");
  const slate = await readPublicSlate(publicPage);
  const date = slate.rows[0]?.date;
  if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return {error:"No current public FanDuel slate is available."};
  const schedule = await fetch(scoreboard+date.replaceAll("-",""),{signal:AbortSignal.timeout(8000)});
  if (!schedule.ok) throw new Error("NBA schedule unavailable");
  return normalizePublicSlate(slate,(await schedule.json()).events || [],Date.now());
}

export async function onRequestGet({request,env}) {
  const sport = new URL(request.url).searchParams.get("sport")?.toUpperCase() || "NBA";
  if (!Object.hasOwn(profiles,sport)) return reply({error:"Unsupported FanDuel Classic sport."},400);
  const configured = Boolean(env.FANDUEL_API_KEY);
  if (!configured && sport !== "NBA") return reply({
    error:"Automatic " + profiles[sport].name + " loading needs the salary API key. Import a FanDuel contest CSV to build now."
  },503);
  const key = new Request(new URL("/lppe-internal/fanduel-pool-v3/"+sport+"/"+(configured ? "provider" : "public"),request.url));
  try {
    const cache = caches.default;
    const cached = await cache.match(key);
    if (cached) {
      const data = await cached.json();
      if (data.lockAt > Date.now()) return reply(data);
    }
    const data = configured ? await providerPool(env,sport) : await publicPool();
    if (data.error) return reply(data,404);
    const ttl = Math.max(1,Math.min(600,Math.floor((data.lockAt-Date.now())/1000)));
    try { await cache.put(key,Response.json(data,{headers:{"Cache-Control":"public, max-age="+ttl}})); } catch {}
    return reply(data);
  } catch (error) {
    const message = configured && /^The FanDuel salary/.test(error.message) ? error.message :
      "Automatic slate loading is temporarily unavailable. You can still import a FanDuel CSV.";
    return reply({error:message},502);
  }
}
