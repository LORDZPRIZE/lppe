import {contestPlayerScores,csvRecords,buildLineups,matchName,profiles,teamCode,unavailable} from "./fanduel-optimizer.js";

function easternLockLabel(lockAt) {
  const date=new Date(lockAt);
  const format=options=>new Intl.DateTimeFormat("en-CA",{timeZone:"America/New_York",...options}).format(date);
  return format({year:"numeric",month:"2-digit",day:"2-digit"})+" "+format({hour:"2-digit",minute:"2-digit",second:"2-digit",hourCycle:"h23"})+" ET";
}

export function ownershipReview(rows,snapshot) {
  if (!Array.isArray(snapshot?.ownershipForecast) || !(Date.parse(snapshot.capturedAt)<Date.parse(snapshot.lockAt))) return null;
  const start=rows.find(row=>row.contestinfo==="Start Time")?.contestvalue;
  if (start && start!==easternLockLabel(snapshot.lockAt)) return null;
  const actual=new Map();
  for (const row of rows) {
    const id=row.player?.match(/\((\d+-\d+)\)$/)?.[1];
    const pct=row.drafted?.trim().match(/^(\d+(?:\.\d+)?)%$/);
    if (!id || !pct || Number(pct[1])>100) continue;
    const value=Number(pct[1]);
    if (!actual.has(id)) actual.set(id,value);
    else if (actual.get(id)!==value) actual.set(id,null);
  }
  const groups=new Map();
  const players=[];
  const forecasts=new Map();
  for (const p of snapshot.ownershipForecast) {
    if (!p?.id) continue;
    forecasts.set(p.id,forecasts.has(p.id) ? null : p);
  }
  for (const [id,p] of forecasts) {
    if (!p || !Number.isFinite(actual.get(id)) || !Number.isFinite(p.estimate) || p.estimate<0 || p.estimate>1) continue;
    const observed=actual.get(id), predicted=100*p.estimate;
    const delta=predicted-observed;
    const tier=!Number.isFinite(p.salary) ? "Salary unknown" : p.salary<5000?"Under $5k":p.salary<8000?"$5k–$7.9k":"$8k+";
    for (const name of new Set(["All matched players",tier,p.role || "Role unknown"])) {
      const group=groups.get(name)||{name,count:0,total:0,signed:0};
      group.count++;group.total+=Math.abs(delta);group.signed+=delta;groups.set(name,group);
    }
    players.push({name:p.name,predicted,observed,delta});
  }
  return players.length ? {forecastCount:forecasts.size,lockMatched:Boolean(start),
    groups:[...groups.values()].map(g=>({...g,mae:g.total/g.count,bias:g.signed/g.count})),
    players:players.sort((a,b)=>Math.abs(b.delta)-Math.abs(a.delta))} : null;
}

export function reviewPlayerCeilings(rows,snapshot) {
  if (!Array.isArray(snapshot?.ownershipForecast) || !(Date.parse(snapshot.capturedAt)<Date.parse(snapshot.lockAt))) return null;
  const actual=contestPlayerScores(rows);
  const groups=new Map();
  let missing=0;
  for (const p of snapshot.ownershipForecast) {
    if (!Number.isFinite(p.p90)) continue;
    if (!Number.isFinite(actual.get(p.id))) {missing++;continue;}
    const band=p.salary<5000?"Under $5k":p.salary<8000?"$5k–$7.9k":"$8k+";
    for (const label of ["All matched players",band,p.role || "Role unknown"]) {
      const group=groups.get(label) || {label,above:0,total:0};
      group.total++;
      if (actual.get(p.id)>p.p90) group.above++;
      groups.set(label,group);
    }
  }
  return groups.size ? {groups:[...groups.values()],missing} : null;
}

