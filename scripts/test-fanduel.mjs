import assert from "node:assert/strict";
import test from "node:test";
import { liveRefreshSeconds, applyPlayerProjections, buildLineups, importPlayers, inspectSalaryCSV, profiles } from "../fanduel-optimizer.js";
import { addNBAProjections, applyNBAInjuryReport, attachSlateGames, onRequestGet } from "../functions/api/nba/fanduel.js";
import { buildNFLTournament, rankNFLTournament } from "../fanduel-nfl-tournament.js";

test("separates player and projection rows by cheatsheet contest", () => {
  const salary = [
    "Name,Position,Salary,Team,Opp,Game Date,Slate,PPG Projection",
    "Alex Smith Jr.,QB,7200,BUF,SEA,2026-11-22,Main,20",
    "Alex Smith Jr.,QB,7800,BUF,SEA,2026-11-22,Late,23"
  ].join("\n");
  const projections = [
    "Name,Team,Projection,Game Date,Slate",
    "Alex Smith,BUF,25,2026-11-22,Main",
    "Alex Smith,BUF,29,2026-11-22,Late"
  ].join("\n");

  assert.throws(() => importPlayers(salary,"","NFL"),/Choose a slate/);
  const inspection = inspectSalaryCSV(salary);
  const late = inspection.slates.find(slate => slate.name === "Late");
  const {players,matched} = importPlayers("",projections,"NFL",{inspection,slateKey:late.key});

  assert.equal(players.length,1);
  assert.equal(matched,1);
  assert.equal(players[0].salary,7800);
  assert.equal(players[0].points,29);
});

test("does not apply a missing suffix when two players share a name and team", () => {
  const salary = [
    "ID,Name,Position,Salary,Team,Projection",
    "1,Alex Smith Jr.,QB,7200,BUF,20",
    "2,Alex Smith Sr.,QB,7000,BUF,17",
    "3,James Jones,WR,6200,SEA,12"
  ].join("\n");
  const projections = "Name,Team,Projection\nAlex Smith,BUF,30\nJames Jones,SEA,16";
  const {players,matched} = importPlayers(salary,projections,"NFL");

  assert.equal(matched,1);
  assert.deepEqual(players.map(player => player.points),[20,17,16]);
});

function sampleNFLPool() {
  const teams = ["BUF","SEA","KC","PHI","BAL","DEN"];
  const rows = ["ID,Name,Position,Salary,Team,Projection"];
  for (const position of ["QB","RB","WR","TE","DEF"]) {
    for (const [index,team] of teams.entries()) {
      rows.push([position+index,position+" Player "+index,position,5600+index*150,team,22-index].join(","));
    }
  }
  return importPlayers(rows.join("\n"),"","NFL").players;
}

test("finds the best stack while tracking progress and applying portfolio limits", () => {
  const players = sampleNFLPool();
  const completed = [];
  const result = buildLineups(players,4,2,Infinity,"NFL",{
    exactFirst:true,stack:2,exposure:75,onLineup:lineup => completed.push(lineup)
  });

  assert.equal(result.lineups.length,4);
  assert.deepEqual(completed,result.lineups);
  assert.equal(result.lineups[0].points,192);
  for (const [index,lineup] of result.lineups.entries()) {
    const qb = lineup.picks.find(pick => pick.slot === 0).player;
    assert.equal(lineup.ids.size,9);
    assert(lineup.salary <= 60000);
    assert(lineup.picks.filter(({player}) =>
      player.team === qb.team && player.positions.some(position => position === "WR" || position === "TE")).length >= 2);
    for (const earlier of result.lineups.slice(0,index)) {
      assert([...lineup.ids].filter(id => earlier.ids.has(id)).length <= 7);
    }
  }
  for (const player of players) {
    assert(result.lineups.filter(lineup => lineup.ids.has(player.id)).length <= 3);
  }
});

