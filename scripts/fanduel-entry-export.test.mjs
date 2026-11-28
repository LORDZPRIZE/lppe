import assert from "node:assert/strict";
import test from "node:test";
import {readFanDuelEntries,fillFanDuelEntries} from "../fanduel-entry-export.js";
import {csvRecords,profiles} from "../fanduel-optimizer.js";

const metadata="entry_id,contest_id,contest_name,entry_fee";
const slots={
  NBA:"PG,SG,SF,PF,C,G/F,F/C,UTIL,UTIL",
  NFL:"QB,RB1,RB2,WR1,WR2,WR3,TE,FLEX,D/ST",
  MLB:"P,C/1B,2B,3B,SS,OF,OF,OF,UTIL",
  CFB:"QB,RB,RB,WR/TE,WR,WR,SUPER FLEX"
};
function makeLineup(sport,offset=0,fixture="137134") {
  return {picks:profiles[sport].roster.map(([,positions],slot)=>({
    slot,player:{id:fixture+"-"+(offset+slot+1),positions}
  })).reverse()};
}
function template(sport) {
  return "\ufeff"+metadata+","+slots[sport]+',,"Instructions"\r\n'+
    '101,137134-11,"Contest, Saturday",0.25,"137134-501:Existing"\r\n'+
    '102,137134-11,"Contest, Saturday",0.25\r\n'+
    '103,137134-12,Another contest,0.10\r\n'+
    ',,,,,,,,,,137134-503:Catalog player\r\n';
}

for (const sport of Object.keys(slots)) test("exports checked "+sport+" Classic rosters in FanDuel slot order",()=>{
  const data=readFanDuelEntries(template(sport),sport);
  assert.equal(data.contests.size,2);
  const lineup=makeLineup(sport,100);
  const output=fillFanDuelEntries(data,"137134-11",[lineup]);
  assert.equal(output.replaced,0);
  assert.equal(output.count,1);
  const [header,row,...others]=csvRecords(output.csv);
  assert.deepEqual(header.join(","),metadata+","+slots[sport]);
  assert.deepEqual(row.slice(0,4),["102","137134-11","Contest, Saturday","0.25"]);
  assert.deepEqual(row.slice(4),[...lineup.picks].reverse().map(pick=>pick.player.id));
  assert.equal(others.length,0);
});

test("the controlled export rejects a different sport, different slate, or invalid lineup",()=>{
  assert.throws(()=>readFanDuelEntries(template("CFB"),"NFL"),/roster columns/);
  assert.throws(()=>readFanDuelEntries("ID,Name,Position,Salary\n1,Test,QB,7000","CFB"),/entries template/);
  const data=readFanDuelEntries(template("CFB"),"CFB");
  assert.throws(()=>fillFanDuelEntries(data,"137134-11",[makeLineup("CFB",0,"999")]),/this contest's slate/);
  assert.throws(()=>fillFanDuelEntries(data,"137134-11",[{picks:makeLineup("CFB").picks.slice(1)}]),/roster slots/);
  assert.throws(()=>fillFanDuelEntries(data,"137134-12",[makeLineup("CFB"),makeLineup("CFB",10)]),/1 template entries/);
  assert.throws(()=>readFanDuelEntries(template("CFB")+'102,137134-11,"Contest, Saturday",0.25\r\n',"CFB"),/duplicate/);
});

test("prefers empty entries and reports when another checked lineup replaces an existing one",()=>{
  const result=fillFanDuelEntries(readFanDuelEntries(template("NFL"),"NFL"),"137134-11",
    [makeLineup("NFL",10),makeLineup("NFL",50)]);
  assert.equal(result.replaced,1);
  assert.deepEqual(csvRecords(result.csv).slice(1).map(row=>row[0]),["102","101"]);
});
