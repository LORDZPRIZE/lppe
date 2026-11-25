import {buildLineups,profiles,unavailable,matchName,teamCode} from "./fanduel-optimizer.js";
import {selectTournamentPortfolio} from "./fanduel-nfl-tournament.js";

const profile = profiles.NBA;
const key = ids => [...ids].sort().join("|");
const identity = (name,team) => teamCode(team)+":"+matchName(name);
const bounded = (x,low,high) => Math.max(low,Math.min(high,x));

export function addRotations(players,history,now) {
  const byName = new Map();
  for (const row of history) {
    const id = identity(row.player,row.team);
    byName.set(id,byName.has(id) ? null : row);
  }
  return players.map(player => {
    const games = byName.get(identity(player.name,player.team))?.games?.filter(game =>
      Date.parse(game.date)<now && now-Date.parse(game.date)<14*86400000 && Number.isFinite(game.minutes) && game.minutes>0).slice(0,6);
    if (!games || games.length<3) return player;
    return {...player,rotation:games.map(({minutes,starter}) => ({minutes,starter}))};
  });
}

function generator(seed) {
  return () => ((seed=(Math.imul(1664525,seed)+1013904223)>>>0)+0.5)/4294967296;
}
function normal(random) {
  return Math.sqrt(-2*Math.log(random()))*Math.cos(2*Math.PI*random());
}

export function nbaRoleProjections(players) {
  const absent = players.filter(p => unavailable(p.status) && p.rotation?.[0].starter);
  return players.map(p => {
    if (!p.rotation?.length) return p;
    const games = p.rotation;
    const avg = games.reduce((n,g)=>n+g.minutes,0)/games.length;
    const recent = games.slice(0,3).reduce((n,g)=>n+g.minutes,0)/3;
    const starter = p.confirmedStarter ?? games[0].starter;
    const role = games.filter(g=>typeof starter==="boolean" && g.starter===starter);
    const roleMean = role.length>=2 ? role.reduce((n,g)=>n+g.minutes,0)/role.length : recent;
    const opening = absent.some(a=>a.team===p.team && a.positions.some(pos=>p.positions.includes(pos)));
    const minutes = bounded(.55*recent+.45*roleMean+(opening ? 1.5 : 0),1,44);
    const spread = Math.sqrt(games.reduce((n,g)=>n+(g.minutes-avg)**2,0)/games.length);
    // A current external projection can already reflect a rotation change.
    const points = p.source==="FanDuel FPPG" ? p.points*bounded(minutes/avg,.8,1.2) : p.points;
    return {...p,points,minutes,starter,minuteSpread:bounded(spread,2,12)};
  });
}

// Balance only rotations with enough observed playing time to represent a team.
export function teamRotations(players) {
  const groups=new Map();
  players.forEach((p,i)=>{
    if (!p.team || unavailable(p.status)) return;
    const indices=groups.get(p.team) || [];
    indices.push(i);
    groups.set(p.team,indices);
  });
  return [...groups.values()].filter(indices=>{
    if (indices.length<8 || !indices.every(i=>Number.isFinite(players[i].minutes) && players[i].minutes>0)) return false;
    const minutes=indices.reduce((sum,i)=>sum+players[i].minutes,0);
    return minutes>=200 && minutes<=280;
  });
}

export function balanceMinutes(indices,played,weights,overtime) {
  const cap=overtime ? 53 : 48;
  let remaining=5*cap;
  let open=indices;
  // Weighted redistribution preserves role differences when teammates lose minutes.
  while (open.length) {
    const delta=remaining-open.reduce((sum,i)=>sum+played[i],0);
    const totalWeight=open.reduce((sum,i)=>sum+weights[i],0);
    const next=[];
    for (const i of open) {
      const adjusted=played[i]+delta*weights[i]/totalWeight;
      played[i]=bounded(adjusted,0,cap);
      if (played[i]===adjusted) next.push(i);
      else remaining-=played[i];
    }
    if (next.length===open.length) break;
    open=next;
  }
}

