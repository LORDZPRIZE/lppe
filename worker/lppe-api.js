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

function normalizePrizePicksOffer(offer) {
  if (!offer || offer.league !== "NBA" || offer.is_demo === true ||
      typeof offer.id !== "string" || !offer.id.trim() || !Number.isFinite(offer.line)) return null;
  const compact = typeof offer.player === "string";
  if ((compact && offer.source && offer.source !== "prizepicks") ||
      (!compact && (offer.source !== "prizepicks" || offer.is_demo !== false)) ||
      (offer.status ?? (compact ? "active" : null)) !== "active") return null;
  const player = compact ? offer.player : offer.player?.name;
  const market = compact ? offer.stat : offer.market?.stat;
  const period = compact ? offer.period : offer.market?.period;
  const eventStart = compact ? offer.starts_at : offer.event?.starts_at;
  if (![player,market,period].every(value => typeof value === "string" && value.trim())) return null;

  // The compact API places one tier on the offer and returns available side names.
  const selections = compact ? (Array.isArray(offer.sides) ? offer.sides : []).map(side => ({
    side,tier:offer.tier,available:true
  })) : offer.selections;
  const sides = [];
  for (const selection of Array.isArray(selections) ? selections : []) {
    if (selection?.available !== true || !["more","less"].includes(selection.side)) continue;
    const tier = typeof selection.tier === "string" ? selection.tier.trim().toLowerCase() : "";
    if (!sides.some(item => item.side === selection.side && item.tier === tier)) {
      sides.push({side:selection.side,tier});
    }
  }
  if (!sides.length) return null;

  const team = compact ? offer.team : offer.player?.team;
  const opponent = compact ? offer.opponent : offer.event?.opponent;
  const openingLine = compact ? offer.opening_line : offer.line_context?.opening_line;
  return {id:offer.id,player:player.trim(),market:market.trim(),period:period.trim(),line:offer.line,sides,
    team:typeof team === "string" ? team : null,
    opponent:typeof opponent === "string" ? opponent : null,
    openingLine:Number.isFinite(openingLine) ? openingLine : null,
    eventStart:typeof eventStart === "string" ? eventStart : null,
    // Row freshness must come from the provider's confirmation for this offer.
    observedAt:typeof offer.observed_at === "string" ? offer.observed_at : null};
}

