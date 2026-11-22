import assert from "node:assert/strict";
import {readFile} from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

import worker from "../worker/lppe-api.js";

const now = Date.parse("2026-11-22T20:20:00Z");
const observedAt = new Date(now-60000).toISOString();
const firstSlot = Date.parse("2026-11-22T18:00:00Z");
const eventStart = "2026-11-22T22:00:00Z";
const compactOffer = {
  id:"pp_1",league:"NBA",player:"José Smith",team:"BOS",stat:"Points",period:"Full Game",
  line:20.5,tier:"standard",sides:["more","less"],observed_at:observedAt,
  starts_at:eventStart,opponent:"NYK",opening_line:19.5
};

function mockKV() {
  const entries = new Map();
  return {
    async get(key) { return entries.get(key)?.value ?? null; },
    async getWithMetadata(key) { return entries.get(key) ?? {value:null,metadata:null}; },
    async put(key,value,{metadata} = {}) {
      entries.set(key,{value:JSON.parse(value),metadata});
    }
  };
}

test("scheduled refresh saves compact live offers and reuses the validator without refreshing observation time", async t => {
  const env = {PRIZEPICKS_API_KEY:"test-key",PRIZEPICKS_BOARD:mockKV()};
  const request = new Request("https://worker.example/api/prizepicks");
  assert.equal((await (await worker.fetch(request,env)).json()).scheduled,true);
  const provider = t.mock.method(globalThis,"fetch",async (url,options) => {
    assert.equal(new URL(url).searchParams.get("view"),"compact");
    assert.equal(new URL(url).searchParams.get("limit"),"100");
    if (options.headers["If-None-Match"]) {
      assert.equal(options.headers["If-None-Match"],'"1"');
      return new Response(null,{status:304});
    }
    return Response.json({data:[compactOffer,{...compactOffer,id:"no-sides",sides:[]}],meta:{
      mode:"live",source_status:"partial",observed_at:observedAt
    }},{headers:{ETag:'"1"'}});
  });
  await worker.scheduled({scheduledTime:firstSlot},env);
  const first = await (await worker.fetch(request,env)).json();
  assert.equal(first.partial,true);
  assert.deepEqual(first.lines,[{id:"pp_1",player:"José Smith",team:"BOS",market:"Points",
    period:"Full Game",line:20.5,sides:[{side:"more",tier:"standard"},{side:"less",tier:"standard"}],
    eventStart,opponent:"NYK",openingLine:19.5,observedAt}]);
  assert.equal(first.lastRefresh.outcome,"saved");

  await worker.scheduled({scheduledTime:firstSlot},env);
  assert.equal(provider.mock.callCount(),1);
  await worker.scheduled({scheduledTime:firstSlot+5*3600000},env);
  const second = await (await worker.fetch(request,env)).json();
  assert.equal(second.lastRefresh.outcome,"unchanged");
  assert.equal(second.lines[0].observedAt,observedAt);

  provider.mock.mockImplementation(async () => new Response(null,{status:401}));
  await worker.scheduled({scheduledTime:firstSlot+8*3600000},env);
  const failed = await (await worker.fetch(request,env)).json();
  assert.deepEqual(failed.lines,first.lines);
  assert.equal(failed.lastRefresh.providerStatus,401);
  const calls = provider.mock.callCount();
  await worker.fetch(request,env);
  assert.equal(provider.mock.callCount(),calls);
});