function sampleScores(players,scenarioRandom,outcomes,rotations) {
  const games=new Map();
  const played=new Float64Array(players.length);
  const multiplier=new Float64Array(players.length);
  const weights=new Float64Array(players.length);
  players.forEach((p,i)=>{
    const id=p.game||p.team;
    if(!games.has(id)) games.set(id,{pace:normal(scenarioRandom),script:scenarioRandom()});
    const {pace,script}=games.get(id);
    const starter=p.confirmedStarter ?? p.starter ?? (p.minutes>=28 || (!p.minutes && p.points>=28));
    const minutes=p.minutes || (starter?32:20);
    const shift=script<.06 ? (starter?4:1) : script>.84 ? (starter?-5:3) : 0;
    played[i]=bounded(minutes+shift+(p.minuteSpread||5)*normal(scenarioRandom),0,script<.06?53:48);
    weights[i]=minutes;
    const rate=.24*normal(scenarioRandom)+.09*pace;
    multiplier[i]=unavailable(p.status) ? 0 : Math.max(0,p.points||0)/minutes*Math.exp(rate-.033);
  });
  for (const indices of rotations) {
    const p=players[indices[0]];
    balanceMinutes(indices,played,weights,games.get(p.game||p.team).script<.06);
  }
  for (let i=0;i<players.length;i++) outcomes[i]=Math.round(played[i]*multiplier[i]*10);
}

function opponentField(players,size,random,adjustments) {
  const eligible = players.map((p,i)=>({p,i})).filter(({p})=>p.points>0 && !unavailable(p.status));
  const slots = profile.roster.map(([,positions])=>{
    let sum=0;
    const options=eligible.filter(({p})=>p.positions.some(pos=>positions.includes(pos))).map(({p,i})=>{
      const weight = Number.isFinite(p.ownership) ? bounded(p.ownership,.002,.98) :
        bounded((p.points/32)**2*(p.points/Math.max(1,p.salary/1000)/5)**2,.01,8);
      sum+=weight*(adjustments?.[i] ?? 1);
      return {i,end:sum};
    });
    return {options,sum};
  }).sort((a,b)=>a.options.length-b.options.length);
  const field=[];
  for (let attempt=0;attempt<size*60 && field.length<size;attempt++) {
    const picks=[],teams=new Map();
    let salary=0;
    for (const {options,sum} of slots) {
      if (!options.length) break;
      let added=false;
      for (let retry=0;retry<12;retry++) {
        const target=random()*sum;
        const i=options.find(o=>o.end>=target).i;
        const p=players[i];
        if (picks.includes(i) || (teams.get(p.team)||0)>=4 || salary+p.salary>60000) continue;
        picks.push(i);salary+=p.salary;teams.set(p.team,(teams.get(p.team)||0)+1);added=true;break;
      }
      if (!added) break;
    }
    if (picks.length===9 && teams.size>=3) field.push(picks);
  }
  return field;
}

function ownershipFit(players) {
  const targets=players.map(p=>p.points>0 && !unavailable(p.status) && Number.isFinite(p.ownership) ? p.ownership : null);
  if (!targets.some(t=>t!==null)) return null;
  const factors=new Float64Array(players.length).fill(1);
  let bestError=Infinity;
  let best;
  // Iterate on small legal fields. Salary and roster constraints alter marginal selection rates.
  for (let pass=0;pass<5;pass++) {
    const field=opponentField(players,512,generator(33921),factors);
    if (field.length<512) break;
    const observed=new Uint32Array(players.length);
    for (const roster of field) for (const id of roster) observed[id]++;
    let error=0;
    for (const [i,target] of targets.entries()) {
      if (target!==null) error+=Math.abs(target-observed[i]/field.length);
    }
    if (error<bestError) {bestError=error;best=factors.slice();}
    for (const [i,target] of targets.entries()) {
      if (target===null) continue;
      const ratio=(target+.005)/(observed[i]/field.length+.005);
      factors[i]=bounded(factors[i]*bounded(Math.sqrt(ratio),.5,2),.05,20);
    }
  }
  return best;
}