async function refreshPrizePicksBoard(env, saved) {
  const source = "prizepicksapi.com";
  function limited(details,saved) {
    if (saved?.board?.lines.length) return json({...saved.board,savedBoard:true,...details});
    return json({error:"PrizePicks provider limit reached",...details},429);
  }
  try {
    const cooldown = await env.PRIZEPICKS_BOARD.get("cooldown", "json");
    if (cooldown && Date.parse(cooldown.retryAt) > Date.now()) return limited(cooldown,saved);
    // Request at most one 100-row credit unit per scheduled refresh.
    const url = "https://prizepicksapi.com/api/v1/projections?league=NBA&status=active&view=compact&limit=100";
    const headers = {Authorization: `Bearer ${env.PRIZEPICKS_API_KEY}`, Accept:"application/json",
      "X-User-Request":"Load NBA PrizePicks lines for LPPE"};
    if (saved?.etag) headers["If-None-Match"] = saved.etag;
    const response = await fetch(url,{headers,signal:AbortSignal.timeout(20000)});
    if (response.status === 304 && saved?.board) {
      return new Response(null,{status:304});
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
    if (!response.ok) return json({error:"PrizePicks provider unavailable",providerStatus:response.status},502);
    const data = await response.json();
    if (data.meta?.mode !== "live" || data.meta.is_demo === true || data.meta.source_status === "demo" || !Array.isArray(data.data)) {
      return json({error:"PrizePicks provider returned an unexpected response"},502);
    }
    const offers = data.data;
    const observedAt = typeof data.meta.observed_at === "string" ? data.meta.observed_at : null;
    const sourceStatus = data.meta.source_status;
    if (["stale","failed","not_configured"].includes(sourceStatus)) {
      return json({error:"PrizePicks provider has no current board",sourceStatus},502);
    }
    const lines = [];
    const offerIds = new Set();
    for (const offer of offers) {
      const prop = normalizePrizePicksOffer(offer);
      if (!prop || offerIds.has(prop.id)) continue;
      offerIds.add(prop.id);
      lines.push(prop);
    }
    const partial = Boolean(data.meta.next_cursor) || sourceStatus === "partial";
    const board = {connected:true,source,lines,partial,observedAt,pages:1,
      scanStatus:data.meta.next_cursor ? "page_limit" : partial ? "partial" : "complete"};
    if (offers.length && !lines.length) {
      return json({error:"PrizePicks provider returned no usable live rows"},502);
    }
    const result = json(board);
    const etag = response.headers.get("ETag");
    if (etag) result.headers.set("ETag",etag);
    return result;
  } catch {
    return json({error:"PrizePicks feed unavailable"},502);
  }
}

async function prizePicksLines(env) {
  if (!env.PRIZEPICKS_API_KEY || !env.PRIZEPICKS_BOARD) {
    return json({connected:false,source:"prizepicksapi.com",lines:[]});
  }
  const [board,cooldown,lastRefresh] = await Promise.all([
    env.PRIZEPICKS_BOARD.get("board","json"),
    env.PRIZEPICKS_BOARD.get("cooldown","json"),
    env.PRIZEPICKS_BOARD.get("lastRefresh","json")
  ]);
  if (cooldown && Date.parse(cooldown.retryAt) > Date.now()) {
    return board ? json({...board,...cooldown,savedBoard:true,lastRefresh}) :
      json({error:"PrizePicks provider limit reached",...cooldown,lastRefresh},429);
  }
  return json({...board ?? {connected:true,source:"prizepicksapi.com",lines:[],scheduled:true},lastRefresh});
}

export default {
  async scheduled(controller,env) {
    const scheduledAt = new Date(controller.scheduledTime).toISOString();
    const log = (outcome,details = {}) => console.log(JSON.stringify({
      event:"prizepicks_refresh",scheduledAt,outcome,...details
    }));
    if (!env.PRIZEPICKS_API_KEY || !env.PRIZEPICKS_BOARD) {
      log("missing_configuration",{keyConfigured:Boolean(env.PRIZEPICKS_API_KEY),kvConfigured:Boolean(env.PRIZEPICKS_BOARD)});
      return;
    }
    const record = async (outcome,details = {}) => {
      log(outcome,details);
      await env.PRIZEPICKS_BOARD.put("lastRefresh",JSON.stringify({scheduledAt,outcome,...details}));
    };
    try {
      const previous = await env.PRIZEPICKS_BOARD.getWithMetadata("board","json");
      if (previous.metadata?.scheduledAt >= scheduledAt) {
        log("already_refreshed");
        return;
      }
      // The validator belongs to the last successfully saved board.
      const saved = {board:previous.value,etag:previous.value ? previous.metadata?.etag : null};
      const response = await refreshPrizePicksBoard(env,saved);
      if (response.status === 304) {
        await env.PRIZEPICKS_BOARD.put("board",JSON.stringify(saved.board),{
          metadata:{etag:saved.etag,scheduledAt}
        });
        await record("unchanged",{lineCount:saved.board.lines.length});
        return;
      }
      const board = await response.json();
      if (!response.ok) {
        await record("refresh_failed",{status:response.status,reason:board.error,providerStatus:board.providerStatus,
          providerCode:board.providerCode,retryAt:board.retryAt});
        return;
      }
      if (board.savedBoard) {
        await record("retained_previous_board",{providerCode:board.providerCode,retryAt:board.retryAt});
        return;
      }
      await env.PRIZEPICKS_BOARD.put("board",JSON.stringify(board),{
        metadata:{etag:response.headers.get("ETag"),scheduledAt}
      });
      await record("saved",{lineCount:board.lines.length,observedAt:board.observedAt});
    } catch {
      log("scheduled_handler_failed");
      throw new Error("PrizePicks scheduled refresh could not save its result");
    }
  },
  async fetch(request, env) {
    if (request.method === "OPTIONS") return new Response(null, {status:204,
      headers:{"Access-Control-Allow-Origin":ORIGIN,
        "Access-Control-Allow-Methods":"GET, OPTIONS",
        "Access-Control-Allow-Headers":"Content-Type"}});
    if (request.method !== "GET") return json({error:"Method not allowed"},405);
    const path = new URL(request.url).pathname;
    if (path === "/" || path === "/health") return json({
      app:"LPPE",status:"online",version:"0.5",message:"LPPE API is running"});
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
