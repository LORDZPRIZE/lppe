// Provider-neutral ingestion. Only configure authorized HTTPS feeds.
// Feed contract: {sport, complete, reports:[{playerId,status,updatedAt,source}]}
// Results contract: {sport, contests:[{id,final,entries:[{username,rank,score}]}]}
export const SPORTS = ["NBA","NFL","MLB","NHL","WNBA","NCAAB","NCAAF","SOCCER","PGA"];
const statuses = new Set(["out","inactive","withdrawn","suspended","questionable","doubtful","probable","available"]);
export function normalizeInjuries(data,sport,now=Date.now()) {
  if(data?.sport!==sport || !Array.isArray(data.reports)) throw Error("Invalid injury feed");
  const reports=data.reports.filter(r=>typeof r.playerId==="string" && statuses.has(r.status) && typeof r.source==="string" && Number.isFinite(Date.parse(r.updatedAt)) && Date.parse(r.updatedAt)<=now).map(r=>({playerId:r.playerId,status:r.status,source:r.source,updatedAt:r.updatedAt,stale:now-Date.parse(r.updatedAt)>3600000}));
  return {sport,complete:data.complete===true && reports.length===data.reports.length && !reports.some(r=>r.stale),reports,capturedAt:new Date(now).toISOString()};
}
export function availability(board,playerId,now=Date.now()) {
  const rows=(board?.reports||[]).filter(r=>r.playerId===playerId);
  if(rows.some(r=>["out","inactive","withdrawn","suspended"].includes(r.status))) return "blocked";
  if(!board?.complete || now-Date.parse(board.capturedAt)>3600000 || !rows.length || rows.some(r=>now-Date.parse(r.updatedAt)>3600000)) return "unknown";
  return rows.every(r=>r.status==="available")?"available":"review";
}
async function feed(url,token,sport) {
  const u=new URL(url); if(u.protocol!=="https:") throw Error("HTTPS required");
  u.searchParams.set("sport",sport);
  const response=await fetch(u,{headers:{Accept:"application/json",...(token?{Authorization:"Bearer "+token}:{})},redirect:"error",signal:AbortSignal.timeout(10000)});
  if(!response.ok) throw Error("Provider HTTP "+response.status);
  return response.json();
}
export async function refreshDFS(env,sports=SPORTS) {
  if(!env.DFS_ARCHIVE) return {status:"missing_storage"};
  const outcomes=[];
  for(const sport of sports) {
    for(const kind of ["injuries","results"]) {
      const url=kind==="injuries"?env.DFS_INJURY_URL:env.DFS_RESULTS_URL;
      const key="dfs/status/"+kind+"/"+sport;
      let status="not_configured";
      try {
        if(url) {
          const data=await feed(url,env.DFS_PROVIDER_TOKEN,sport);
          if(kind==="injuries") {
            const board=normalizeInjuries(data,sport);
            await env.DFS_ARCHIVE.put("dfs/injuries/"+sport,JSON.stringify(board));
            status=board.complete?"saved":"partial";
          } else {
            if(data?.sport!==sport || !Array.isArray(data.contests)) throw Error("Invalid results feed");
            let count=0;
            for(const c of data.contests) {
              if(c.final!==true || typeof c.id!=="string" || !Array.isArray(c.entries) || !c.entries.length || !c.entries.every(e=>typeof e.username==="string" && Number.isInteger(e.rank) && e.rank>0 && Number.isFinite(e.score))) continue;
              const sorted=[...c.entries].sort((a,b)=>a.rank-b.rank);
              const summary={sport,id:c.id,capturedAt:new Date().toISOString(),entryCount:sorted.length,first:sorted[0],top20:sorted.filter(e=>e.rank<=20),mine:sorted.filter(e=>e.username==="Stayonthesidelinez"),complete:c.complete===true};
              await env.DFS_ARCHIVE.put("dfs/results/"+sport+"/"+encodeURIComponent(c.id),JSON.stringify(summary));
              count++;
            }
            status=count?"saved":"no_valid_final_results";
          }
        }
      } catch {status="failed";}
      const outcome={sport,kind,status,checkedAt:new Date().toISOString()};
      await env.DFS_ARCHIVE.put(key,JSON.stringify(outcome)); outcomes.push(outcome);
    }
  }
  return {outcomes};
}