test("selects distinct simulated double stacks within portfolio limits", () => {
  const pool = sampleNFLPool();
  pool[0].selection = "lock";
  const result = buildNFLTournament(pool,4,2,160000,{stack:2});
  assert.equal(result.lineups.length,4);
  for (const [index,lineup] of result.lineups.entries()) {
    const qb = lineup.picks.find(({slot}) => slot === 0).player;
    assert(lineup.ids.has(pool[0].id));
    assert(lineup.picks.filter(({player}) =>
      player.team === qb.team && player.positions.some(position => position === "WR" || position === "TE")).length >= 2);
    assert(Number.isFinite(lineup.tournament.ceiling));
    for (const prior of result.lineups.slice(0,index)) {
      assert(prior.tournament.addedWinCoverage >= lineup.tournament.addedWinCoverage-1e-9);
      assert([...lineup.ids].filter(id => prior.ids.has(id)).length <= 7);
    }
  }
});

test("builds a two-entry tournament portfolio under exposure limits", () => {
  const pool = sampleNFLPool();
  const capped = pool.find(player => player.id === "WR0");
  capped.maxExposure = 50;

  const {lineups} = buildNFLTournament(pool,2,2,160000);
  assert.equal(lineups.length,2);
  assert(lineups.filter(lineup => lineup.ids.has(capped.id)).length <= 1);
  assert([...lineups[0].ids].filter(id => lineups[1].ids.has(id)).length <= 7);
  assert.equal(lineups[0].tournament.addedWinCoverage,lineups[0].tournament.win);
  assert(lineups[1].tournament.addedWinCoverage <= lineups[1].tournament.win);
});

test("uses projected ownership to shape the modeled NFL field", () => {
  const pool = sampleNFLPool();
  const {lineups} = buildLineups(pool,1,1,160000,"NFL");
  const baseline = rankNFLTournament(pool,lineups);
  const weighted = rankNFLTournament(pool.map(player => ({
    ...player,ownership:lineups[0].ids.has(player.id) ? 0.60 : 0
  })),lineups);
  assert.equal(baseline.ownershipPlayers,0);
  assert.equal(weighted.ownershipPlayers,pool.length);
  assert(weighted.lineups[0].tournament.duplicates > baseline.lineups[0].tournament.duplicates);
});

test("keeps tournament metrics stable when slate and candidate order changes", () => {
  const pool = sampleNFLPool();
  const {lineups} = buildLineups(pool,3,2,Infinity,"NFL");
  const first = rankNFLTournament(pool,lineups.slice(0,1));
  const second = rankNFLTournament([...pool].reverse(),[...lineups].reverse());
  const original = lineups[0];
  const sameRoster = second.lineups.find(lineup => [...lineup.ids].every(id => original.ids.has(id)));

  assert(sameRoster);
  assert.equal(first.opponents,second.opponents);
  assert.equal(first.scenarios,second.scenarios);
  assert.deepEqual(first.lineups[0].tournament,sameRoster.tournament);
});

test("keeps a player out when any duplicate salary row reports an unavailable status", () => {
  const csv = [
    "ID,Name,Position,Salary,Team,Projection,Injury Indicator",
    "1,Player One,PG,7200,DEN,20,",
    "1,Player One,SG,7200,DEN,20,Out"
  ].join("\n");
  const {players} = importPlayers(csv);
  assert.deepEqual(players[0].positions,["PG","SG"]);
  assert.equal(players[0].selection,"exclude");
});

