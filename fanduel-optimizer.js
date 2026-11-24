export const roster = [
  ["PG", ["PG"]], ["SG", ["SG"]], ["SF", ["SF"]], ["PF", ["PF"]], ["C", ["C"]],
  ["G/F", ["PG", "SG", "SF", "PF"]], ["F/C", ["SF", "PF", "C"]],
  ["UTIL", ["PG", "SG", "SF", "PF", "C"]], ["UTIL", ["PG", "SG", "SF", "PF", "C"]]
];
export const salaryCap = 60000;

const slot = (label,...positions) => [label,positions.length ? positions : [label]];
export const profiles = {
  NBA:{name:"NBA",roster,salaryCap,maxTeam:4},
  NFL:{name:"NFL",salaryCap:60000,maxTeam:4,roster:[
    slot("QB"),slot("RB"),slot("RB"),slot("WR"),slot("WR"),slot("WR"),slot("TE"),
    slot("FLEX","RB","WR","TE"),slot("DEF")
  ]},
  MLB:{name:"MLB",salaryCap:35000,maxTeam:5,maxHitters:4,roster:[
    slot("P"),slot("C/1B","C","1B"),slot("2B"),slot("3B"),slot("SS"),slot("OF"),slot("OF"),slot("OF"),
    slot("UTIL","C","1B","2B","3B","SS","OF","DH")
  ]},
  CFB:{name:"College Football",salaryCap:60000,maxTeam:4,roster:[
    slot("QB"),slot("RB"),slot("RB"),slot("WR","WR","TE"),slot("WR","WR","TE"),slot("WR","WR","TE"),
    slot("SFLEX","QB","RB","WR","TE")
  ]}
};

function rosterProfile(sport) {
  if (!Object.hasOwn(profiles,sport)) throw new Error("Choose a supported FanDuel Classic sport.");
  return profiles[sport];
}

function positionCodes(raw, sport, allowed) {
  const aliases = sport === "NFL" ? {DST:"DEF",D:"DEF",DEFENSE:"DEF"} :
    sport === "MLB" ? {SP:"P",RP:"P",LF:"OF",CF:"OF",RF:"OF"} : {};
  return [...new Set(raw.toUpperCase().replace(/D\/ST/g,"DST").split(/[\s/,;|-]+/)
    .map(position => aliases[position] || position).filter(position => allowed.has(position)))];
}

export function csvRecords(source) {
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
  return records;
}

export function parseCSV(source) {
  const records=csvRecords(source);
  const headings = records.shift()?.map(name => name.toLowerCase().replace(/[^a-z0-9]/g, "")) || [];
  if (!headings.length) throw new Error("The CSV is empty.");
  return records.map(row => Object.fromEntries(headings.map((name, i) => [name, row[i] || ""])));
}

export function reviewContest(source, username) {
  const rows = typeof source === "string" ? parseCSV(source) : source;
  if (!["entryid","entryname","rank","points"].every(key => key in (rows[0] || {}))) {
    throw new Error("Choose a FanDuel contest leaderboard CSV.");
  }
  let entries = 0;
  let userEntries = 0;
  let cutoff = Infinity;
  let best = -Infinity;
  let top100Entries = 0;
  const handle = username.trim().toLowerCase();
  for (const row of rows) {
    if (!row.entryid) continue;
    entries++;
    const rank = Number(row.rank);
    if (!Number.isInteger(rank) || rank < 1) throw new Error("An entry has no valid finishing rank.");
    const score = row.points ? Number(row.points) : NaN;
    if (rank <= 100) {
      if (!Number.isFinite(score)) throw new Error("A top-100 entry is missing its score.");
      cutoff = Math.min(cutoff,score);
    }
    if (row.entryname.replace(/\s*\(\d+\/\d+\)$/, "").trim().toLowerCase() === handle) {
      userEntries++;
      if (Number.isFinite(score)) best = Math.max(best,score);
      if (rank <= 100) top100Entries++;
    }
  }
  if (!userEntries) throw new Error("That username was not found in this leaderboard.");
  if (!Number.isFinite(best)) throw new Error("No scored entries found for that username.");
  return {entries,userEntries,best,cutoff:entries >= 100 && Number.isFinite(cutoff) ? cutoff : null,top100Entries};
}