test("scheduled refresh exposes provider limits and rejects demo data", async t => {
  const env = {PRIZEPICKS_API_KEY:"test-key",PRIZEPICKS_BOARD:mockKV()};
  const request = new Request("https://worker.example/api/prizepicks/scan");
  const provider = t.mock.method(globalThis,"fetch",async () => Response.json({
    data:[compactOffer],meta:{mode:"demo"}
  }));
  await worker.scheduled({scheduledTime:firstSlot},env);
  const demo = await (await worker.fetch(request,env)).json();
  assert.equal(demo.scheduled,true);
  assert.equal(demo.lines.length,0);
  assert.equal(demo.lastRefresh.outcome,"refresh_failed");

  provider.mock.mockImplementation(async () => Response.json({error:{code:"RATE_LIMIT_EXCEEDED"}},
    {status:429,headers:{"Retry-After":"120"}}));
  await worker.scheduled({scheduledTime:firstSlot+5*3600000},env);
  const limited = await worker.fetch(request,env);
  assert.equal(limited.status,429);
  assert.equal((await limited.json()).providerCode,"RATE_LIMIT_EXCEEDED");
});

test("market ranks the median of fresh and complete exact-line sportsbook quotes", async () => {
  const html = await readFile(new URL("../index.html",import.meta.url),"utf8");
  const engine = html.slice(html.indexOf("const supportedMarkets"),html.indexOf("function hitDistribution"));
  const names = html.slice(html.indexOf("const modelPlayerKey"),html.indexOf("const modelTeamKey"));
  const rank = vm.runInNewContext(names+engine+"\nrankMarketProps");
  const prop = {player:compactOffer.player,market:compactOffer.stat,period:compactOffer.period,
    line:compactOffer.line,eventStart,observedAt,sides:[{side:"more",tier:"standard"},{side:"less",tier:"standard"}]};
  const quote = (bookmaker,side,americanOdds,details = {}) => ({
    player:"Jose Smith",market:"Points",line:20.5,eventStart,eventId:"game1",updatedAt:observedAt,
    bookmaker,side,americanOdds,...details
  });
  const older = new Date(now-120000).toISOString();
  const odds = [
    quote("Book A","MORE",-150),quote("Book A","LESS",150),
    quote("Book A","MORE",-110,{updatedAt:older}),quote("Book A","LESS",-110,{updatedAt:older}),
    quote("Book B","MORE",-180),quote("Book B","LESS",180),
    quote("Book C","MORE",900),quote("Book C","LESS",-900),
    quote("Book D","MORE",-900),quote("Book D","LESS",900,{updatedAt:older}),
    quote("Book E","MORE",-900,{line:21.5}),quote("Book E","LESS",900,{line:21.5})
  ];
  const ranked = rank([prop],odds,now);
  assert.equal(ranked[0].side,"MORE");
  assert.equal(ranked[0].chance,0.6);
  assert.equal(ranked[0].books,3);
  assert.equal(ranked[1].chance,0.4);
  assert.equal(rank([prop],odds,Date.parse(observedAt)+1800000)[0].chance,null);
  assert.equal(rank([prop],[...odds,quote("Book F","MORE",-100,{eventId:"ambiguous"})],now)[0].chance,null);
});

test("outside research uses only an unambiguous upcoming game and retains push counts", async () => {
  const html = await readFile(new URL("../index.html",import.meta.url),"utf8");
  const source = (from,to) => html.slice(html.indexOf(from),html.indexOf(to));
  const inspect = vm.runInNewContext([
    source("const modelMarketColumns","function nbaStatValue"),
    source("function nbaStatValue","let nbaAvailability"),
    source("function recentModelGames","function estimateNBAProps"),
    source("const outsideDate","const outsideCompareBooks ="),
    "researchOutsidePick"
  ].join("\n"),{dayMillis:86400000});
  const pick = {date:"2026-11-22",player:"Jose Smith",market:"points",line:20,side:"MORE"};
  const player = {player:"José Smith",team:"BOS",games:[24,22,20,18,25].map((points,index) => ({
    date:new Date(now-(index+1)*86400000).toISOString(),minutes:30,values:[points,0,0,0]
  }))};
  const data = {players:[player],schedule:[{start:eventStart,teams:["BOS","NYK"]}]};
  const result = inspect(data,pick,now);
  assert.equal(result.hits,3);
  assert.equal(result.count,5);
  assert.equal(result.ties,1);
  assert.equal(result.chance,0.625);
  assert.equal(inspect(data,pick,Date.parse(eventStart)),null);
  assert.equal(inspect({...data,players:[player,{...player,team:"NYK"}]},pick,now),null);
});