test("adds fresh NBA projections only for unambiguous eligible players on the salary slate", () => {
  const date = "2026-11-22";
  const now = Date.parse(date+"T20:00:00Z");
  const lockAt = now+3600000;
  const player = {
    id:"1",name:"Nikola Jokić",team:"DEN",salary:11900,positions:["C"],points:55,selection:"available"
  };
  const opponent = {...player,id:"2",name:"Player Two",team:"CHI",salary:6000,selection:"exclude"};
  const fallback = {...player,id:"3",name:"Player Three",salary:4000};
  const games = [{
    competitions:[{competitors:[{team:{abbreviation:"DEN"}},{team:{abbreviation:"CHI"}}]}],
    date:new Date(lockAt).toISOString(),status:{type:{state:"pre"}}
  }];
  const raw = {date,lockAt,gameCount:1,players:[player,opponent,fallback]};
  assert.equal(attachSlateGames(raw,games,lockAt),raw);
  const pool = attachSlateGames(raw,games,now);
  assert(pool.players.every(player => player.game === "CHI/DEN"));

  const row = {date,name:"Nikola Jokic",team:"DEN",opponent:"CHI",salary:"11900",positions:"C",points:"61"};
  const projection = {rows:[row,{...row,name:"Player Two",team:"CHI",opponent:"DEN",salary:"6000"},
    {...row,name:"Player Three",salary:"4100"}],updatedAt:new Date(now).toISOString()};
  const enriched = addNBAProjections(pool,projection,now);
  assert.deepEqual(enriched.players.map(player => player.points),[61,55,55]);
  assert.equal(enriched.players[0].id,"1");
  assert.equal(enriched.players[0].source,"Daily Fantasy Fuel");
  assert.deepEqual(enriched.projectionCoverage,{matched:1,eligible:2,updatedAt:projection.updatedAt});
  assert.equal(addNBAProjections(pool,projection,now+7200001),pool);
  assert.equal(addNBAProjections(pool,{...projection,rows:[row,row]},now),pool);
  assert.equal(addNBAProjections(pool,{...projection,rows:[{...row,date:"2026-11-23"}]},now),pool);
  assert.equal(addNBAProjections(pool,{...projection,rows:[{...row,positions:"SG"}]},now),pool);
});

test("bounded search returns the exhaustive NBA optimum with flexible slots and uneven salaries", () => {
  const positions = ["PG","SG","SF","PF","C","PG/SG","SF/C","PG","PF","SG","C","SF"];
  const pool = positions.map((position,index) => ({
    id:String(index),name:"Player "+index,team:["DEN","LAL","CHI","ORL"][index%4],
    positions:position.split("/"),salary:4500+(index*337)%3900,points:10+(index*17)%39,
    selection:index === 6 ? "lock" : "available"
  }));
  const {roster,salaryCap,maxTeam} = profiles.NBA;
  const teams = new Map();
  const used = new Set();
  let optimum = -Infinity;
  function enumerate(index,salary,points) {
    if (salary > salaryCap) return;
    if (index === roster.length) {
      if (used.has("6") && [...teams.values()].filter(Boolean).length >= 3) optimum = Math.max(optimum,points);
      return;
    }
    for (const player of pool) {
      const teamCount = teams.get(player.team) || 0;
      if (used.has(player.id) || teamCount >= maxTeam ||
          !player.positions.some(position => roster[index][1].includes(position))) continue;
      used.add(player.id);
      teams.set(player.team,teamCount+1);
      enumerate(index+1,salary+player.salary,points+player.points);
      used.delete(player.id);
      teams.set(player.team,teamCount);
    }
  }
  pool[4].points = 99;
  enumerate(0,0,0);
  assert(Number.isFinite(optimum));
  const result = buildLineups(pool,1,1,Infinity,"NBA",{exactFirst:true});
  assert.equal(result.lineups[0].points,optimum);
  assert.equal(result.limited,false);
});

test("custom live projections preserve salary, selection and fallback estimates", () => {
  const baseline = [
    {id:"137-A",name:"Alex Smith Jr.",team:"BUF",salary:6500,points:11,source:"FanDuel FPPG",selection:"lock"},
    {id:"137-B",name:"Randy Jones",team:"BUF",salary:7000,points:14,source:"FanDuel FPPG",selection:"exclude"},
    {id:"137-C",name:"Peter James",team:"KC",salary:5400,points:16,source:"FanDuel FPPG",selection:"available"}
  ];
  const csv = [
    "ID,Name,Team,Projection,Ceiling,Ownership %,Game Date",
    ",Alex Smith,BUF,0,12,12.5%,2026-11-22",
    "137-B,,,30,36,20%,2026-11-23"
  ].join("\n");
  const result = applyPlayerProjections(baseline,csv,"NFL",{date:"2026-11-22"});
  assert.equal(result.matched,1);
  assert.deepEqual(result.players[0],{...baseline[0],source:"Projection CSV",points:0,ceiling:12,ownership:0.125});
  assert.deepEqual(result.players.slice(1),baseline.slice(1));
  assert.equal(baseline[0].points,11);
  assert.throws(() => applyPlayerProjections(baseline,csv,"NFL",{date:"2026-11-24"}),/Projection CSV/);
});