const csvNumber = value => value?.trim() ? Number(value.replace(/[$,]/g, "")) : NaN;
const playerName = row => row.nickname || row.playername || row.player || row.name ||
  [row.firstname,row.lastname].filter(Boolean).join(" ");
export const teamCode = (raw,sport = "NBA") => {
  const team = raw?.trim().toUpperCase() || "";
  if (sport === "NBA") return {BRK:"BKN",GS:"GSW",NO:"NOP",NY:"NYK",PHO:"PHX",SA:"SAS",UTAH:"UTA",WSH:"WAS"}[team] || team;
  if (sport === "NFL") return {JAX:"JAC",WSH:"WAS"}[team] || team;
  return team;
};
export const matchName = name => name.normalize("NFD").replace(/\p{Mark}/gu, "").toLowerCase().replace(/[^a-z0-9]/g, "");
const nameVariant = name => matchName(name.replace(/[\s,]+(?:jr\.?|sr\.?|ii|iii|iv|v)$/i,""));
function recordNameVariant(groups,name,team) {
  if (!name || !team) return;
  const key = nameVariant(name) + ":" + team;
  if (!groups.has(key)) groups.set(key,new Set());
  groups.get(key).add(matchName(name) + ":" + team);
}
export const unavailable = status => /^(O|OUT|IR|INACTIVE|SUSPENDED|SUSP|DOUBTFUL|D|INJURED RESERVE|NOT WITH TEAM|G LEAGUE|G-LEAGUE)$/i.test(status || "");

const isCheatsheet = rows => rows.length > 0 &&
  ["ppgprojection","slate","gamedate","opp"].every(key => key in rows[0]);
const cheatsheetKey = row => JSON.stringify([row.slate,row.gamedate]);

export function inspectSalaryCSV(source) {
  const rows = parseCSV(source);
  const preview = isCheatsheet(rows);
  const slates = new Map();
  if (preview) {
    for (const row of rows) {
      const key = cheatsheetKey(row);
      const slate = slates.get(key) ?? {key,name:row.slate,date:row.gamedate,entries:0};
      slate.entries++;
      slates.set(key,slate);
    }
  }
  return {rows,preview,slates:[...slates.values()]};
}

const readOwnership = row => {
  const raw = row.ownershippct || row.projectedownership || row.ownershipprojection || row.ownership || "";
  const percent = csvNumber(raw.trim().replace(/%$/, ""));
  return percent >= 0 && percent <= 100 ? percent/100 : undefined;
};
const readCeiling = row => csvNumber(row.ceiling || row.ceilingfpts || row.projectedceiling);

