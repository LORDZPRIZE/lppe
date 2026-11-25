import { liveRefreshSeconds, importPlayers, matchName, profiles, salaryCap, teamCode, unavailable } from "../../../fanduel-optimizer.js";

const source = "https://www.dailyfantasyfuel.com/nba/projections/fanduel/";
const scoreboards = {
  NBA:"https://site.api.espn.com/apis/site/v2/sports/basketball/nba/scoreboard?dates=",
  NFL:"https://site.api.espn.com/apis/site/v2/sports/football/nfl/scoreboard?dates="
};
const injuryFeed = "https://site.api.espn.com/apis/site/v2/sports/basketball/nba/injuries";
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
  const csv = ["ID,Name,Position,Team,Salary,Projection,Injury Indicator,Game",
    ...rows.map(row => [row.id,row.name,row.positions,row.team,row.salary,row.points,row.injury,
      [teamCode(row.team),teamCode(row.opponent)].sort().join("/")].map(csvCell).join(","))].join("\n");
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

function eligibleProviderSlates(data,now,sport) {
  const profile = profiles[sport];
  return data.filter(slate => {
    const starts = Date.parse(slate.starts_at);
    return (slate.sport === sport || (sport === "CFB" && slate.sport === "NCAAF")) &&
      slate.started === false && slate.salary_cap === profile.salaryCap &&
      slate.games >= 2 && slate.players >= profile.roster.length && /^[a-z0-9_-]+$/i.test(String(slate.id)) &&
      starts > now && easternDay(starts) <= easternDay(now+86400000) &&
      !/single|showdown|quarter|half|tiers|mvp|express|super\s*flex|snake draft|\b(?:test|dnp|dummy|qtr)\b/i.test(slate.label || "");
  }).sort((a,b) => easternDay(Date.parse(a.starts_at)).localeCompare(easternDay(Date.parse(b.starts_at))) ||
    Number(/main/i.test(b.label))-Number(/main/i.test(a.label)) ||
    b.games-a.games || Date.parse(a.starts_at)-Date.parse(b.starts_at));
}

export function selectProviderSlate(data,now,sport = "NBA") {
  return eligibleProviderSlates(data,now,sport)[0];
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
  if (sport === "NBA" && (players.length !== Number(slate.players) || skipped)) {
    return {error:"NBA salary pool incomplete: "+players.length+" distinct usable player IDs for "+
      slate.players+" listed players. Refresh the slate or import its FanDuel player-list CSV."};
  }
  if (players.filter(player => Number.isFinite(player.points) && player.selection !== "exclude").length < profile.roster.length) {
    return {error:"The supplied salary slate has too few eligible players with FPPG."};
  }
  return {date:easternDay(Date.parse(slate.starts_at)),updatedAt:slate.players_read_at || null,
    lockAt:Date.parse(slate.starts_at),gameCount:slate.games,players,skipped,
    ...(sport === "NBA" ? {listedPlayerCount:Number(slate.players)} : {}),
    provider:"FanDuelAPI.com",poolType:"salary feed",label:slate.label || "FanDuel " + profile.name + " Classic"};
}

function providerReader(env) {
  const key = env.FANDUEL_API_KEY.trim();
  if (!/^fd_[A-Za-z0-9_-]+$/.test(key)) throw new Error("The FanDuel salary API secret must contain only the full fd_ key.");
  const headers = {Authorization:"Bearer "+key,Accept:"application/json"};
  return async function read(path) {
    let response;
    try {
      response = await fetch(salaryProvider+path,{headers,signal:AbortSignal.timeout(12000)});
    } catch {
      throw new Error("The FanDuel salary provider could not be reached from LPPE.");
    }
    if (response.status === 429) throw new Error("The FanDuel salary provider has reached its usage limit.");
    if (response.status === 401 || response.status === 403) throw new Error("The FanDuel salary API key was rejected.");
    if (!response.ok) throw new Error("The FanDuel salary API is unavailable.");
    const body = await response.json().catch(() => null);
    if (!Array.isArray(body?.data)) throw new Error("The FanDuel salary API returned an unexpected response.");
    return body.data;
  };
}

