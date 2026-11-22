import assert from "node:assert/strict";
import test from "node:test";
import { buildLineups, importPlayers, inspectSalaryCSV, profiles } from "../fanduel-optimizer.js";
import { addNBAProjections, attachNBAGames } from "../functions/api/nba/fanduel.js";
import { rankNFLTournament } from "../fanduel-nfl-tournament.js";

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
  assert.equal(attachNBAGames(raw,games,lockAt),raw);
  const pool = attachNBAGames(raw,games,now);
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
  enumerate(0,0,0);
  assert(Number.isFinite(optimum));
  const result = buildLineups(pool,1,1,Infinity,"NBA",{exactFirst:true});
  assert.equal(result.lineups[0].points,optimum);
  assert.equal(result.limited,false);
});
