// LPPE Cloudflare Worker — deploy this separately to lppe-api after configuring secrets.
// THE_ODDS_API_KEY: Cloudflare Worker secret (never store a key in GitHub).
// The Odds API: https://the-odds-api.com/sports/nba-odds.html
const ORIGIN = "https://lppe.pages.dev";
const MARKETS = "player_points,player_rebounds,player_assists,player_threes";
const json = (body, status = 200) => new Response(JSON.stringify(body), {
  status, headers: { "Content-Type":"application/json; charset=utf-8",
    "Access-Control-Allow-Origin":ORIGIN,
    "Cache-Control":"no-store" }
});
const cacheHeaders = {"Accept":"application/json"};
const marketNames = {
  player_points:"Points", player_rebounds:"Rebounds",
  player_assists:"Assists", player_threes:"Three-pointers"
};
async function getJson(url) {
  const response = await fetch(url, {headers:cacheHeaders});
  if (!response.ok) throw new Error("Provider HTTP " + response.status);
  return response.json();
}
async function sportsbookLines(env) {
  if (!env.THE_ODDS_API_KEY) return {connected:false,source:"the_odds_api",lines:[],
    message:"THE_ODDS_API_KEY has not been configured."};
  const key = encodeURIComponent(env.THE_ODDS_API_KEY);
  const base = "https://api.the-odds-api.com/v4/sports/basketball_nba";
  const events = await getJson(base + "/events?apiKey=" + key);
  if (!Array.isArray(events)) throw new Error("Invalid events payload");
  // Limit event requests to protect API quota; each event prop request costs credits.
  const lines = [];
  for (const event of events.slice(0, 4)) {
    if (!event || typeof event.id !== "string") continue;
    const u = base + "/events/" + encodeURIComponent(event.id) +
      "/odds?regions=us&markets=" + MARKETS + "&oddsFormat=american&apiKey=" + key;
    const odds = await getJson(u);
    for (const book of odds.bookmakers || []) {
      for (const market of book.markets || []) {
        if (!marketNames[market.key]) continue;
        for (const outcome of market.outcomes || []) {
          if (!["Over","Under"].includes(outcome.name) ||
              typeof outcome.description !== "string" ||
              !Number.isFinite(outcome.point) || !Number.isFinite(outcome.price)) continue;
          lines.push({player:outcome.description,market:marketNames[market.key],
            line:outcome.point,side:outcome.name === "Over" ? "MORE" : "LESS",
            americanOdds:outcome.price,bookmaker:book.title || book.key,
            source:"sportsbook",eventId:event.id,
            eventStart:event.commence_time || null,
            updatedAt:market.last_update || book.last_update || null});
        }
      }
    }
  }
  return {connected:true,source:"the_odds_api",count:lines.length,lines,
    message:"Sportsbook odds only. No independent projections or model probabilities."};
}

function providerRetryAt(response,code,now) {
  const reset = response.headers.get("X-Quota-Reset");
  const retry = response.headers.get("Retry-After");
  const retryAt = retry && /^\d+$/.test(retry) ? now + Number(retry)*1000 : Date.parse(retry);
  if (code === "MONTHLY_QUOTA_EXCEEDED") {
    const date = new Date(now);
    const monthEnd = Date.UTC(date.getUTCFullYear(),date.getUTCMonth()+1,1);
    const resetAt = reset && /^\d+$/.test(reset) ?
      Number(reset) * (reset.length < 13 ? 1000 : 1) : Date.parse(reset);
    return resetAt > now ? resetAt : monthEnd;
  }
  return retryAt > now ? retryAt : now + 300000;
}