export function applyPlayerProjections(players,projectionCSV,sport = "NBA",{selectedSlate,date} = {}) {
  if (!projectionCSV.trim()) return {players,matched:0};
  const gameDates = new Set([date,...players.map(player => player.gameDate)].filter(Boolean));
  const byId = new Map();
  const byName = new Map();
  const ceilingById = new Map();
  const ceilingByName = new Map();
  const ownershipById = new Map();
  const ownershipByName = new Map();
  const projectionVariants = new Map();
  const salaryVariants = new Map();
  function addProjection(map, key, points) {
    if (!key) return;
    if (map.has(key) && map.get(key) !== points) map.set(key, null);
    else map.set(key, points);
  }
  for (const row of parseCSV(projectionCSV)) {
    if (selectedSlate && row.slate && row.gamedate && cheatsheetKey(row) !== selectedSlate) continue;
    if (date && row.gamedate && !gameDates.has(row.gamedate)) continue;
    const projected = csvNumber(row.projection || row.projectedpoints || row.ppgprojection || row.fantasypoints || row.fpts || row.fppg);
    if (!Number.isFinite(projected)) continue;
    const displayName = playerName(row);
    const name = matchName(displayName);
    const team = teamCode(row.team || row.teamabbr,sport);
    recordNameVariant(projectionVariants,displayName,team);
    addProjection(byId,row.id || row.playerid,projected);
    if (name && team) addProjection(byName,name + ":" + team,projected);
    const ownership = readOwnership(row);
    if (ownership !== undefined) {
      addProjection(ownershipById,row.id || row.playerid,ownership);
      if (name && team) addProjection(ownershipByName,name + ":" + team,ownership);
    }
    const ceiling = readCeiling(row);
    if (Number.isFinite(ceiling)) {
      addProjection(ceilingById,row.id || row.playerid,ceiling);
      if (name && team) addProjection(ceilingByName,name + ":" + team,ceiling);
    }
  }
  if (!byId.size && !byName.size) throw new Error("Projection CSV needs a numeric Projection column and an ID or player name plus team.");
  const playerNames = new Map();
  for (const player of players) {
    const identity = matchName(player.name)+":"+player.team;
    playerNames.set(identity,(playerNames.get(identity) || 0)+1);
    recordNameVariant(salaryVariants,player.name,player.team);
  }
  let matchedCount = 0;
  const updated = players.map(player => {
    const {id,name,team} = player;
    const nameKey = matchName(name)+":"+team;
    const variantKey = nameVariant(name)+":"+team;
    const variants = projectionVariants.get(variantKey);
    // Use a name fallback only when it identifies one salary player.
    const uniqueName = playerNames.get(nameKey) === 1 ? nameKey : undefined;
    const alternate = uniqueName && salaryVariants.get(variantKey)?.size === 1 && variants?.size === 1 ?
      variants.values().next().value : undefined;
    const points = byId.get(id) ?? byName.get(uniqueName) ?? byName.get(alternate);
    if (points == null) return player;
    matchedCount++;
    return {...player,points,source:"Projection CSV",
      ceiling:ceilingById.get(id) ?? ceilingByName.get(uniqueName) ?? ceilingByName.get(alternate) ?? player.ceiling,
      ownership:ownershipById.get(id) ?? ownershipByName.get(uniqueName) ?? ownershipByName.get(alternate) ?? player.ownership};
  });
  if (!matchedCount) {
    throw new Error("No projections matched this slate. Choose a matching file with player IDs or names and teams.");
  }
  return {players:updated,matched:matchedCount};
}

