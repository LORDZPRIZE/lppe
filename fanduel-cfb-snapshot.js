import {profiles} from "./fanduel-optimizer.js";

const prefix="lppe-cfb-paired-v1/";
const cap=8;

export function makeCfbSnapshot(capture,payload,result,finishedAt) {
  const lineups=portfolio=>portfolio.map(lineup=>lineup.picks.map(({player})=>player.id));
  const snapshot={
    version:1,sport:"CFB",slateId:capture.slateId,slate:capture.slate,
    startedAt:new Date(capture.startedAt).toISOString(),finishedAt:new Date(finishedAt).toISOString(),
    lockAt:new Date(capture.lockAt).toISOString(),
    request:payload,excluded:capture.excluded,
    target:result.simulation.target,simulation:result.simulation,limited:Boolean(result.limited),
    tournament:lineups(result.lineups),baseline:lineups(result.baseline)
  };
  validateCfbSnapshot(snapshot);
  return snapshot;
}

function validateCfbSnapshot(snapshot) {
  if (!snapshot || snapshot.version!==1 || snapshot.sport!=="CFB" || !snapshot.slate || !snapshot.slateId ||
      !(Date.parse(snapshot.startedAt)<=Date.parse(snapshot.finishedAt) &&
        Date.parse(snapshot.finishedAt)<Date.parse(snapshot.lockAt))) throw new Error("Invalid pre-lock CFB snapshot.");
  const {request}=snapshot;
  if (request?.sport!=="CFB" || request.tournament!==true || !Array.isArray(request.players) ||
      !Number.isInteger(request.count) || request.count<1 || request.count>20 ||
      !["first","top1","top3","allTop10","firstAndTop10"].includes(snapshot.target) ||
      request.options?.target!==snapshot.target) throw new Error("Invalid CFB build request.");
  const players=new Map(request.players.map(player=>[player.id,player]));
  if (players.size!==request.players.length) throw new Error("Duplicate player IDs in CFB snapshot.");
  const {roster:slots,salaryCap,maxTeam}=profiles.CFB;
  const valid=roster=>{
    if (!Array.isArray(roster) || roster.length!==slots.length || new Set(roster).size!==slots.length) return false;
    const teams=new Map();
    const games=new Set();
    let salary=0;
    for (const [slot,id] of roster.entries()) {
      const player=players.get(id);
      if (!player?.positions?.some(position=>slots[slot][1].includes(position)) ||
          !Number.isFinite(player.points) || !Number.isInteger(player.salary) || player.salary<=0 ||
          !player.team || !player.game) return false;
      teams.set(player.team,(teams.get(player.team) ?? 0)+1);
      games.add(player.game);
      salary+=player.salary;
    }
    return salary<=salaryCap && teams.size>=3 && Math.max(...teams.values())<=maxTeam && games.size>=2;
  };
  for (const portfolio of [snapshot.tournament,snapshot.baseline]) {
    if (!Array.isArray(portfolio) || portfolio.length!==request.count || portfolio.some(roster=>!valid(roster))) throw new Error("Invalid CFB snapshot lineups.");
  }
}

export function selectCfbSnapshot(snapshots,{lockAt,count,slateLabel,target}) {
  if (!Array.isArray(snapshots)) throw new Error("Choose an LPPE CFB pre-lock snapshot JSON.");
  const label=value=>String(value).trim().replace(/\s*·.*$/,"").toLowerCase();
  const matches=snapshots.filter(item=>item && Date.parse(item.lockAt)===lockAt &&
    item.request?.count===count && label(item.slate)===label(slateLabel) && item.target===target);
  for (const item of matches) validateCfbSnapshot(item);
  if (!matches.length) throw new Error("No paired CFB snapshot matches this slate, lock, target and lineup count.");
  return matches.sort((a,b)=>Date.parse(a.startedAt)-Date.parse(b.startedAt))[0];
}

export function readStoredCfbSnapshots(storage) {
  const results=[];
  for (const key of Object.keys(storage).filter(key=>key.startsWith(prefix))) {
    try {
      const item=JSON.parse(storage.getItem(key));
      validateCfbSnapshot(item);
      results.push(item);
    } catch {}
  }
  return results.sort((a,b)=>Date.parse(a.startedAt)-Date.parse(b.startedAt));
}

export function saveCfbSnapshot(storage,snapshot) {
  validateCfbSnapshot(snapshot);
  const keyFor=item=>prefix+JSON.stringify([item.slateId,item.lockAt,item.target,item.request.count]);
  const key=keyFor(snapshot);
  if (storage.getItem(key)!==null) return;
  const older=readStoredCfbSnapshots(storage);
  for (const item of older.slice(0,Math.max(0,older.length-cap+1))) storage.removeItem(keyFor(item));
  storage.setItem(key,JSON.stringify(snapshot));
}