test("recent confirmed NBA absences can exclude additional players without clearing provider statuses", () => {
  const now = Date.parse("2026-11-22T20:00:00Z");
  const entry = (displayName,status,returnDate,team = "CHI") => ({
    status,date:"2026-11-22T18:00:00Z",details:{returnDate},
    athlete:{displayName,team:{abbreviation:team}}
  });
  const players = ["Alex Smith","Jamie Jones","John Miller","Casey Cook"].map(name => ({
    name,team:"CHI",selection:name === "Jamie Jones" ? "exclude" : "available",
    status:name === "Jamie Jones" ? "Out" : ""
  }));
  const data = {date:"2026-11-22",players,updatedAt:"2026-11-22T12:00:00Z"};
  const injuries = {
    timestamp:new Date(now).toISOString(),
    injuries:[{injuries:[
      entry("Alex Smith","Out","2026-11-26"),
      entry("Jamie Jones","Day-To-Day","2026-11-22"),
      entry("John Miller","Out","2026-11-22"),
      entry("Casey Cook","Out","2026-11-26","BOS")
    ]}]
  };
  const result = applyNBAInjuryReport(data,injuries,now);
  assert.deepEqual(result.players.map(player => player.selection),["exclude","exclude","available","available"]);
  assert.equal(result.injuryCoverage.excluded,1);
  assert.equal(result.players[0].injurySource,"ESPN");
  const current = {...data,updatedAt:"2026-11-22T19:59:00Z"};
  assert.equal(applyNBAInjuryReport(current,injuries,now),current);
  assert.equal(applyNBAInjuryReport(data,injuries,now+3600001),data);
});

test("refreshing NBA projections reuses the longer-lived salary cache", async context => {
  const responses = new Map();
  globalThis.caches = {default:{
    async match(request) { return responses.get(request.url)?.clone(); },
    async put(request,response) { responses.set(request.url,response.clone()); }
  }};
  context.after(() => { delete globalThis.caches; });

  const providerCalls = [];
  const publicCalls = [];
  const startsAt = new Date(Date.now()+3*3600000).toISOString();
  context.mock.method(globalThis,"fetch",async input => {
    const url = new URL(input);
    if (url.hostname !== "fanduelapi.com") {
      publicCalls.push(url.href);
      return new Response("",{status:503});
    }
    providerCalls.push(url.pathname);
    const data = url.pathname.endsWith("/players") ?
      Array.from({length:10},(_,index) => ({
        id:String(index),name:"Player "+index,team:["ORL","DEN","BOS"][index%3],position:"PG",salary:5500,fppg:20
      })) :
      [{id:"1",label:"Main",sport:"NBA",started:false,starts_at:startsAt,salary_cap:60000,games:2,players:10}];
    return Response.json({data});
  });

  const reply = () => onRequestGet({
    request:new Request("https://example.com/api/nba/fanduel?slate=1"),
    env:{FANDUEL_API_KEY:"fd_test_fixture"}
  });
  assert.equal((await reply()).status,200);
  assert.equal((await reply()).status,200);
  assert.equal(providerCalls.length,2);
  assert.equal(publicCalls.length,3);
  for (const [url,response] of responses) {
    if (url.endsWith("/slates") || url.includes("/nba-salaries/")) {
      assert.equal(response.headers.get("cache-control"),"public, max-age=1800");
    }
  }
  for (const key of responses.keys()) {
    if (key.endsWith("/provider/1")) responses.delete(key);
  }
  assert.equal((await reply()).status,200);
  assert.equal(providerCalls.length,2);
  assert.equal(publicCalls.length,6);
});

