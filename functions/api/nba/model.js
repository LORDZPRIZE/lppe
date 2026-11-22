const json = body => Response.json(body,{headers:{"Cache-Control":"no-store"}});

async function getJson(url) {
  const response = await fetch(url,{headers:{Accept:"application/json"}});
  if (!response.ok) throw new Error("ESPN HTTP " + response.status);
  return response.json();
}

const espnNBA = "https://site.api.espn.com/apis/site/v2/sports/basketball/nba";
const pacificSlate = new Intl.DateTimeFormat("en-CA",{timeZone:"America/Los_Angeles",dateStyle:"short"});
const easternDate = new Intl.DateTimeFormat("en-US", {
  timeZone:"America/New_York", year:"numeric", month:"2-digit", day:"2-digit"
});

function nbaDate(time) {
  const parts = Object.fromEntries(easternDate.formatToParts(time).map(({type,value}) => [type,value]));
  return parts.year + parts.month + parts.day;
}

async function cachedNBA(request, path, seconds, load) {
  const key = new Request(new URL("/lppe-nba-cache/" + path,request.url));
  const cached = await caches.default.match(key);
  if (cached) return cached.json();
  const data = await load();
  const response = json(data);
  response.headers.set("Cache-Control","public, max-age=" + seconds);
  try { await caches.default.put(key,response); } catch {}
  return data;
}

function playerBoxScores(summary) {
  if (!Array.isArray(summary.boxscore?.players)) throw new Error("Missing NBA box scores");
  const results = [];
  for (const team of summary.boxscore.players) {
    for (const group of team.statistics || []) {
      const columns = ["minutes","points","rebounds","assists","threePointFieldGoalsMade-threePointFieldGoalsAttempted"]
        .map(key => group.keys?.indexOf(key) ?? -1);
      if (columns.includes(-1)) continue;
      for (const row of group.athletes || []) {
        if (row.didNotPlay || !row.athlete?.id || !row.athlete.displayName) continue;
        const [rawMinutes,points,rebounds,assists,threePointers] = columns.map(index => row.stats?.[index]);
        const [minutes,seconds = 0] = String(rawMinutes).split(":").map(Number);
        const played = minutes + seconds / 60;
        const counts = [points,rebounds,assists,String(threePointers).split("-")[0]];
        if (!(played > 0) || counts.some(value => !/^\d+$/.test(value))) continue;
        results.push({id:row.athlete.id,player:row.athlete.displayName,
          team:team.team.abbreviation,minutes:played,values:counts.map(Number)});
      }
    }
  }
  if (!results.length) throw new Error("Missing NBA player stats");
  return results;
}

function slateGames(events,today,part) {
  const games = [...new Map(events.filter(game =>
    [2,3].includes(game.season?.type) && Number.isFinite(Date.parse(game.date)) &&
    pacificSlate.format(Date.parse(game.date)) === today).map(game => [game.id,game])).values()];
  games.sort((a,b) => Date.parse(a.date)-Date.parse(b.date) || a.id.localeCompare(b.id));
  return part === null ? games : games.filter((_,index) => index % 2 === part);
}

