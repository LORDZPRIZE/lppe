export const roster = [
  ["PG", ["PG"]], ["SG", ["SG"]], ["SF", ["SF"]], ["PF", ["PF"]], ["C", ["C"]],
  ["G/F", ["PG", "SG", "SF", "PF"]], ["F/C", ["SF", "PF", "C"]],
  ["UTIL", ["PG", "SG", "SF", "PF", "C"]], ["UTIL", ["PG", "SG", "SF", "PF", "C"]]
];
export const salaryCap = 60000;

function parseCSV(source) {
  const records = [];
  let record = [], field = "", quoted = false;
  for (let i = 0; i < source.length; i++) {
    const character = source[i];
    if (character === '"') {
      if (quoted && source[i + 1] === '"') {
        field += '"';
        i++;
      } else {
        quoted = !quoted;
      }
    } else if (!quoted && (character === "," || character === "\n" || character === "\r")) {
      record.push(field.trim());
      field = "";
      if (character !== ",") {
        if (character === "\r" && source[i + 1] === "\n") i++;
        if (record.some(Boolean)) records.push(record);
        record = [];
      }
    } else {
      field += character;
    }
  }
  if (quoted) throw new Error("The CSV has an unclosed quoted field.");
  record.push(field.trim());
  if (record.some(Boolean)) records.push(record);
  const headings = records.shift()?.map(name => name.toLowerCase().replace(/[^a-z0-9]/g, "")) || [];
  if (!headings.length) throw new Error("The CSV is empty.");
  return records.map(row => Object.fromEntries(headings.map((name, i) => [name, row[i] || ""])));
}

const csvNumber = value => value?.trim() ? Number(value.replace(/[$,]/g, "")) : NaN;
const playerName = row => row.nickname || row.playername || row.player || row.name ||
  [row.firstname,row.lastname].filter(Boolean).join(" ");
export const teamCode = raw => {
  const team = raw?.trim().toUpperCase() || "";
  return {BRK:"BKN",GS:"GSW",NO:"NOP",NY:"NYK",PHO:"PHX",SA:"SAS",UTAH:"UTA",WSH:"WAS"}[team] || team;
};
const matchName = name => name.normalize("NFD").replace(/\p{Mark}/gu, "").toLowerCase().replace(/[^a-z0-9]/g, "");
const unavailable = status => /^(O|OUT|IR|INACTIVE|SUSPENDED|SUSP|DOUBTFUL|D)$/i.test(status || "");

export function importPlayers(salaryCSV, projectionCSV = "") {
  const byId = new Map();
  const byName = new Map();
  function addProjection(map, key, points) {
    if (!key) return;
    if (map.has(key) && map.get(key) !== points) map.set(key, null);
    else map.set(key, points);
  }
  if (projectionCSV.trim()) {
    for (const row of parseCSV(projectionCSV)) {
      const projected = csvNumber(row.projection || row.projectedpoints || row.fantasypoints || row.fpts || row.fppg);
      if (!Number.isFinite(projected)) continue;
      const name = matchName(playerName(row));
      const team = teamCode(row.team || row.teamabbr);
      addProjection(byId,row.id || row.playerid,projected);
      if (name && team) addProjection(byName,name + ":" + team,projected);
    }
    if (!byId.size && !byName.size) throw new Error("Projection CSV needs a numeric Projection column and an ID or player name plus team.");
  }

  const players = new Map();
  let skipped = 0;
  for (const row of parseCSV(salaryCSV)) {
    const id = row.id || row.playerid;
    const name = playerName(row);
    const positions = [...new Set((row.rosterposition || row.position || "").toUpperCase().split(/[\s/,;|-]+/))]
      .filter(position => roster.slice(0,5).some(([slot]) => slot === position));
    const salary = csvNumber(row.salary);
    const team = teamCode(row.team || row.teamabbr);
    if (!id || !name || !positions.length || !Number.isInteger(salary) || salary <= 0 || !team) {
      skipped++;
      continue;
    }
    const matched = byId.get(id) ?? byName.get(matchName(name) + ":" + team);
    const provided = csvNumber(row.projection || row.projectedpoints || row.fpts);
    const average = csvNumber(row.fppg);
    const points = matched ?? (Number.isFinite(provided) ? provided : average);
    const source = matched != null ? "Projection CSV" : Number.isFinite(provided) ? "Salary CSV projection" :
      Number.isFinite(average) ? "FanDuel FPPG" : "";
    const status = row.injuryindicator || row.injurystatus || row.status || "";
    if (players.has(id)) {
      const existing = players.get(id);
      if (existing.team !== team || existing.salary !== salary || existing.name !== name) {
        throw new Error("Conflicting rows share a FanDuel player ID. Use a single slate CSV.");
      }
      existing.positions = [...new Set([...existing.positions, ...positions])];
      continue;
    }
    players.set(id,{id,name,positions,salary,team,points,source,status,
      selection:unavailable(status) ? "exclude" : "available"});
  }
  if (!players.size) throw new Error("No FanDuel players found. Upload a CSV with ID, Name or Nickname, Position, Salary, and Team.");
  return {players:[...players.values()],skipped};
}