test("matches NFL schedule aliases and supports projections on a multi-day slate", () => {
  const lockAt = Date.parse("2026-11-22T21:05:00Z");
  const players = ["JAC","NYG","LAC","NYJ"].map((team,index) => ({
    id:"A-"+index,name:"Player "+index,team,points:12
  }));
  const pool = {date:"2026-11-22",lockAt,gameCount:2,players};
  const event = (teams,date) => ({
    competitions:[{competitors:teams.map(abbreviation => ({team:{abbreviation}}))}],
    date,status:{type:{state:"pre"}}
  });
  const first = event(["JAX","NYG"],"2026-11-22T21:05:00Z");
  const second = event(["LAC","NYJ"],"2026-11-24T01:20:00Z");
  assert.equal(attachSlateGames(pool,[first],lockAt-1,"NFL"),pool);
  const result = attachSlateGames(pool,[first,first,second],lockAt-1,"NFL");
  assert.deepEqual(result.players.map(player => [player.game,player.gameDate]),[
    ["JAC/NYG","2026-11-22"],["JAC/NYG","2026-11-22"],
    ["LAC/NYJ","2026-11-23"],["LAC/NYJ","2026-11-23"]
  ]);
  const projections = "ID,Projection,Game Date\nA-2,19,2026-11-23\nA-3,25,2026-11-26";
  const overlay = applyPlayerProjections(result.players,projections,"NFL",{date:pool.date});
  assert.equal(overlay.matched,1);
  assert.deepEqual(overlay.players.map(player => player.points),[12,12,19,12]);
});


test("credit-saving refresh switches at the final hour", () => {
  const now = 100000;
  assert.equal(liveRefreshSeconds(null,now),1800);
  assert.equal(liveRefreshSeconds(now+7200000,now),1800);
  assert.equal(liveRefreshSeconds(now+3900000,now),300);
  assert.equal(liveRefreshSeconds(now+3600000,now),600);
});

test("NBA simulation honors locks, caps and uniqueness and saves a projection comparison",async () => {
  const {buildNBATournament,addRotations}=await import("../fanduel-nba-tournament.js");
  const now=Date.now();
  const players=Array.from({length:40},(_,i)=>({id:"p"+i,name:"Player "+i,
    team:["A","B","C","D"][i%4],game:i%4<2?"A/B":"C/D",positions:[["PG","SG","SF","PF","C"][i%5]],
    salary:4200+i*60,points:22+i*.4,source:"FanDuel FPPG",selection:i===0?"lock":i===1?"exclude":"available",
    maxExposure:i===2?34:100,rotation:undefined}));
  const games=[30,28,26,22].map((minutes,i)=>({minutes,starter:true,date:new Date(now-(i+1)*86400000).toISOString()}));
  const joined=addRotations(players,[{player:"Player 0",team:"A",games}],now);
  assert.equal(joined[0].rotation.length,4);
  const result=buildNBATournament(joined,3,2,18000,{fieldSize:200,exposure:80});
  assert.equal(result.baseline.length,3);
  assert.equal(result.lineups.length,3);
  assert.equal(result.simulation.opponents,197);
  const usage=new Map();
  for(const [i,l] of result.lineups.entries()) {
    assert.equal(l.ids.size,9);
    assert.ok(l.salary<=60000 && l.ids.has("p0") && !l.ids.has("p1"));
    assert.ok(l.tournament.win>=0 && l.tournament.win<=1);
    for(const id of l.ids)usage.set(id,(usage.get(id)||0)+1);
    for(const old of result.lineups.slice(0,i))assert.ok([...l.ids].filter(id=>!old.ids.has(id)).length>=2);
  }
  assert.ok((usage.get("p2")||0)<=1);
  assert.ok([...usage].every(([id,n])=>id==="p0" || n<=2));
});