export function importPlayers(salaryCSV, projectionCSV = "", sport = "NBA", {inspection,slateKey} = {}) {
  const profile = rosterProfile(sport);
  const allowed = new Set(profile.roster.flatMap(([,positions]) => positions));
  const {rows,preview,slates} = inspection ?? inspectSalaryCSV(salaryCSV);
  const selectedSlate = slateKey ?? (slates.length === 1 ? slates[0].key : undefined);
  if (slates.length > 1 && !slates.some(slate => slate.key === selectedSlate)) {
    throw new Error("This cheatsheet contains multiple slates or dates. Choose a slate before building.");
  }
  const salaryRows = slates.length > 1 ? rows.filter(row => cheatsheetKey(row) === selectedSlate) : rows;
  const players = new Map();
  let skipped = 0;
  for (const row of salaryRows) {
    const name = playerName(row);
    const slots = positionCodes(row.rosterposition || "",sport,allowed);
    const positions = slots.length ? slots : positionCodes(row.position || "",sport,allowed);
    const salary = csvNumber(row.salary);
    const team = teamCode(row.team || row.teamabbr,sport);
    const id = row.id || row.playerid || (preview && name && team ? "preview:"+team+":"+matchName(name) : "");
    if (!id || !name || !positions.length || !Number.isInteger(salary) || salary <= 0 || !team) {
      skipped++;
      continue;
    }
    const provided = csvNumber(row.projection || row.projectedpoints || row.ppgprojection || row.fpts);
    const average = csvNumber(row.fppg);
    const points = Number.isFinite(provided) ? provided : average;
    const source = Number.isFinite(provided) ? "Salary CSV projection" :
      Number.isFinite(average) ? "FanDuel FPPG" : "";
    const status = row.injuryindicator || row.injurystatus || row.status || "";
    if (players.has(id)) {
      const existing = players.get(id);
      if (existing.team !== team || existing.salary !== salary || existing.name !== name) {
        throw new Error("Conflicting rows share a FanDuel player ID. Use a single slate CSV.");
      }
      existing.positions = [...new Set([...existing.positions, ...positions])];
      if (unavailable(status)) {
        existing.status = status;
        existing.selection = "exclude";
      } else if (!existing.status) {
        existing.status = status;
      }
      continue;
    }
    const game = (row.game || row.gameid || row.matchup || (preview && row.opp ? [team,teamCode(row.opp,sport)].sort().join("/") : "")).toUpperCase().replace(/\s+/g,"");
    players.set(id,{id,name,positions,salary,team,points,confirmedStarter:/^(1|true|yes)$/i.test(row.starter) ? true : /^(0|false|no)$/i.test(row.starter) ? false : undefined,ceiling:readCeiling(row),ownership:readOwnership(row),source,status,game,
      selection:unavailable(status) ? "exclude" : "available"});
  }
  if (!players.size) throw new Error("No compatible " + profile.name + " players found. Upload a CSV with ID, Name or Nickname, Position, Salary, and Team.");
  return {...applyPlayerProjections([...players.values()],projectionCSV,sport,{selectedSlate}),skipped,preview};
}

function requiredLockSlots(locked, profile) {
  if (!locked.length) return 0;
  if (locked.length > profile.roster.length) throw new Error("Lock at most " + profile.roster.length + " players.");
  if (locked.reduce((sum,player) => sum + player.salary,0) > profile.salaryCap) {
    throw new Error("Locked salaries exceed the salary cap. Unlock at least one player.");
  }
  const teams = new Map();
  for (const player of locked) {
    const total = (teams.get(player.team) || 0) + 1;
    if (total > profile.maxTeam) throw new Error("Too many locks from " + player.team + ". Keep at most " + profile.maxTeam + " from one team.");
    teams.set(player.team,total);
  }

  // Any group of locks needs at least as many distinct eligible slots as players.
  // Classic rosters have at most nine slots, including FLEX and multi-position slots.
  const eligibleSlots = locked.map(player => profile.roster.reduce((mask,[,positions],index) =>
    player.positions.some(position => positions.includes(position)) ? mask | (1 << index) : mask, 0));
  let required = 0;
  for (let group = 1; group < (1 << locked.length); group++) {
    let slots = 0;
    const names = [];
    for (let index = 0; index < locked.length; index++) {
      if (!(group & (1 << index))) continue;
      slots |= eligibleSlots[index];
      names.push(locked[index].name);
    }
    const labels = profile.roster.filter((_,index) => slots & (1 << index)).map(([label]) => label);
    if (labels.length === names.length) required |= slots;
    if (labels.length < names.length) {
      throw new Error(names.join(", ") + " need " + names.length + " slots. Eligible slots: " +
        (labels.join(", ") || "none") + ". Unlock at least one of these players.");
    }
  }
  return required;
}