async function recentNBA(request, now, part) {
  const dates = [...new Set(Array.from({length:12},(_,day) => nbaDate(now + (1-day) * 86400000)))];
  const today = pacificSlate.format(now);
  const cachePath = "model-v6/" + nbaDate(now) + "/" + encodeURIComponent(today) + "/" + (part ?? "all");
  return cachedNBA(request,cachePath,900,async () => {
    const boards = await Promise.allSettled(dates.map(date => getJson(espnNBA + "/scoreboard?dates=" + date)));
    if (boards[1].status !== "fulfilled" || !Array.isArray(boards[1].value.events)) {
      throw new Error("NBA schedule unavailable");
    }
    const days = boards.filter(board => board.status === "fulfilled" && Array.isArray(board.value.events));
    const regular = game => [2,3].includes(game.season?.type);
    const schedule = slateGames(days.flatMap(board => board.value.events),today,part)
      .filter(game => Date.parse(game.date) > now && game.status?.type?.state === "pre")
      .map(game => ({
        start:game.date,
        teams:(game.competitions?.[0]?.competitors || []).map(entry => entry.team?.abbreviation).filter(Boolean)
      })).filter(game => game.teams.length === 2);
    const teams = new Set(schedule.flatMap(game => game.teams));
    if (!teams.size) return {players:[],schedule,part,partial:days.length < dates.length};
    const finished = new Map();
    for (const board of days) {
      for (const game of board.value.events) {
        if (regular(game) && game.status?.type?.completed && Date.parse(game.date) < now &&
            (game.competitions?.[0]?.competitors || []).some(entry => teams.has(entry.team?.abbreviation))) {
          finished.set(game.id,game);
        }
      }
    }
    // Reserve room under the Worker subrequest limit and bound provider concurrency.
    const games = [...finished.values()].sort((a,b) => Date.parse(b.date) - Date.parse(a.date)).slice(0,36);
    const players = new Map();
    let partial = games.length < finished.size || days.length < dates.length;
    for (let offset = 0; offset < games.length; offset += 6) {
      await Promise.all(games.slice(offset,offset+6).map(async game => {
        try {
          const rows = playerBoxScores(await getJson(espnNBA + "/summary?event=" + encodeURIComponent(game.id)));
          for (const {id,player,team,minutes,values} of rows) {
            if (!teams.has(team)) continue;
            const key = id + ":" + team;
            if (!players.has(key)) players.set(key,{player,team,games:[]});
            const opponent = game.competitions?.[0]?.competitors?.find(entry => entry.team?.abbreviation !== team);
            players.get(key).games.push({date:game.date,minutes,values,opponent:opponent?.team?.abbreviation});
          }
        } catch {
          partial = true;
        }
      }));
    }
    return {players:[...players.values()].map(player => ({
      ...player,games:player.games.sort((a,b) => Date.parse(b.date) - Date.parse(a.date)).slice(0,6)
    })).filter(player => player.games.length >= 4),schedule,part,partial};
  });
}

async function completedNBA(request, date) {
  const days = await cachedNBA(request,"results-schedule-v1/" + date,900,() =>
    getJson(espnNBA + "/scoreboard?dates=" + date));
  if (!Array.isArray(days.events)) throw new Error("Missing NBA results schedule");
  const games = days.events.filter(game => game.status?.type?.name === "STATUS_FINAL" &&
    /^\d+$/.test(game.id) && Number.isFinite(Date.parse(game.date))).slice(0,16);
  const results = [];
  for (let offset = 0; offset < games.length; offset += 6) {
    const batch = await Promise.allSettled(games.slice(offset,offset+6).map(async game => ({
      start:game.date,
      players:await cachedNBA(request,"box-v1/" + game.id,86400,async () =>
        playerBoxScores(await getJson(espnNBA + "/summary?event=" + encodeURIComponent(game.id))))
    })));
    results.push(...batch.filter(item => item.status === "fulfilled").map(item => item.value));
  }
  return {results,partial:results.length < games.length};
}

function normalizeNBAAvailability(data) {
  if (data.status !== "success" || !Array.isArray(data.injuries)) throw new Error("Missing NBA injury report");
  return data.injuries.flatMap(team => Array.isArray(team.injuries) ? team.injuries : [])
    .map(row => ({player:row.athlete?.displayName,team:row.athlete?.team?.abbreviation,
      status:row.status,updatedAt:row.date,returnDate:row.details?.returnDate}))
    .filter(row => typeof row.player === "string" && typeof row.team === "string" &&
      typeof row.status === "string" && Number.isFinite(Date.parse(row.updatedAt)));
}

export async function onRequestGet({request}) {
  if (new URL(request.url).searchParams.has("availability")) {
    try {
      return json(await cachedNBA(request,"availability-v1",300,async () => ({
        reports:normalizeNBAAvailability(await getJson(espnNBA + "/injuries")),checkedAt:new Date().toISOString()
      })));
    } catch {
      return Response.json({error:"NBA availability is temporarily unavailable"},{status:502});
    }
  }
  const params = new URL(request.url).searchParams;
  const date = params.get("results");
  const part = params.get("part");
  const now = Date.now();
  if (part !== null && !["0","1"].includes(part)) {
    return Response.json({error:"NBA slate part must be 0 or 1"},{status:400});
  }
  if (date !== null && (!/^\d{8}$/.test(date) || date < nbaDate(now - 15*86400000) || date > nbaDate(now))) {
    return Response.json({error:"Results are available for the past 15 days"},{status:400});
  }
  try { return json(date ? await completedNBA(request,date) : await recentNBA(request,now,part === null ? null : Number(part))); }
  catch {
    return Response.json({error:"NBA results are temporarily unavailable"},{
      status:502,headers:{"Cache-Control":"no-store"}
    });
  }
}