export function buildLineups(players, count, difference, searchLimit = 160000) {
  if (!Number.isInteger(count) || count < 1 || count > 20 ||
      !Number.isInteger(difference) || difference < 1 || difference > roster.length) {
    throw new Error("Choose 1–20 lineups and a minimum difference of 1–9 players.");
  }
  const eligible = players.filter(player => player.selection !== "exclude" && Number.isFinite(player.points));
  const locked = players.filter(player => player.selection === "lock");
  if (locked.some(player => !Number.isFinite(player.points))) throw new Error("A locked player is missing a projection.");
  if (locked.length > roster.length) throw new Error("Lock at most nine players.");
  const lockedIds = new Set(locked.map(player => player.id));
  const slots = roster.map(([label,positions],index) => ({
    label,index,pool:eligible.filter(player => player.positions.some(position => positions.includes(position)))
      .sort((a,b) => b.points-a.points || a.salary-b.salary || a.id.localeCompare(b.id))
  })).sort((a,b) => a.pool.length-b.pool.length || a.index-b.index);
  if (slots.some(slot => !slot.pool.length)) return {lineups:[],limited:false};
  const salaryFloor = new Array(slots.length+1).fill(0);
  const pointsCeiling = new Array(slots.length+1).fill(0);
  const possible = new Array(slots.length+1);
  possible[slots.length] = new Set();
  for (let index = slots.length-1; index >= 0; index--) {
    const {pool} = slots[index];
    salaryFloor[index] = salaryFloor[index+1] + Math.min(...pool.map(player => player.salary));
    pointsCeiling[index] = pointsCeiling[index+1] + pool[0].points;
    possible[index] = new Set([...possible[index+1],...pool.map(player => player.id)]);
  }
  const lineups = [];
  let limited = false;
  for (let number = 0; number < count; number++) {
    const selected = [];
    const ids = new Set();
    const teams = new Map();
    const overlaps = lineups.map(() => 0);
    const maximumOverlap = roster.length-difference;
    let nodes = 0;
    let best = null;
    function search(index,salary,points,locksRemaining) {
      nodes++;
      if (salary + salaryFloor[index] > salaryCap || locksRemaining > slots.length-index ||
          (best && points+pointsCeiling[index] <= best.points) ||
          overlaps.some(overlap => overlap > maximumOverlap)) return;
      if (locksRemaining && locked.some(player => !ids.has(player.id) && !possible[index].has(player.id))) return;
      if (index === slots.length) {
        best = {picks:[...selected].sort((a,b)=>a.slot-b.slot),ids:new Set(ids),salary,points};
        return;
      }
      const slot = slots[index];
      for (let rank = 0; rank < slot.pool.length && nodes < searchLimit; rank++) {
        const player = slot.pool[rank];
        if (ids.has(player.id) || (teams.get(player.team) || 0) >= 4) continue;
        if (slot.label === "UTIL" && slots[index-1]?.label === "UTIL" && rank <= selected[index-1].rank) continue;
        if (locksRemaining === slots.length-index && !lockedIds.has(player.id)) continue;
        if (salary+player.salary+salaryFloor[index+1] > salaryCap) continue;
        if (best && points+player.points+pointsCeiling[index+1] <= best.points) break;
        selected.push({player,slot:slot.index,rank});
        ids.add(player.id);
        teams.set(player.team,(teams.get(player.team) || 0)+1);
        for (const [i,lineup] of lineups.entries()) if (lineup.ids.has(player.id)) overlaps[i]++;
        search(index+1,salary+player.salary,points+player.points,locksRemaining-Number(lockedIds.has(player.id)));
        for (const [i,lineup] of lineups.entries()) if (lineup.ids.has(player.id)) overlaps[i]--;
        teams.set(player.team,teams.get(player.team)-1);
        ids.delete(player.id);
        selected.pop();
      }
    }
    search(0,0,0,locked.length);
    if (nodes >= searchLimit) limited = true;
    if (!best) break;
    lineups.push(best);
  }
  return {lineups,limited};
}

export function reviewCSV(lineups) {
  const escape = value => {
    const text = String(value);
    return '"' + (/^[=+@\-\t\r]/.test(text) ? "'" : "") + text.replaceAll('"','""') + '"';
  };
  const rows = [["Lineup","Slot","Player ID","Player","Team","Salary","Projected FPTS","Projection source"]];
  for (const [index,lineup] of lineups.entries()) {
    for (const {slot,player} of lineup.picks) {
      rows.push([index+1,roster[slot][0],player.id,player.name,player.team,player.salary,player.points,player.source]);
    }
  }
  return rows.map(row => row.map(escape).join(",")).join("\r\n");
}