export function buildLineups(players, count, difference, searchLimit = 160000, sport = "NBA", {exposure = 100,stack = 0,exactFirst = false,fixedSlots = new Map(),onLineup} = {}) {
  const profile = rosterProfile(sport);
  const roster = profile.roster;
  const salaryCap = profile.salaryCap;
  if (!Number.isInteger(count) || count < 1 || count > 20 ||
      !Number.isInteger(difference) || difference < 1 || difference > roster.length) {
    throw new Error("Choose 1–20 lineups and a minimum difference of 1–" + roster.length + " players.");
  }
  const eligible = players.filter(player => player.selection !== "exclude" && Number.isFinite(player.points));
  const locked = players.filter(player => player.selection === "lock");
  if (locked.some(player => !Number.isFinite(player.points))) throw new Error("A locked player is missing a projection.");
  const reservedSlots = fixedSlots.size ? 0 : requiredLockSlots(locked,profile);
  if (new Set(eligible.map(player => player.team)).size < 3) return {lineups:[],limited:false};
  const usage = new Map();
  const exposureLimits = new Map(eligible.map(player => [
    player.id,Math.floor(count*Math.min(exposure,player.maxExposure ?? 100)/100)
  ]));
  const lockedIds = new Set(locked.map(player => player.id));
  const stackRequired = (sport === "NFL" || sport === "CFB") ? stack : 0;
  const passCatchers = new Map();
  if (stackRequired) {
    for (const player of eligible) {
      if (!player.positions.some(position => position === "WR" || position === "TE")) continue;
      if (!passCatchers.has(player.team)) passCatchers.set(player.team,[]);
      passCatchers.get(player.team).push(player);
    }
  }
  const projectionOrder = [...eligible].sort((a,b) => b.points-a.points || a.salary-b.salary || a.id.localeCompare(b.id));
  const eligibleSlots = new Map(projectionOrder.map(player => [player.id,0]));
  const slots = roster.map(([label,positions],index) => ({
    label,index,pool:projectionOrder.filter(player => {
      if (fixedSlots.has(index) && fixedSlots.get(index)!==player.id) return false;
      if (fixedSlots.size && [...fixedSlots].some(([slot,id])=>id===player.id && slot!==index)) return false;
      if ((reservedSlots & (1 << index)) && !lockedIds.has(player.id)) return false;
      if (!player.positions.some(position => positions.includes(position))) return false;
      eligibleSlots.set(player.id,eligibleSlots.get(player.id) | (1 << index));
      return true;
    })
  })).sort((a,b) => a.pool.length-b.pool.length || a.index-b.index);
  const playerOrder = new Map(projectionOrder.map((player,index) => [player.id,index]));
  // Keep the primary QB and pitcher slots distinct because their roster roles affect constraints.
  const swappable = slots.map((slot,index) => ["QB","P"].includes(slot.label) ? [] :
    slots.slice(0,index).map((earlier,depth) => ({earlier,depth}))
      .filter(({earlier}) => !["QB","P"].includes(earlier.label) &&
        earlier.pool.some(player => eligibleSlots.get(player.id) & (1 << slot.index))));
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
  // Relax uniqueness and team constraints to bound the points attainable at each budget.
  // Rounding costs down keeps the bound safe even for nonstandard salary increments.
  const budgetUnit = 100;
  const budgetSteps = Math.floor(salaryCap / budgetUnit);
  const maximumOverlap = roster.length-difference;
  function scoreBounds(previous, canUse) {
    // Count shared players against the most recent lineup. Repeated players in
    // this relaxed calculation are allowed, so it remains an upper bound.
    const sharedLimit = previous ? maximumOverlap : 0;
    const budgetBounds = [Array.from({length:sharedLimit+1},() => new Float64Array(budgetSteps+1))];
    for (let index = slots.length-1; index >= 0; index--) {
      const next = budgetBounds[0];
      const bounds = Array.from({length:sharedLimit+1},() => new Float64Array(budgetSteps+1).fill(-Infinity));
      const cheapest = [Infinity,Infinity];
      for (const player of slots[index].pool) {
        if (!canUse(player)) continue;
        const shared = Number(Boolean(previous?.ids.has(player.id)));
        const cost = Math.floor(player.salary / budgetUnit);
        if (cost >= cheapest[shared]) continue;
        cheapest[shared] = cost;
        for (let allowed = shared; allowed <= sharedLimit; allowed++) {
          const floor = next[allowed-shared];
          const ceiling = bounds[allowed];
          for (let budget = cost; budget <= budgetSteps; budget++) {
            ceiling[budget] = Math.max(ceiling[budget],player.points + floor[budget-cost]);
          }
        }
      }
      budgetBounds.unshift(bounds);
    }
    return budgetBounds;
  }
  // A second relaxation keeps players distinct and drops position-by-position
  // assignments. It is strongest when flexible slots share the same expensive players.
  // Small searches, such as individual modeled opponent lineups, can spend
  // more time building this table than the additional pruning would save.
  function distinctScoreBounds(excludedId) {
    return possible.slice(0,-1).map((ids,index) => {
      const remaining = slots.length-index;
      const scores = Array.from({length:remaining+1},(_,count) =>
        new Float64Array(budgetSteps+1).fill(count ? -Infinity : 0));
      for (const player of projectionOrder) {
        if (!ids.has(player.id) || lockedIds.has(player.id) || player.id === excludedId) continue;
        const cost = Math.floor(player.salary/budgetUnit);
        for (let count = remaining; count > 0; count--) {
          for (let budget = cost; budget <= budgetSteps; budget++) {
            scores[count][budget] = Math.max(scores[count][budget],player.points + scores[count-1][budget-cost]);
          }
        }
      }
      return scores;
    });
  }
  const distinctBounds = exactFirst || searchLimit > 5000 ? distinctScoreBounds() : null;
  // A high outlier can otherwise contribute again to the relaxed bound even
  // after the search has selected them. Keep a table without that player.
  const highest = projectionOrder[0];
  const outlier = highest.points-projectionOrder[1].points >= 10 ? highest.id : undefined;
  const withoutOutlier = exactFirst && outlier !== undefined ? distinctScoreBounds(outlier) : null;
  const baseBounds = scoreBounds(null,() => true);
  const lockSalary = locked.reduce((sum,player) => sum+player.salary,0);
  const lockPoints = locked.reduce((sum,player) => sum+player.points,0);
  const lineups = [];
  let limited = false;
  let restriction;
  for (let number = 0; number < count; number++) {
    const selected = [];
    const ids = new Set();
    const teams = new Map();
    const hitters = new Map();
    const overlaps = lineups.map(() => 0);
    if (number && locked.length > maximumOverlap) {
      restriction = "Your locked players leave room for at most " + (roster.length-locked.length) +
        " different players between lineups. Lower the minimum difference or unlock players.";
      break;
    }
    const canUse = player => lockedIds.has(player.id) ||
      (usage.get(player.id) || 0) < exposureLimits.get(player.id);
    const activeTeams = new Set(eligible.filter(canUse).map(player => player.team));
    if (activeTeams.size < 3) {
      restriction = "The exposure limits leave eligible players on fewer than three teams.";
      break;
    }
    const qbSlot = stackRequired ? slots.find(slot => slot.label === "QB") : undefined;
    const stackQuarterbacks = new Set(qbSlot?.pool.filter(qb => canUse(qb) &&
      (passCatchers.get(qb.team) || []).filter(player => player.id !== qb.id && canUse(player)).length >= stackRequired)
      .map(qb => qb.id));
    if (qbSlot && !stackQuarterbacks.size) {
      restriction = "No eligible quarterback has enough available WR/TE teammates for this stack.";
      break;
    }
    const previous = lineups.at(-1);
    const budgetBounds = previous ? scoreBounds(previous,canUse) : baseBounds;
    const nodeLimit = exactFirst && number === 0 ? Infinity : searchLimit;
    let nodes = 0;
    let best = null;
    function search(index,salary,points,locksRemaining,unplacedSalary,unplacedPoints) {
      nodes++;
      if (salary + Math.max(unplacedSalary,salaryFloor[index]) > salaryCap || locksRemaining > slots.length-index ||
          (best && points+pointsCeiling[index] <= best.points) ||
          overlaps.some(overlap => overlap > maximumOverlap)) return;
      const allowedOverlap = previous ? maximumOverlap-overlaps.at(-1) : 0;
      const budget = Math.floor((salaryCap-salary)/budgetUnit);
      const slotBound = budgetBounds[index][allowedOverlap][budget];
      const uniqueBounds = withoutOutlier && ids.has(outlier) ? withoutOutlier : distinctBounds;
      const unfilled = slots.length-index-locksRemaining;
      const uncommitted = Math.floor((salaryCap-salary-unplacedSalary)/budgetUnit);
      const uniqueBound = uniqueBounds?.[index]?.[unfilled][uncommitted] ?? Infinity;
      const budgetBound = Math.min(slotBound,unplacedPoints+uniqueBound);
      if (budgetBound === -Infinity || (best && points + budgetBound + 1e-9 < best.points)) return;
      if (nodeLimit === Infinity && best && index < slots.length) {
        let remaining = slots.length-index;
        let ceiling = points;
        for (const player of projectionOrder) {
          if (ids.has(player.id) || (!lockedIds.has(player.id) && exposureLimits.get(player.id) === 0)) continue;
          ceiling += player.points;
          if (--remaining === 0) break;
        }
        if (remaining || ceiling+1e-9 <= best.points) return;
      }
      if (locksRemaining && locked.some(player => !ids.has(player.id) && !possible[index].has(player.id))) return;
      if (index === slots.length) {
        if (teams.size < 3) return;
        if (qbSlot) {
          const qb = selected.find(({slot}) => slot === qbSlot.index).player;
          const teammates = (passCatchers.get(qb.team) || [])
            .filter(player => player.id !== qb.id && ids.has(player.id));
          if (teammates.length < stackRequired) return;
        }
        if (sport === "CFB" && selected.every(({player}) => player.game) &&
            new Set(selected.map(({player}) => player.game)).size < 2) return;
        best = {picks:[...selected].sort((a,b)=>a.slot-b.slot),ids:new Set(ids),salary,points};
        return;
      }
      const slot = slots[index];
      for (let rank = 0; rank < slot.pool.length && nodes < nodeLimit; rank++) {
        const player = slot.pool[rank];
        if (!canUse(player)) continue;
        if (slot === qbSlot && !stackQuarterbacks.has(player.id)) continue;
        if (ids.has(player.id) || (teams.get(player.team) || 0) >= profile.maxTeam) continue;
        const isHitter = profile.maxHitters && slot.label !== "P";
        if (isHitter && (hitters.get(player.team) || 0) >= profile.maxHitters) continue;
        if (locksRemaining === slots.length-index && !lockedIds.has(player.id)) continue;
        if (salary+player.salary+salaryFloor[index+1] > salaryCap) continue;
        if (best && points+player.points+pointsCeiling[index+1] <= best.points) break;
        const playerMask = eligibleSlots.get(player.id);
        // Swapping two eligible players preserves the lineup. Visit only the ordering
        // that places the higher-ranked player in the earlier searched slot.
        if (swappable[index].some(({earlier,depth}) => (playerMask & (1 << earlier.index)) &&
          (eligibleSlots.get(selected[depth].player.id) & (1 << slot.index)) &&
          playerOrder.get(player.id) < playerOrder.get(selected[depth].player.id))) continue;
        selected.push({player,slot:slot.index});
        ids.add(player.id);
        teams.set(player.team,(teams.get(player.team) || 0)+1);
        if (isHitter) hitters.set(player.team,(hitters.get(player.team) || 0)+1);
        for (const [i,lineup] of lineups.entries()) if (lineup.ids.has(player.id)) overlaps[i]++;
        const isLock = lockedIds.has(player.id);
        search(index+1,salary+player.salary,points+player.points,locksRemaining-Number(isLock),
          unplacedSalary-(isLock ? player.salary : 0),unplacedPoints-(isLock ? player.points : 0));
        for (const [i,lineup] of lineups.entries()) if (lineup.ids.has(player.id)) overlaps[i]--;
        const remaining = teams.get(player.team)-1;
        if (remaining) teams.set(player.team,remaining);
        else teams.delete(player.team);
        if (isHitter) hitters.set(player.team,hitters.get(player.team)-1);
        ids.delete(player.id);
        selected.pop();
      }
    }
    search(0,0,0,locked.length,lockSalary,lockPoints);
    if (nodes >= nodeLimit) limited = true;
    if (!best) break;
    lineups.push(best);
    for (const id of best.ids) usage.set(id,(usage.get(id) || 0)+1);
    onLineup?.(best,limited);
  }
  return {lineups,limited,restriction};
}

