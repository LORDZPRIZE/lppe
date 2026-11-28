import {percentilePlaces, placeShare} from "../fanduel-contest-metrics.js";
import {parseCSV, profiles} from "../fanduel-optimizer.js";

const round = value => Number(value.toFixed(6));
const rosterKey = ids => JSON.stringify([...ids].sort());

function lowerBound(scores,target,includeEqual) {
  let start = 0;
  let end = scores.length;
  while (start < end) {
    const middle = (start+end) >>> 1;
    if (scores[middle] < target || (includeEqual && scores[middle] === target)) start = middle+1;
    else end = middle;
  }
  return start;
}

export function createContestSimulator(scenarioCSV,fieldCSV,players) {
  const {roster,salaryCap,maxTeam} = profiles.NFL;
  const playerById = new Map(players.map(player => [player.id,player]));
  if (playerById.size !== players.length) throw new Error("Duplicate salary roster player ID.");
  const scenarios = new Map();
  for (const {scenario,id,fpts} of parseCSV(scenarioCSV)) {
    if (!scenario || !playerById.has(id) || !fpts?.trim() || !Number.isFinite(Number(fpts))) {
      throw new Error("Scenario CSV requires Scenario, ID from the salary slate, and numeric FPTS.");
    }
    if (!scenarios.has(scenario)) scenarios.set(scenario,new Map());
    const scores = scenarios.get(scenario);
    if (scores.has(id)) throw new Error("Duplicate scenario and player ID: "+scenario+" / "+id);
    scores.set(id,Number(fpts));
  }
  if (!scenarios.size) throw new Error("At least one slate scenario is required.");

  const duplicates = new Map();
  function validate(ids,label) {
    const picks = ids.map(id => playerById.get(id));
    if (ids.length !== roster.length || new Set(ids).size !== roster.length ||
        picks.some((player,slot) => !player?.positions.some(position => roster[slot][1].includes(position)))) {
      throw new Error("Invalid player IDs or roster slots in "+label+".");
    }
    const teams = new Map();
    for (const player of picks) teams.set(player.team,(teams.get(player.team) || 0)+1);
    if (picks.some(player => !player.team || !Number.isFinite(player.salary) || player.salary <= 0) ||
        teams.size < 3 || Math.max(...teams.values()) > maxTeam ||
        picks.reduce((sum,player) => sum+player.salary,0) > salaryCap) {
      throw new Error("Team or salary rules violated in "+label+".");
    }
  }
  const field = parseCSV(fieldCSV).map((row,index) => {
    const ids = ["qb","rb1","rb2","wr1","wr2","wr3","te","flex","def"].map(slot => row[slot]);
    validate(ids,"field lineup "+(index+1));
    const key = rosterKey(ids);
    duplicates.set(key,(duplicates.get(key) || 0)+1);
    return ids;
  });
  if (!field.length) throw new Error("At least one opponent lineup is required.");

  function score(ids,scores,scenario) {
    return round(ids.reduce((sum,id) => {
      if (!scores.has(id)) throw new Error("Missing score for player "+id+" in scenario "+scenario+".");
      return sum+scores.get(id);
    },0));
  }

  const prepared = [...scenarios].map(([scenario,scores]) => ({
    scenario,scores,fieldScores:field.map(ids => score(ids,scores,scenario)).sort((a,b) => a-b)
  }));
  const places = Math.max(1,percentilePlaces(field.length+1,1));
  const top3Places = percentilePlaces(field.length+1);
  const cache = new Map();
  return function evaluate(lineup) {
    const ids = [...lineup.picks].sort((a,b) => a.slot-b.slot).map(({player}) => player.id);
    validate(ids,"candidate lineup");
    const key = rosterKey(ids);
    if (cache.has(key)) return cache.get(key);
    let winShares = 0;
    let topShares = 0;
    let top3Shares = 0;
    let top3Hits = 0;
    for (const {scenario,scores,fieldScores} of prepared) {
      const points = score(ids,scores,scenario);
      const above = field.length-lowerBound(fieldScores,points,true);
      const tied = field.length-lowerBound(fieldScores,points,false)-above+1;
      winShares += above === 0 ? 1/tied : 0;
      topShares += placeShare(above,tied,places);
      top3Shares += placeShare(above,tied,top3Places);
      if (above < top3Places) top3Hits++;
    }
    const result = {
      scenarios:prepared.length,
      opponents:field.length,
      topOnePercentPlaces:places,
      top3Places,
      fieldDuplicates:duplicates.get(key) || 0,
      winShare:round(winShares/prepared.length),
      topOnePercentShare:round(topShares/prepared.length),
      top3Share:round(top3Shares/prepared.length),
      top3HitRate:round(top3Hits/prepared.length)
    };
    cache.set(key,result);
    return result;
  };
}