async function listProviderSlates(cache,key,read,sport) {
  const cached = await cache.match(key);
  if (cached) {
    const slates = await cached.json();
    const upcoming = slates.filter(slate => Date.parse(slate.starts_at) > Date.now());
    if (!slates.length || upcoming.length) return upcoming;
  }
  const fetchSlates = async code => eligibleProviderSlates(
    await read("/dfs/slates?sport="+code+"&started=false&limit=50"),Date.now(),sport
  );
  let slates = await fetchSlates(sport);
  if (!slates.length && sport === "CFB") slates = await fetchSlates("NCAAF");
  const ttl = slates.length ? 1800 : 600;
  try { await cache.put(key,Response.json(slates,{headers:{"Cache-Control":"public, max-age="+ttl}})); } catch {}
  return slates;
}

async function providerPool(read,slate,sport) {
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

export function attachSlateGames(pool,events,now,sport = "NBA") {
  const slateTeams = new Set(pool.players.map(player => player.team));
  const games = new Map();
  const seen = new Set();
  for (const event of events) {
    const teams = event.competitions?.[0]?.competitors?.map(item => teamCode(item.team?.abbreviation,sport));
    const start = Date.parse(event.date);
    if (teams?.length !== 2 || teams[0] === teams[1] ||
        !teams.every(team => slateTeams.has(team)) ||
        event.status?.type?.state !== "pre" || !(start > now && start >= pool.lockAt)) continue;
    const game = teams.sort().join("/");
    const identity = game+":"+start;
    if (seen.has(identity)) continue;
    seen.add(identity);
    const schedule = {game,gameDate:easternDay(start),start};
    for (const team of teams) games.set(team,games.has(team) ? null : schedule);
  }
  const unique = new Set([...games.values()].filter(Boolean));
  const firstStart = Math.min(...[...unique].map(game => game.start));
  if (unique.size !== pool.gameCount || firstStart !== pool.lockAt ||
      [...slateTeams].some(team => !games.get(team))) return pool;
  const players = pool.players.map(player => {
    const {game,gameDate,start} = games.get(player.team);
    return {...player,game,gameDate,gameStart:start};
  });
  return {...pool,players};
}

export function addNBAProjections(pool,{rows,updatedAt},now) {
  const age = now-Date.parse(updatedAt);
  if (!(age >= -120000 && age <= 2*60*60000)) return pool;

  const key = (name,team,salary) => JSON.stringify([matchName(name),teamCode(team),Number(salary)]);
  const slateTeams = new Set(pool.players.map(player => player.team));
  const projections = new Map();
  for (const row of rows) {
    if (row.date !== pool.date || !row.name || !row.team || !row.opponent ||
        !slateTeams.has(teamCode(row.opponent))) continue;
    const points = row.points.trim() ? Number(row.points) : NaN;
    if (!Number.isFinite(points) || points < 0) continue;
    const identity = key(row.name,row.team,row.salary);
    // An ambiguous identity is safer to leave on the salary feed's baseline.
    projections.set(identity,projections.has(identity) ? null : {points,positions:row.positions.toUpperCase().split("/"),game:[teamCode(row.team),teamCode(row.opponent)].sort().join("/")});
  }

  const eligible = pool.players.filter(player => player.selection !== "exclude").length;
  const counts = new Map();
  for (const player of pool.players) {
    const identity = key(player.name,player.team,player.salary);
    counts.set(identity,(counts.get(identity) || 0)+1);
  }
  let matched = 0;
  const players = pool.players.map(player => {
    if (player.selection === "exclude") return player;
    const identity = key(player.name,player.team,player.salary);
    const projection = projections.get(identity);
    if (counts.get(identity) !== 1 || !projection ||
        (player.game?.includes("/") && player.game !== projection.game) ||
        !player.positions.some(position => projection.positions.includes(position))) return player;
    matched++;
    return {...player,points:projection.points,source:"Daily Fantasy Fuel"};
  });
  return matched ? {...pool,players,projectionCoverage:{matched,eligible,updatedAt}} : pool;
}

export function applyNBAInjuryReport(pool,report,now) {
  const reportAge = now-Date.parse(report?.timestamp);
  if (!Array.isArray(report?.injuries) || !(reportAge >= -120000 && reportAge <= 3600000)) return pool;

  const health = new Map();
  const salaryReadAt = Date.parse(pool.updatedAt);
  for (const group of report.injuries) {
    if (!Array.isArray(group?.injuries)) continue;
    for (const entry of group.injuries) {
      if (!entry) continue;
      const name = entry.athlete?.displayName;
      const team = teamCode(entry.athlete?.team?.abbreviation);
      const updated = Date.parse(entry.date);
      if (!name || !team || !(updated <= now+120000 && now-updated <= 72*3600000) ||
          (Number.isFinite(salaryReadAt) && updated <= salaryReadAt)) continue;
      const key = JSON.stringify([matchName(name),team]);
      if (!health.has(key) || updated > health.get(key).updated) {
        health.set(key,{updated,status:entry.status,returnDate:entry.details?.returnDate});
      }
    }
  }
  const identities = new Map();
  const identity = player => JSON.stringify([matchName(player.name),player.team]);
  for (const player of pool.players) {
    const key = identity(player);
    identities.set(key,(identities.get(key) || 0)+1);
  }
  let excluded = 0;
  const players = pool.players.map(player => {
    const key = identity(player);
    const entry = health.get(key);
    // Reject day-to-day records and single-game reports with unclear applicability.
    if (!entry || entry.status !== "Out" || identities.get(key) !== 1 ||
        !/^\d{4}-\d{2}-\d{2}$/.test(entry.returnDate) || entry.returnDate <= pool.date ||
        unavailable(player.status)) return player;
    excluded++;
    return {...player,status:"Out",selection:"exclude",injurySource:"ESPN"};
  });
  return excluded ? {...pool,players,injuryCoverage:{excluded,updatedAt:report.timestamp}} : pool;
}

async function currentNBAInjuries() {
  try {
    const response = await fetch(injuryFeed,{signal:AbortSignal.timeout(3500)});
    return response.ok ? await response.json() : null;
  } catch {
    return null;
  }
}

async function currentNBAProjections() {
  try {
    const response = await fetch(source,{signal:AbortSignal.timeout(3500)});
    return response.ok ? await readPublicSlate(response) : null;
  } catch {
    return null;
  }
}

async function readSchedule(sport,date,timeout = 3500) {
  const schedule = await fetch(scoreboards[sport]+date.replaceAll("-",""),{signal:AbortSignal.timeout(timeout)});
  if (!schedule.ok) throw new Error(sport+" schedule unavailable");
  const {events} = await schedule.json();
  return Array.isArray(events) ? events : [];
}

async function publicPool() {
  const publicPage = await fetch(source,{signal:AbortSignal.timeout(12000)});
  if (!publicPage.ok) throw new Error("Public source unavailable");
  const slate = await readPublicSlate(publicPage);
  const date = slate.rows[0]?.date;
  if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return {error:"No current public FanDuel slate is available."};
  return normalizePublicSlate(slate,await readSchedule("NBA",date,8000),Date.now());
}

async function cachedPool(cache,key) {
  const response = await cache.match(key);
  if (!response) return null;
  const pool = await response.json();
  if (key.url.includes("/NBA/") && pool.poolType === "salary feed" &&
      pool.listedPlayerCount !== pool.players?.length) return null;
  return pool.lockAt > Date.now() ? pool : null;
}

async function storePool(cache,key,pool,maxAge) {
  const ttl = Math.min(maxAge,Math.floor((pool.lockAt-Date.now())/1000));
  if (ttl <= 0) return;
  try {
    await cache.put(key,Response.json(pool,{headers:{"Cache-Control":"public, max-age="+ttl}}));
  } catch {}
}

export async function onRequestGet({request,env}) {
  const {searchParams} = new URL(request.url);
  const sport = searchParams.get("sport")?.toUpperCase() || "NBA";
  const list = searchParams.get("list") === "1";
  const slateId = searchParams.get("slate");
  if (list && slateId !== null) return reply({error:"Request the slate list or one slate ID at a time."},400);
  if (slateId !== null && !/^[a-z0-9_-]{1,128}$/i.test(slateId)) return reply({error:"Invalid slate selection."},400);
  if (!Object.hasOwn(profiles,sport)) return reply({error:"Unsupported FanDuel Classic sport."},400);
  const configured = Boolean(env.FANDUEL_API_KEY);
  if (!configured && sport !== "NBA") return reply({
    error:"Automatic " + profiles[sport].name + " loading needs the salary API key. Import a FanDuel contest CSV to build now."
  },503);
  try {
    const cache = caches.default;
    const cacheKey = suffix => new Request(new URL("/lppe-internal/fanduel-v9/"+sport+"/"+suffix,request.url));
    if (configured && !list && slateId !== null) {
      const ready = await cachedPool(cache,cacheKey("provider/"+slateId));
      if (ready) return reply(ready);
    }
    let slate;
    let read;
    if (configured) {
      read = providerReader(env);
      const slates = await listProviderSlates(cache,cacheKey("slates"),read,sport);
      if (list) return reply({slates:slates.map(item => ({
        id:String(item.id),label:item.label || "FanDuel " + profiles[sport].name + " Classic",
        lockAt:Date.parse(item.starts_at),games:item.games
      }))});
      slate = slateId === null ? slates[0] : slates.find(item => String(item.id) === slateId);
      if (!slate) return reply({error:slateId === null ?
        "No upcoming " + profiles[sport].name + " Classic slate was returned by the salary provider." :
        "This slate is no longer available. Refresh the slate list and choose another."},404);
    } else {
      if (list) return reply({slates:[{id:"public",label:"NBA public preview"}]});
      if (slateId !== null && slateId !== "public") return reply({error:"This slate is no longer available."},404);
    }
    const key = cacheKey(configured ? "provider/"+slate.id : "public");
    const cached = await cachedPool(cache,key);
    if (cached) return reply(cached);
    const isLiveNBA = configured && sport === "NBA";
    const projectionsRequest = isLiveNBA ? currentNBAProjections() : null;
    const injuriesRequest = isLiveNBA ? currentNBAInjuries() : null;
    const scheduledSport = configured && Object.hasOwn(scoreboards,sport);
    const scheduleRequest = scheduledSport ?
      readSchedule(sport,easternDay(Date.parse(slate.starts_at))).catch(() => []) : null;
    const salaryKey = isLiveNBA ? cacheKey("nba-salaries/"+slate.id) : null;
    let data = salaryKey ? await cachedPool(cache,salaryKey) : null;
    if (!data) {
      data = configured ? await providerPool(read,slate,sport) : await publicPool();
      if (data.error) return reply(data,404);
      if (salaryKey) await storePool(cache,salaryKey,data,liveRefreshSeconds(data.lockAt));
    }
    const projections = await projectionsRequest;
    if (scheduleRequest) {
      const events = await scheduleRequest;
      const scheduled = attachSlateGames(data,events,Date.now(),sport);
      if (sport === "NFL" && scheduled === data) {
        const nextDays = await Promise.all([1,2,3].map(day =>
          readSchedule(sport,easternDay(data.lockAt+day*86400000)).catch(() => [])));
        data = attachSlateGames(data,events.concat(...nextDays),Date.now(),sport);
      } else {
        data = scheduled;
      }
    }
    const injuries = await injuriesRequest;
    if (injuries) data = applyNBAInjuryReport(data,injuries,Date.now());
    if (projections) data = addNBAProjections(data,projections,Date.now());
    if (data.lockAt <= Date.now()) return reply({error:"The salary slate has already locked."},404);
    await storePool(cache,key,data,isLiveNBA ? 120 : liveRefreshSeconds(data.lockAt));
    return reply(data);
  } catch (error) {
    const message = configured && /^The FanDuel salary/.test(error.message) ? error.message :
      "Automatic slate loading is temporarily unavailable. You can still import a FanDuel CSV.";
    return reply({error:message},502);
  }
}