test("NBA slate partitions remain disjoint even when scoreboards overlap or arrive out of order", async () => {
  const code = await readFile(new URL("../functions/api/nba/model.js",import.meta.url),"utf8");
  const schedule = code.slice(code.indexOf("function slateGames"),code.indexOf("async function recentNBA"));
  const split = vm.runInNewContext(schedule+"\nslateGames",{
    pacificSlate:new Intl.DateTimeFormat("en-CA",{timeZone:"America/Los_Angeles",dateStyle:"short"})
  });
  const game = (id,date) => ({id,date,season:{type:2}});
  const first = game("1","2026-11-22T23:00Z");
  const second = game("2","2026-11-23T00:00Z");
  const third = game("3","2026-11-23T00:00Z");
  const tomorrow = game("4","2026-11-24T00:00Z");
  const events = [third,first,tomorrow,second,second];
  const date = new Intl.DateTimeFormat("en-CA",{timeZone:"America/Los_Angeles",dateStyle:"short"}).format(now);
  assert.deepEqual(Array.from(split(events,date,0),game => game.id),["1","3"]);
  assert.deepEqual(Array.from(split(events,date,1),game => game.id),["2"]);
});

test("half-point estimates react to the spread and sum to one across sides", async () => {
  const html = await readFile(new URL("../index.html",import.meta.url),"utf8");
  const probability = html.slice(html.indexOf("function normalCDF"),html.indexOf("function grade("));
  const model = html.slice(html.indexOf("const modelSpreadFloor"),html.indexOf("function estimateNBAProps"));
  const estimate = vm.runInNewContext(probability+model+"\nlineHitEstimate");
  const values = [25,18,25,30,31];
  const more = estimate(values,20.5,"MORE","points");
  const less = estimate(values,20.5,"LESS","points");
  assert.equal(more.hits,4);
  assert.equal(more.method,"Hit rate + spread");
  assert(Math.abs(more.chance+less.chance-1) < 1e-12);
  assert(more.chance > estimate(values,21.5,"MORE","points").chance);
  const push = estimate([25,18,20,30,31],20,"MORE","points");
  assert.equal(push.ties,1);
  assert.equal(push.chance,0.625);
});

test("pregame scheduling checks before tipoff and limits provider reads across schedule changes", async t => {
  const env = {PRIZEPICKS_API_KEY:"test-key",PRIZEPICKS_BOARD:mockKV(),PRIZEPICKS_PREGAME_REFRESH:"1"};
  const day = "2026-11-22";
  const game = hour => ({id:String(hour),date:day+"T"+hour+":30:00Z",season:{type:2}});
  let upcoming = [game(18),game(20),game(22),game(23)];
  let requests = 0;
  t.mock.method(globalThis,"fetch",async url => {
    if (url.includes("espn.com")) return Response.json({events:upcoming});
    requests++;
    return Response.json({data:[compactOffer],meta:{mode:"live",source_status:"fresh",observed_at:observedAt}});
  });
  async function tick(slot) {
    await worker.scheduled({scheduledTime:Date.parse(day+"T"+slot+":00Z")},env);
  }
  await tick("18:00");
  assert.equal(requests,0);
  await tick("18:15");
  await tick("18:15");
  assert.equal(requests,1);
  await tick("20:15");
  await tick("22:15");
  assert.equal(requests,3);
  upcoming = [game(23)];
  await tick("23:15");
  assert.equal(requests,3);
  const request = new Request("https://worker.example/api/prizepicks");
  const board = await (await worker.fetch(request,env)).json();
  assert.equal(board.refreshPolicy,"pregame");
  assert.equal(board.lastRefresh.outcome,"saved");
});