export function reviewCSV(lineups,sport = "NBA") {
  const {roster} = rosterProfile(sport);
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

export function scoreSavedBuilds(rows,records,cutoff) {
  const field = rows.filter(row=>row.entryid && row.points && Number.isFinite(Number(row.points))).map(row=>Number(row.points)).sort((a,b)=>b-a);
  const payouts = new Map();
  for (const row of rows) {
    const range = row.prizerank?.replaceAll(",","").match(/^(\d+)(?:st|nd|rd|th)?(?:\s*-\s*(\d+)(?:st|nd|rd|th)?)?$/i);
    const amount = csvNumber(row.prizepayout);
    if (range && Number.isFinite(amount)) {
      const last=Math.min(Number(range[2] || range[1]),rows.length);
      for(let rank=Number(range[1]);rank<=last;rank++) payouts.set(rank,amount);
    }
  }
  const fee = csvNumber(rows.find(row=>row.contestinfo==="Entry Fee")?.contestvalue);
  const actuals = new Map();
  for (const row of rows) {
    const id = row.player?.match(/\((\d+-\d+)\)$/)?.[1];
    if (id && row.fpts && Number.isFinite(Number(row.fpts))) actuals.set(id,Number(row.fpts));
  }
  const results = [];
  for (const record of records) {
    for (const [version,build] of Object.entries(record)) {
      if (version === "latest" && build.capturedAt === record.first?.capturedAt) continue;
      if (!(Date.parse(build.capturedAt) < Date.parse(build.lockAt))) continue;
      const scores = build.lineups.filter(players => players.length &&
        players.every(player => actuals.has(player.id))).map(players =>
          players.reduce((total,player) => total+actuals.get(player.id),0));
      if (!scores.length) continue;
      const rounded = scores.map(value=>Math.round(value*100)/100);
      const best = Math.max(...rounded);
      const bestRank = 1+field.filter(value=>value>best).length;
      let gross = 0;
      for (const value of rounded) {
        const rank = 1+field.filter(n=>n>value).length+rounded.filter(n=>n>value).length;
        const ties = field.filter(n=>n===value).length+rounded.filter(n=>n===value).length;
        for (let place=rank;place<rank+ties;place++) gross+=(payouts.get(place)||0)/ties;
      }
      results.push({version,slate:build.slate,capturedAt:build.capturedAt,lockAt:build.lockAt,requested:build.requested,scored:scores.length,total:build.lineups.length,
        best,bestRank,gapToFirst:Math.max(0,(field[0]??best)-best),
        net:rounded.length===build.lineups.length && payouts.size && Number.isFinite(fee) ? gross-fee*rounded.length : null,hits:cutoff === null ? null : scores.filter(score => Math.round(score*100) >= Math.round(cutoff*100)).length});
    }
  }
  return results;
}


// Keep provider requests infrequent until the slate enters its final hour.
export function liveRefreshSeconds(lockAt,now = Date.now()) {
  if (!Number.isFinite(lockAt)) return 1800;
  const remaining = Math.ceil((lockAt-now)/1000);
  if (remaining <= 3600) return 600;
  return Math.min(1800,remaining-3600);
}