async function refreshPrizePicksBoard(request, env) {
  const source = "prizepicksapi.com";
  const cache = caches.default;
  const cacheKey = path => new Request(new URL(path, request.url));
  const boardKey = cacheKey("/lppe-internal/prizepicks-compact-board-v2");
  const snapshotKey = cacheKey("/lppe-internal/prizepicks-compact-snapshot-v2");
  async function remember(key, body, seconds) {
    const response = json(body);
    response.headers.set("Cache-Control","public, max-age=" + seconds);
    try { await cache.put(key,response); } catch {}
  }
  function limited(details,saved) {
    if (saved?.board?.lines.length) return json({...saved.board,savedBoard:true,...details});
    return json({error:"PrizePicks provider limit reached",...details},429);
  }
  try {
    const cached = await cache.match(boardKey);
    if (cached) return json(await cached.json());
    const snapshot = await cache.match(snapshotKey);
    const saved = snapshot ? await snapshot.json() : null;
    const cooldown = await env.PRIZEPICKS_BOARD.get("cooldown", "json");
    if (cooldown && Date.parse(cooldown.retryAt) > Date.now()) return limited(cooldown,saved);
    // Request at most one 100-row credit unit per scheduled refresh.
    const url = "https://prizepicksapi.com/api/v1/projections?league=NBA&status=active&view=compact&limit=100";
    const headers = {Authorization: `Bearer ${env.PRIZEPICKS_API_KEY}`, Accept:"application/json",
      "X-User-Request":"Load NBA PrizePicks lines for LPPE"};
    if (saved?.etag) headers["If-None-Match"] = saved.etag;
    const response = await fetch(url,{headers});
    if (response.status === 304 && saved?.board) {
      await remember(boardKey,saved.board,900);
      return json(saved.board);
    }
    if (response.status === 429) {
      const error = await response.json().catch(() => null);
      const providerCode = ["MONTHLY_QUOTA_EXCEEDED","RATE_LIMIT_EXCEEDED"].includes(error?.error?.code)
        ? error.error.code : "PROVIDER_LIMIT";
      const now = Date.now();
      const next = providerRetryAt(response,providerCode,now);
      const details = {providerCode,retryAt:new Date(next).toISOString()};
      await env.PRIZEPICKS_BOARD.put("cooldown",JSON.stringify(details));
      return limited(details,saved);
    }
    if (!response.ok) return json({error:"PrizePicks provider unavailable"},502);
    const data = await response.json();
    if (data.meta?.mode !== "live" || data.meta.is_demo === true || !Array.isArray(data.data)) {
      return json({error:"PrizePicks provider returned an unexpected response"},502);
    }
    const offers = data.data;
    const observedAt = typeof data.meta.observed_at === "string" ? data.meta.observed_at : null;
    const partial = Boolean(data.meta.next_cursor);
    const lines = [];
    const offerIds = new Set();
    for (const prop of offers) {
      if (prop?.source !== "prizepicks" || prop.is_demo !== false || prop.league !== "NBA" ||
          prop.status !== "active" || typeof prop.player?.name !== "string" ||
          typeof prop.market?.stat !== "string" || !Number.isFinite(prop.line)) continue;
      const sides = Array.isArray(prop.selections) ? prop.selections.filter(side =>
        side?.available === true && ["more","less"].includes(side.side)).map(side => ({
          side:side.side, tier:typeof side.tier === "string" ? side.tier : ""
        })) : [];
      if (!sides.length || (prop.id && offerIds.has(prop.id))) continue;
      if (prop.id) offerIds.add(prop.id);
      lines.push({player:prop.player.name, market:prop.market.stat, line:prop.line, sides,
        period:typeof prop.market.period === "string" ? prop.market.period : "",
        id:typeof prop.id === "string" ? prop.id : null,
        team:typeof prop.player.team === "string" ? prop.player.team : null,
        openingLine:Number.isFinite(prop.line_context?.opening_line) ? prop.line_context.opening_line : null,
        opponent:typeof prop.event?.opponent === "string" ? prop.event.opponent : null,
        eventStart:typeof prop.event?.starts_at === "string" ? prop.event.starts_at : null,
        observedAt:typeof prop.observed_at === "string" ? prop.observed_at : null});
    }
    const board = {connected:true,source,lines,partial,observedAt,pages:1,
      scanStatus:partial ? "page_limit" : "complete"};
    if (offers.length && !lines.length) {
      return json({error:"PrizePicks provider returned no usable live rows"},502);
    }
    await remember(boardKey,board,900);
    await remember(snapshotKey,{board,etag:response.headers.get("ETag")},86400);
    return json(board);
  } catch {
    return json({error:"PrizePicks feed unavailable"},502);
  }
}

async function prizePicksLines(env) {
  if (!env.PRIZEPICKS_API_KEY || !env.PRIZEPICKS_BOARD) {
    return json({connected:false,source:"prizepicksapi.com",lines:[]});
  }
  const [board,cooldown] = await Promise.all([
    env.PRIZEPICKS_BOARD.get("board","json"),
    env.PRIZEPICKS_BOARD.get("cooldown","json")
  ]);
  if (cooldown && Date.parse(cooldown.retryAt) > Date.now()) {
    return board ? json({...board,...cooldown,savedBoard:true}) :
      json({error:"PrizePicks provider limit reached",...cooldown},429);
  }
  return json(board ?? {connected:true,source:"prizepicksapi.com",lines:[],scheduled:true});
}

export default {
  async scheduled(controller,env) {
    if (!env.PRIZEPICKS_API_KEY || !env.PRIZEPICKS_BOARD) return;
    const request = new Request("https://lppe-api.lord-joseph.workers.dev/api/prizepicks");
    const response = await refreshPrizePicksBoard(request,env);
    if (!response.ok) return;
    const board = await response.json();
    if (!board.savedBoard) await env.PRIZEPICKS_BOARD.put("board",JSON.stringify(board));
  },
  async fetch(request, env) {
    if (request.method === "OPTIONS") return new Response(null, {status:204,
      headers:{"Access-Control-Allow-Origin":ORIGIN,
        "Access-Control-Allow-Methods":"GET, OPTIONS",
        "Access-Control-Allow-Headers":"Content-Type"}});
    if (request.method !== "GET") return json({error:"Method not allowed"},405);
    const path = new URL(request.url).pathname;
    if (path === "/" || path === "/health") return json({
      app:"LPPE",status:"online",version:"0.3",message:"LPPE API is running"});
    if (path === "/api/props") return json({sport:"NBA",live:false,
      source:"not_connected",count:0,props:[],
      message:"No independent projections are connected. Do not infer probabilities from odds."});
    if (path === "/api/prizepicks/scan") return prizePicksLines(env);
    if (path === "/api/prizepicks") return prizePicksLines(env);
    if (path === "/api/lines") {
      // Cache successful results for 15 minutes to reduce paid provider requests.
      const cache = caches.default;
      const cacheKey = new Request(new URL("/api/lines", request.url).toString(), {method:"GET"});
      const cached = await cache.match(cacheKey);
      if (cached) return cached;
      try {
        const result = await sportsbookLines(env);
        const response = json(result);
        if (result.connected) {
          const cacheResponse = new Response(JSON.stringify(result), {headers:{
            "Content-Type":"application/json; charset=utf-8",
            "Access-Control-Allow-Origin":ORIGIN,
            "Cache-Control":"public, max-age=900"
          }});
          await cache.put(cacheKey, cacheResponse.clone());
        }
        return response;
      } catch (e) {
        return json({error:"Sportsbook feed unavailable",detail:String(e.message)},502);
      }
    }
    return json({error:"Endpoint not found"},404);
  }
};
