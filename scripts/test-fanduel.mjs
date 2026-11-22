import assert from "node:assert/strict";
import test from "node:test";
import { buildLineups, importPlayers, inspectSalaryCSV } from "../fanduel-optimizer.js";
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
