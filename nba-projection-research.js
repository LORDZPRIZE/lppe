const day = 86400000;
const clamp = (value,min,max) => Math.max(min,Math.min(max,value));
const mean = values => values.reduce((sum,value) => sum+value,0)/values.length;

export function pregameObservations(games,asOf,{windowDays=14,limit=8,minMinutes=1} = {}) {
  const byStart = new Map();
  for (const game of games ?? []) {
    const start = Date.parse(game?.date);
    if (!(start < asOf && asOf-start <= windowDays*day) || !Number.isFinite(game.minutes) ||
        game.minutes < minMinutes || game.minutes > 68) continue;
    const prior=byStart.get(start);
    if (prior === null) continue;
    if (prior && (prior.minutes!==game.minutes || prior.starter!==game.starter ||
        JSON.stringify(prior.values)!==JSON.stringify(game.values))) {
      byStart.set(start,null);
      continue;
    }
    byStart.set(start,game);
  }
  return [...byStart].sort(([a],[b])=>b-a).map(([,game])=>game).filter(Boolean).slice(0,limit);
}

// Challenger only. Fix these weights before measuring on unseen slates.
export function minutesAdjustedMarket(games,stat,{starter,marketFloor=1} = {}) {
  const eligible = games.filter(game => game.minutes >= 8 && Number.isFinite(stat(game.values)) && stat(game.values)>=0);
  if (eligible.length < 4) return null;
  const comparable = eligible.filter(game => typeof starter === "boolean" && game.starter===starter);
  const role = comparable.length>=3 ? comparable : eligible;
  const recent = role.slice(0,3).map(game=>game.minutes);
  const typical = role.map(game=>game.minutes).sort((a,b)=>a-b);
  const median = (typical[(typical.length-1)>>1]+typical[typical.length>>1])/2;
  const minutes = clamp(.65*mean(recent)+.35*median,8,48);
  const pooledRate = eligible.reduce((sum,game)=>sum+stat(game.values),0)/
    eligible.reduce((sum,game)=>sum+game.minutes,0);
  let weightedRate=0, weightSum=0;
  const adjusted = role.map(game=>stat(game.values)*clamp(minutes/game.minutes,.65,1.5));
  for (const [index,game] of role.entries()) {
    const weight=.82**index*Math.min(1,game.minutes/24);
    weightedRate+=weight*stat(game.values)/game.minutes;
    weightSum+=weight;
  }
  const projection=minutes*(.65*weightedRate/weightSum+.35*pooledRate);
  const variance=mean(adjusted.map(value=>(value-projection)**2));
  return {projection,minutes,spread:Math.max(marketFloor,Math.sqrt(variance)),games:eligible.length,roleGames:role.length};
}

const normalCDF = x => {
  const magnitude=Math.abs(x);
  const t=1/(1+.2316419*magnitude);
  const tail=Math.exp(-magnitude*magnitude/2)/Math.sqrt(2*Math.PI)*t*
    (.319381530+t*(-.356563782+t*(1.781477937+t*(-1.821255978+t*1.330274429))));
  return x<0 ? tail : 1-tail;
};

export function discreteMarketProbabilities(model,line) {
  if (!model || !Number.isFinite(line) || line < 0 ||
      !Number.isFinite(model.projection) || !(model.spread>0)) return null;
  const below = threshold => threshold < 0 ? 0 : clamp(normalCDF((threshold+.5-model.projection)/model.spread),0,1);
  const less = below(Math.ceil(line)-1);
  const more = 1-below(Math.floor(line));
  const push = clamp(1-less-more,0,1);
  return {more,less,push};
}
