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
async function prizePicksLines(request, env, scan = false) {
  const source = "prizepicksapi.com";
  if (!env.PRIZEPICKS_API_KEY) return json({connected:false,source,lines:[]});
  const cache = caches.default;
  const key = new Request(new URL(scan ? "/api/prizepicks-scan-cache-v1" : "/api/prizepicks-cache-v3", request.url));
  try {
    const cached = await cache.match(key);
    if (cached) return cached;
    const url = new URL("https://prizepicksapi.com/api/v1/projections?league=NBA&status=active&limit=200");
    const headers = {Authorization: `Bearer ${env.PRIZEPICKS_API_KEY}`, Accept:"application/json",
      "X-User-Request":"Load NBA PrizePicks lines for LPPE"};
    const offers = [];
    const seenCursors = new Set();
    let cursor = null;
    let observedAt = null;
    let pages = 0;
    let scanStatus = "complete";
    const pageLimit = scan ? 4 : 1;
    do {
      const response = await fetch(url, {headers});
      if (response.status === 429 && pages) {
        scanStatus = "provider_limit";
        break;
      }
      if (response.status === 429) return json({error:"PrizePicks provider limit reached"},429);
      if (!response.ok) return json({error:"PrizePicks provider unavailable"},502);
      const data = await response.json();
      if (data.meta?.mode !== "live" || !Array.isArray(data.data)) {
        return json({error:"PrizePicks provider returned an unexpected response"},502);
      }
      offers.push(...data.data);
      pages++;
      if (pages === 1 && typeof data.meta.observed_at === "string") observedAt = data.meta.observed_at;
      cursor = typeof data.meta.next_cursor === "string" ? data.meta.next_cursor : null;
      if (!cursor) break;
      if (seenCursors.has(cursor)) {
        scanStatus = "repeated_cursor";
        break;
      }
      seenCursors.add(cursor);
      url.searchParams.set("cursor",cursor);
    } while (pages < pageLimit);
    if (cursor && scanStatus === "complete") scanStatus = "page_limit";
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
    const out = json({connected:true,source,lines,partial:Boolean(cursor),
      observedAt,pages,scanStatus});
    const cachedResponse = out.clone();
    cachedResponse.headers.set("Cache-Control","public, max-age=900");
    try { await cache.put(key,cachedResponse); } catch {}
    return out;
  } catch {
    return json({error:"PrizePicks feed unavailable"},502);
  }
}

export default {
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
    if (path === "/api/prizepicks/scan") return prizePicksLines(request, env, true);
    if (path === "/api/prizepicks") return prizePicksLines(request, env);
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
