import {csvRecords, profiles} from "./fanduel-optimizer.js";

const meta = ["entryid","contestid","contestname","entryfee"];
const fullId = /^\d+-\d+$/;
const normalize = value => String(value ?? "").toUpperCase().replace(/[^A-Z0-9]/g,"");
const escapeCell = value => '"'+String(value).replaceAll('"','""')+'"';

function templateSlot(label,sport) {
  const value=normalize(label);
  if (sport==="NFL" && ["D","DST","DEFENSE"].includes(value)) return "DEF";
  if (sport==="CFB" && ["FLEX","SUPERFLEX","SUPERFLX"].includes(value)) return "SFLEX";
  if (sport==="CFB" && value==="WRTE") return "WR";
  return value.replace(/^(RB|WR|OF|UTIL)[123]$/,"$1");
}

export function readFanDuelEntries(source,sport) {
  if (!Object.hasOwn(profiles,sport)) throw new Error("Choose a supported FanDuel Classic sport.");
  const [header,...rows]=csvRecords(source);
  if (!meta.every((name,index)=>normalize(header?.[index]).toLowerCase()===name)) {
    throw new Error("Choose the FanDuel entries template from Upcoming → CSV Edit.");
  }
  const {roster,name}=profiles[sport];
  const end=meta.length+roster.length;
  if (roster.some(([slot],index)=>templateSlot(header[meta.length+index],sport)!==normalize(slot))) {
    throw new Error("The template roster columns do not match FanDuel "+name+" Classic.");
  }

  const contests=new Map();
  const entryIds=new Set();
  for (const row of rows) {
    const [entryId,contestId,contestName,fee]=row;
    if (!entryId) continue; // Help and salary-list rows have no entry ID.
    if (!/^\d+$/.test(entryId) || !fullId.test(contestId) || !contestName ||
        !/^\$?\d+(?:\.\d{1,2})?$/.test(fee) || entryIds.has(entryId)) {
      throw new Error("The template contains an invalid or duplicate FanDuel entry.");
    }
    entryIds.add(entryId);
    const contest=contests.get(contestId) ?? {id:contestId,name:contestName,entries:[]};
    if (contestName!==contest.name) throw new Error("The template gives conflicting names for a contest.");
    contest.entries.push({meta:row.slice(0,meta.length),occupied:row.slice(meta.length,end).some(Boolean)});
    contests.set(contestId,contest);
  }
  if (!contests.size) throw new Error("No existing contest entries were found in the template.");
  return {sport,header:header.slice(0,end),contests};
}

export function fillFanDuelEntries(template,contestId,lineups) {
  const contest=template.contests.get(contestId);
  if (!contest) throw new Error("Choose which FanDuel contest to fill.");
  if (!lineups.length) throw new Error("Check at least one LPPE lineup.");
  if (lineups.length>contest.entries.length) {
    throw new Error("This contest has "+contest.entries.length+" template entries. Select fewer lineups.");
  }
  const {roster}=profiles[template.sport];
  const fixture=contest.id.split("-")[0];
  const rows=[];
  const targets=[...contest.entries.filter(e=>!e.occupied),...contest.entries.filter(e=>e.occupied)];
  for (const [index,lineup] of lineups.entries()) {
    const picks=[...lineup.picks].sort((a,b)=>a.slot-b.slot);
    if (picks.length!==roster.length || new Set(picks.map(({player})=>player.id)).size!==roster.length ||
        picks.some(({slot,player},i)=>slot!==i || !player.positions.some(position=>roster[i][1].includes(position)))) {
      throw new Error("A selected lineup has invalid roster slots. Rebuild in LPPE.");
    }
    const ids=picks.map(({player})=>player.id);
    if (ids.some(id=>!fullId.test(id) || id.split("-")[0]!==fixture)) {
      throw new Error("Selected lineups need exact FanDuel player IDs from this contest's slate. Load that live slate or its FanDuel player-list CSV.");
    }
    const entry=targets[index].meta;
    const safeName=/^[=+@\-\t\r]/.test(entry[2]) ? "'"+entry[2] : entry[2];
    rows.push([entry[0],entry[1],safeName,entry[3],...ids]);
  }
  return {csv:[template.header,...rows].map(row=>row.map(escapeCell).join(",")).join("\r\n")+"\r\n",
    count:rows.length,replaced:targets.slice(0,rows.length).filter(e=>e.occupied).length};
}