export function lateSwapLineup(pool,ids,games,reports,now,priorLocks=[]) {
  if (ids.length!==9 || new Set(ids).size!==9) throw new Error("Each entry needs nine distinct IDs in FanDuel slot order.");
  const starts=new Map();
  for (const game of games) {
    if (!Number.isFinite(game.start) || game.teams?.length!==2) continue;
    for (const team of game.teams) {
      const code=teamCode(team);
      starts.set(code,starts.has(code)?null:game);
    }
  }
  const players=new Map(pool.players.map(p=>[p.id,p]));
  const fixed=new Map();
  const closed=p=>{
    const g=starts.get(p.team);
    return !g || g.state!=="pre" || (g.status && !["STATUS_SCHEDULED","STATUS_PREGAME"].includes(g.status)) ||
      now>=Math.min(g.start,p.gameStart||Infinity) || priorLocks.includes(p.team);
  };
  for (const [slot,id] of ids.entries()) {
    const p=players.get(id);
    if (!p || !profiles.NBA.roster[slot][1].some(pos=>p.positions.includes(pos))) {
      throw new Error("Entry IDs or positions do not match the saved NBA slate.");
    }
    if (!starts.get(p.team)) throw new Error("A game time could not be verified for this entry.");
    if (closed(p)) fixed.set(slot,id);
  }
  const activeTeams=[...new Set(pool.players.filter(closed).map(p=>p.team))];
  const frozen=new Set(fixed.values());
  const news=new Map();
  for (const report of reports) {
    const time=Date.parse(report.updatedAt);
    if (!(time<=now && now-time<=72*3600000)) continue;
    const k=teamCode(report.team)+":"+matchName(report.player);
    if (!news.has(k)||news.get(k).time<time) news.set(k,{time,status:report.status,returnDate:report.returnDate});
  }
  const candidates=pool.players.map(p=>{
    const report=news.get(p.team+":"+matchName(p.name));
    const out=report?.status==="Out" && report.time>=(Date.parse(pool.updatedAt)||0) &&
      (!report.returnDate || String(report.returnDate).slice(0,10)>pool.date);
    if (frozen.has(p.id)) return {...p,selection:"lock",points:Number.isFinite(p.points)?p.points:0};
    return {...p,maxExposure:100,selection:closed(p)||out||unavailable(p.status)?"exclude":p.selection};
  });
  const result=buildLineups(candidates,1,1,160000,"NBA",{fixedSlots:fixed,exactFirst:true}).lineups[0];
  if (!result) throw new Error("No legal swap is available with these locked slots.");
  return {picks:result.picks.map(({slot,player})=>({slot,id:player.id,name:player.name,locked:fixed.has(slot),changed:ids[slot]!==player.id})),
    activeTeams,salary:result.salary,expiresAt:Math.min(...pool.players.filter(p=>!closed(p)).map(p=>Math.min(starts.get(p.team).start,p.gameStart||Infinity)))};
}

export function reconcileNBAEntries(planned,entered) {
  const rosterKey=ids=>JSON.stringify([...ids].sort());
  const remaining=new Map();
  for (const [i,ids] of planned.entries()) {
    const key=rosterKey(ids);
    const positions=remaining.get(key) || [];
    positions.push(i+1);
    remaining.set(key,positions);
  }
  const seen=new Set(),extra=[],repeated=[];
  for (const [i,ids] of entered.entries()) {
    const key=rosterKey(ids);
    if (seen.has(key)) repeated.push(i+1);
    seen.add(key);
    const copies=remaining.get(key);
    if (copies?.length) copies.shift();
    else extra.push(i+1);
  }
  const missing=[...remaining.values()].flat().sort((a,b)=>a-b);
  return {matched:entered.length-extra.length,missing,extra,repeated,distinct:seen.size};
}

export function enteredNBAIds(text) {
  const [header,...rows]=csvRecords(text);
  const labels=header?.map(h=>h.trim().toUpperCase())||[];
  const expected=profiles.NBA.roster.map(([slot])=>slot);
  const start=labels.findIndex((_,i)=>expected.every((slot,j)=>labels[i+j]===slot));
  if (start<0) throw new Error("Entry file must contain the nine supported NBA slots in FanDuel order.");
  return rows.filter(row=>row.slice(start,start+9).some(Boolean)).map(row=>{
    const ids=row.slice(start,start+9).map(cell=>cell.match(/(?:^|\()(\d+-\d+)(?=[:)\s]|$)/)?.[1]);
    if(ids.length!==9 || ids.some(id=>!id))throw new Error("An entry is missing a valid FanDuel player ID.");
    return ids;
  });
}