function comparePortfolios(players,index,field,portfolios,rotations) {
  const random=generator(83713);
  const outcomes=new Int32Array(players.length);
  const mapped=portfolios.map(portfolio=>portfolio.map(lineup=>[...lineup.ids].map(id=>index.get(id))));
  const hits=[0,0], firsts=[0,0], scenarios=512;
  const score=indices=>indices.reduce((sum,i)=>sum+outcomes[i],0);
  for(let n=0;n<scenarios;n++) {
    sampleScores(players,random,outcomes,rotations);
    const best=mapped.map(rosters=>Math.max(...rosters.map(score)));
    const above=[0,0];
    for(const roster of field) {
      const value=score(roster);
      if (value>best[0]) above[0]++;
      if (value>best[1]) above[1]++;
      if (above[0]>=20 && above[1]>=20) break;
    }
    for (const [i,higherScores] of above.entries()) {
      if (higherScores===0) firsts[i]++;
      if (higherScores<20) hits[i]++;
    }
  }
  return {scenarios,tournamentHits:hits[0],projectionHits:hits[1],
    tournamentFirsts:firsts[0],projectionFirsts:firsts[1]};
}

export function buildNBATournament(raw,count,difference,limit,options={}) {
  const entries=Number(options.fieldSize ?? 1000);
  if (!Number.isInteger(entries)||entries<=count||entries>50000) throw new Error("Choose a field larger than your portfolio, up to 50,000 entries.");
  const players=nbaRoleProjections(raw).sort((a,b)=>a.id.localeCompare(b.id));
  const rotations=teamRotations(players);
  const baseline=buildLineups(raw,count,difference,limit,"NBA",{...options,exactFirst:true});
  if (!baseline.lineups.length) return baseline;
  const index=new Map(players.map((p,i)=>[p.id,i]));
  const candidates=new Map();
  const add=lineup=>{
    const picks=lineup.picks.map(pick=>({...pick,player:players[index.get(pick.player.id)]}));
    candidates.set(key(lineup.ids),{...lineup,picks,points:picks.reduce((s,p)=>s+p.player.points,0)});
  };
  baseline.lineups.forEach(add);
  const adjusted = players.some(p=>p.rotation?.length && p.source==="FanDuel FPPG");
  const projected = adjusted ? buildLineups(players,count,difference,limit,"NBA",{...options,exactFirst:true}) : baseline;
  projected.lineups.forEach(add);
  const random=generator(77419);
  for(let batch=0;batch<8;batch++) {
    const pool=players.map(p=>({...p,points:Number.isFinite(p.points) ? p.points*Math.exp(.22*normal(random)) : NaN,maxExposure:100}));
    buildLineups(pool,Math.min(6,count+1),1,Math.min(limit,40000),"NBA").lineups.forEach(add);
  }
  const sampled=new Int32Array(players.length);
  const gameRandom=generator(43817);
  for(let batch=0;batch<4;batch++) {
    sampleScores(players,gameRandom,sampled,rotations);
    const pool=players.map((p,i)=>({...p,maxExposure:100,
      points:Number.isFinite(p.points) ? .55*p.points+.45*sampled[i]/10 : NaN}));
    buildLineups(pool,Math.min(5,count+1),1,Math.min(limit,40000),"NBA").lineups.forEach(add);
  }
  let factors=ownershipFit(players);
  const size=entries-count;
  let field=opponentField(players,size,generator(67211),factors);
  if (field.length<size && factors) {
    factors=null;
    field=opponentField(players,size,generator(67211));
  }
  if (field.length<size) throw new Error("Insufficient eligible players to model the requested NBA field.");
  const top20Target = options.target !== "first";
  const counts = new Uint32Array(players.length);
  const freq=new Map();
  for(const lineup of field) {
    for (const i of lineup) counts[i]++;
    const k=key(lineup.map(i=>players[i].id));
    freq.set(k,(freq.get(k)||0)+1);
  }
  const scenarios=512;
  const shares=new Map();
  const items=[...candidates.values()].map(lineup=>{
    const first=new Float64Array(scenarios);
    shares.set(lineup.ids,first);
    return {lineup,indices:[...lineup.ids].map(id=>index.get(id)),first,hits:new Uint8Array(scenarios),scores:[],wins:0,top:0,top20:0};
  });
  const outcomes=new Int32Array(players.length), opponents=new Int32Array(field.length);
  const scenarioRandom=generator(78602);
  const score=ids=>outcomes[ids[0]]+outcomes[ids[1]]+outcomes[ids[2]]+outcomes[ids[3]]+outcomes[ids[4]]+outcomes[ids[5]]+outcomes[ids[6]]+outcomes[ids[7]]+outcomes[ids[8]];
  for(let n=0;n<scenarios;n++) {
    sampleScores(players,scenarioRandom,outcomes,rotations);
    for(let i=0;i<field.length;i++) opponents[i]=score(field[i]);
    opponents.sort();
    const max=opponents.at(-1);
    let tied=1;
    for(let i=opponents.length-2;i>=0 && opponents[i]===max;i--) tied++;
    const top=opponents[Math.max(0,field.length-Math.max(1,Math.floor(entries*.1)))];
    const cutoff20=field.length<20 ? -Infinity : opponents[field.length-20];
    for(const item of items) {
      const value=score(item.indices);
      item.scores.push(value/10);
      if(value>=top)item.top++;
      const share=value>max?1:value===max?1/(1+tied):0;
      const hit=Number(value>=cutoff20);
      item.hits[n]=hit; item.top20+=hit; item.first[n]=top20Target ? hit : share; item.wins+=share;
    }
  }
  const ranked=items.map(({lineup,scores,wins,top,top20})=>({...lineup,tournament:{
    win:wins/scenarios,top20:top20/scenarios,top:top/scenarios,duplicates:freq.get(key(lineup.ids))||0,
    ceiling:scores.sort((a,b)=>a-b)[Math.ceil(.9*scenarios)-1]
  }})).sort((a,b)=>b.tournament.win-a.tournament.win||b.tournament.top-a.tournament.top||b.points-a.points);
  const limits=new Map(players.map(p=>[p.id,p.selection==="lock"?count:Math.floor(count*Math.min(options.exposure??100,p.maxExposure??100)/100)]));
  const pool={scenarios,opponents:field.length,fieldPlayers:players.filter(p=>p.points>0&&!unavailable(p.status)).length,
    ownershipPlayers:players.filter(p=>p.points>0&&!unavailable(p.status)&&Number.isFinite(p.ownership)).length,
    firstPlaceShares:shares,lineups:ranked};
  let result=selectTournamentPortfolio(pool,limits,count,difference,baseline.limited);
  if(result.lineups.length<baseline.lineups.length) {
    const keys=new Set(baseline.lineups.map(l=>key(l.ids)));
    result=selectTournamentPortfolio({...pool,lineups:ranked.filter(l=>keys.has(key(l.ids)))},limits,count,difference,baseline.limited);
  }
  const ownershipForecast=players.map((p,i)=>({id:p.id,name:p.name,salary:p.salary,
    role:p.confirmedStarter===true ? "Confirmed starter" : p.confirmedStarter===false ? "Confirmed bench" :
      p.starter===true ? "Recent starter" : p.starter===false ? "Recent bench" : "Role unknown",
    estimate:counts[i]/field.length,input:Number.isFinite(p.ownership)?p.ownership:null}));
  const covered = new Uint8Array(scenarios);
  for (const lineup of result.lineups) {
    const item=items.find(candidate=>candidate.lineup.ids===lineup.ids);
    item.hits.forEach((hit,i)=>{ if(hit)covered[i]=1; });
  }
  result.simulation.balancedTeams=rotations.length;
  result.simulation.target=top20Target ? "top20" : "first";
  result.simulation.coverage=covered.reduce((sum,v)=>sum+v,0)/scenarios;
  if (result.lineups.length && result.lineups.length===baseline.lineups.length) {
    const testField=opponentField(players,entries-result.lineups.length,generator(92481),factors);
    if (testField.length===entries-result.lineups.length) {
      const original=options.originalIds;
      if (Array.isArray(original) && original.length===result.lineups.length &&
          original.every(ids=>Array.isArray(ids) && ids.length===9 && new Set(ids).size===9 && ids.every(id=>index.has(id)))) {
        result.simulation.newsComparison=comparePortfolios(players,index,testField,
          [result.lineups,original.map(ids=>({ids}))],rotations);
      }
      result.simulation.comparison=comparePortfolios(players,index,testField,[result.lineups,baseline.lineups],rotations);
    }
  }
  return {...result,ownershipForecast,highestProjected:candidates.get(key(projected.lineups[0].ids)),baseline:baseline.lineups};
}