// Import only known snapshot versions. Keep imported builds separate from device history.
export function readNBAArchive(text) {
  const records=JSON.parse(text);
  if (!Array.isArray(records)) throw new Error("Choose a downloaded LPPE NBA build history JSON.");
  const versions=["first","latest","tournament","projection","initialTournament","initialBaseline","initialTop100","initialComparison"];
  const valid=[];
  for (const record of records) {
    const accepted={};
    for (const version of [...versions,...Object.keys(record || {}).filter(k=>/^news(Before|After)_\d+$/.test(k))]) {
      const build=record?.[version];
      if (!build || build.sport!=="NBA") continue;
      const legal=Array.isArray(build.lineups) && build.lineups.length>0 && build.lineups.every(lineup=>
        Array.isArray(lineup) && lineup.length===9 && lineup.every(p=>typeof p?.id==="string" &&
        /^\d+-\d+$/.test(p.id)) && new Set(lineup.map(p=>p.id)).size===9);
      if (!legal || !build.slate || !(Date.parse(build.capturedAt)<Date.parse(build.lockAt)) ||
          !Number.isInteger(build.requested) || build.requested<build.lineups.length) {
        throw new Error("This archive contains an invalid NBA lineup or pre-lock timestamp.");
      }
      accepted[version]=build;
    }
    if (Object.keys(accepted).length) valid.push(accepted);
  }
  if (!valid.length) throw new Error("No saved NBA builds found in this archive.");
  return valid;
}

export function pairHeldOut(rows,replay) {
  const info=Object.fromEntries(rows.filter(r=>r.contestinfo).map(r=>[r.contestinfo,r.contestvalue]));

  const entries=rows.filter(r=>r.entryid);
  if (new Set(entries.map(r=>r.entryid)).size!==entries.length) return null;
  const emptySeats=entries.filter(row=>row.points==="null");
  const scoredSeats=entries.length-emptySeats.length;
  // FanDuel lists unfilled rosters at a shared trailing rank with a literal null score.
  if (emptySeats.length && (!scoredSeats || emptySeats.some(row=>
    row.lineup!=="" || row.won!=="$0.00" || Number(row.rank)!==scoredSeats+1))) return null;
  if (entries.some(row=>row.points!=="null" && (!String(row.points??"").trim() ||
      !Number.isFinite(Number(row.points)) || (emptySeats.length &&
      !(Number(row.rank)>=1 && Number(row.rank)<=scoredSeats))))) return null;
  if (!entries.length || !info["Start Time"] || !info["Contest Name"] || !info.Slate ||
      Number(String(info["Seats Filled"]).replaceAll(",",""))!==entries.length) return null;

  // Live snapshots append the slate date to the provider label.
  const label=value=>String(value || "").trim().toLowerCase().replace(/\s*·\s*\d{4}-\d{2}-\d{2}$/, "")
    .replace(/^(?:fanduel\s+)?nba\s+/, "").replace(/\s+slate$/, "").trim();
  const complete=item=>item.total>0 && item.scored===item.total && item.requested===item.total && Number.isInteger(item.hits);
  const candidates=replay.filter(item=>(item.version==="initialTournament" || item.version==="initialTop100") &&
    complete(item) && Date.parse(item.capturedAt)<Date.parse(item.lockAt) &&
    easternLockLabel(item.lockAt)===info["Start Time"] && label(item.slate)===label(info.Slate))
    .sort((a,b)=>Date.parse(a.capturedAt)-Date.parse(b.capturedAt));
  for (const tournament of candidates) {
    const baselineVersion=tournament.version==="initialTournament" ? "initialBaseline" : "initialComparison";
    const projection=replay.find(item=>item.recordIndex===tournament.recordIndex && item.version===baselineVersion &&
      complete(item) && item.total===tournament.total && item.capturedAt===tournament.capturedAt &&
      item.lockAt===tournament.lockAt && item.slate===tournament.slate);
    if (!projection) continue;
    return {key:JSON.stringify([tournament.lockAt,tournament.slate]),contest:info["Contest Name"],tournament,projection};
  }
  return null;
}
