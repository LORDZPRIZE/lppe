import {readFanDuelEntries,fillFanDuelEntries} from "./fanduel-entry-export.js";
import {makeCfbSnapshot,saveCfbSnapshot,readStoredCfbSnapshots} from "./fanduel-cfb-snapshot.js";
import {enteredNBAIds,reconcileNBAEntries,reviewPlayerCeilings,ownershipReview,pairHeldOut,readNBAArchive,summarizeTop3Pairs} from "./fanduel-nba-review.js";
import { addRotations, nbaRoleProjections } from "./fanduel-nba-tournament.js";
import { automaticSlateChoice, cfbMatchupIssue, matchName, teamCode, applyPlayerProjections, importPlayers, inspectSalaryCSV, parseCSV, profiles, scoreSavedBuilds, reviewContest, summarizeReviewExport, reviewCSV, unavailable } from "./fanduel-optimizer.js";

const byId = id => document.getElementById(id);
const percent = new Intl.NumberFormat("en-US",{style:"percent",maximumFractionDigits:1});
const targetLabel = target => ({firstAndTop10:"first-place and all-lineup top-10",allTop10:"all-lineup top-10",top1:"top-1%",top3:"top-3%",top20:"top-20",first:"first-place"})[target] ?? "first-place";
const dollars = new Intl.NumberFormat("en-US",{style:"currency",currency:"USD",maximumFractionDigits:0});
const importForm = byId("fdImport");
const autoLoad = byId("fdAutoLoad");
const liveSlate = byId("fdLiveSlate");
const liveProjections = byId("fdLiveProjections");
const restoreLiveProjections = byId("fdUseLiveProjections");
const liveProjectionStatus = byId("fdLiveProjectionStatus");
const refreshSlates = byId("fdRefreshSlates");
const sport = byId("fdSport");
const salaries = byId("fdSalaries");
const projections = byId("fdProjections");
const importedSlate = byId("fdImportedSlate");
const search = byId("fdSearch");
const positionFilter = byId("fdPositionFilter");
const selectionFilter = byId("fdSelectionFilter");
const playerSort = byId("fdPlayerSort");
const previousPlayers = byId("fdPreviousPlayers");
const nextPlayers = byId("fdNextPlayers");
const playersPerPage = 50;
let playerPage = 0;
const sortPlayers = {
  projection:(a,b) => (b.points ?? -Infinity) - (a.points ?? -Infinity),
  value:(a,b) => ((b.points ?? -Infinity) / b.salary) - ((a.points ?? -Infinity) / a.salary),
  ceiling:(a,b) => (Number.isFinite(b.ceiling) ? b.ceiling : -Infinity) -
    (Number.isFinite(a.ceiling) ? a.ceiling : -Infinity),
  salary:(a,b) => a.salary - b.salary
};
const count = byId("fdCount");
const difference = byId("fdDifference");
const exposure = byId("fdExposure");
const stack = byId("fdStack");
const depth = byId("fdSearchDepth");
const refine = byId("fdRefine");
const avoidQuestionable = byId("fdAvoidQuestionable");
const uncertainAvailability = status => /^(q|questionable|gtd|game[ -]time decision|day[ -]to[ -]day|dtd)$/i.test(status || "");
const objective = byId("fdObjective");
const mode = byId("fdMode");
const build = byId("fdBuild");
const exportButton = byId("fdExport");
const bulkPanel = byId("fdBulkExport");
const bulkFile = byId("fdEntriesTemplate");
const bulkContest = byId("fdExportContest");
const bulkButton = byId("fdBulkDownload");
const bulkStatus = byId("fdBulkExportStatus");
const checkedLineups = new Set();
let bulkTemplate;
let bulkBusy = false;
let players = [];
let lineups = [];
let optimizer;
let buildProgress;
let autoRequest;
const automatic = byId("fdAutomatic");
try { automatic.checked = localStorage.getItem("fd-automatic") !== "off"; } catch {}
const sessionKey = () => "lppe-fd-session-v1/"+sport.value;
const sessionMemory = new Map();
let listedSlates = [];
function readSession() {
  const key = sessionKey();
  try { return JSON.parse(localStorage.getItem(key)) || sessionMemory.get(key); }
  catch { return sessionMemory.get(key); }
}
function writeSession(value) {
  const key = sessionKey();
  sessionMemory.set(key,value);
  try { localStorage.setItem(key,JSON.stringify(value)); } catch {}
}
function startAutomaticSession() {
  if (!automatic.checked || document.hidden || autoRequest || optimizer || importedSlateName || sport.disabled) return;
  const now = Date.now();
  if (loadedLiveSlate && slateLockAt > now) return;
  const saved = readSession();
  if (saved?.data?.lockAt > now && saved.data.players?.length) {
    listedSlates = saved.slates || [];
    liveSlate.replaceChildren(...listedSlates.filter(slate => !slate.lockAt || slate.lockAt > now)
      .map(slate => new Option(slate.label,slate.id)));
    if (![...liveSlate.options].some(option => option.value === saved.id)) {
      liveSlate.add(new Option(saved.data.label,saved.id));
    }
    liveSlate.value = saved.id;
    liveSlate.disabled = false;
    const needsCount = sport.value === "NBA" && saved.data.poolType === "salary feed" &&
      saved.data.listedPlayerCount !== saved.data.players.length;
    if (needsCount) {
      if (saved.retryCountAfter > now) {
        byId("fdStatus").textContent = "Saved NBA pool size is unverified. Tap Load slate and build to refresh, or import the contest player list.";
        autoLoad.disabled = false;
        return;
      }
      writeSession({...saved,retryCountAfter:now+30*60000});
    }
    loadPublicPool(false,needsCount ? null : saved.data);
    return;
  }
  if (saved?.resumeAt > now) {
    byId("fdStatus").textContent = saved.message || ("Live requests paused until "+new Date(saved.resumeAt).toLocaleString()+". Refresh slates to start sooner.");
    return;
  }
  writeSession({resumeAt:now+4*3600000});
  loadPublicPool(true);
}
let slateLockAt = null;
let loadedLiveSlate;
let loadedSalaryFile;
let loadedSlateKey;
let inspectedFile;
let inspectedSalary;
let importedSlateName;
const savedSlateKey = "lppe-fanduel-import-v1";
const savedSlateLifetime = 48 * 60 * 60 * 1000;
const tournamentTargets = {NBA:"top20",NFL:"first",CFB:"allTop10"};
const jointTargets = ["allTop10","firstAndTop10"];
const tournamentSports = ["NBA","NFL","CFB"];
const slateSettings = [byId("fdTarget"),mode,objective,count,difference,exposure,stack,depth,byId("fdFieldSize")];

function readSavedSlate() {
  try {
    const saved = JSON.parse(localStorage.getItem(savedSlateKey));
    if (!saved) return null;
    if (Object.hasOwn(profiles,saved.sport) && Array.isArray(saved.players) && saved.players.length &&
        saved.settings && saved.savedAt + savedSlateLifetime > Date.now()) return saved;
    localStorage.removeItem(savedSlateKey);
  } catch {}
  return null;
}

function showSavedSlate() {
  const saved = readSavedSlate();
  byId("fdSavedSlate").hidden = !saved;
  byId("fdSavedSlateInfo").textContent = saved ?
    profiles[saved.sport].name+" · "+saved.name+" · saved "+new Date(saved.savedAt).toLocaleString() : "";
}

byId("fdSaveSlate").addEventListener("click",() => {
  if (!importedSlateName || !players.length) return;
  try {
    const settings = Object.fromEntries(slateSettings.map(control => [control.id,control.value]));
    const saved = {name:importedSlateName,sport:sport.value,players,settings,skipQuestionable:avoidQuestionable.checked,savedAt:Date.now()};
    localStorage.setItem(savedSlateKey,JSON.stringify(saved));
    byId("fdSaveStatus").textContent = "Saved for up to 48 hours on this device.";
    showSavedSlate();
  } catch {
    byId("fdSaveStatus").textContent = "This browser could not save the slate. Keep your CSV for later.";
  }
});

byId("fdForgetSlate").addEventListener("click",() => {
  try {
    localStorage.removeItem(savedSlateKey);
    byId("fdSaveStatus").textContent = "";
    showSavedSlate();
  } catch {
    byId("fdSavedSlateInfo").textContent = "This browser could not clear the saved slate.";
  }
});

byId("fdResumeSlate").addEventListener("click",() => {
  const saved = readSavedSlate();
  if (!saved) {
    showSavedSlate();
    return;
  }
  autoRequest?.abort();
  autoRequest = undefined;
  autoLoad.disabled = !liveSlate.value;
  clearRemoval();
  clearLineups();
  resetImport();
  search.value = selectionFilter.value = "";
  playerPage = 0;
  sport.value = saved.sport;
  applySport();
  for (const control of slateSettings) {
    if (Object.hasOwn(saved.settings,control.id)) control.value = control.id==="fdTarget" && saved.settings.fdTarget==="top100" ? "top20" : saved.settings[control.id];
  }
  slateLockAt = null;
  loadedLiveSlate = undefined;
  avoidQuestionable.checked = saved.skipQuestionable === true;
  importedSlateName = saved.name;
  players = saved.players;
  applyMode();
  byId("fdPool").hidden = false;
  byId("fdStatus").textContent = "Resumed "+saved.name+" from "+new Date(saved.savedAt).toLocaleString()+
    ". Confirm the contest and current player availability before using these lineups.";
  byId("fdSaveStatus").textContent = "";
  renderPlayers();
  buildCurrentLineups();
  showBuildResults();
});
let lastRemoval;

function clearRemoval() {
  lastRemoval = undefined;
  byId("fdRemoval").hidden = true;
  byId("fdRemovalStatus").textContent = "";
}

function removePlayer(id, lineup = lineups[0]) {
  const player = players.find(candidate => candidate.id === id);
  if (!player || player.selection === "exclude") return;
  lastRemoval = {
    player,previousSelection:player.selection,previousObjective:objective.value,previousLineup:lineup
  };
  player.selection = "exclude";
  objective.value = "projection";
  byId("fdRemoval").hidden = false;
  byId("fdRemovalStatus").textContent = player.name+" excluded from the build.";
  rebuildAfterRemoval();
}

function rebuildAfterRemoval() {
  clearLineups();
  renderPlayers();
  buildCurrentLineups();
  showBuildResults();
}

byId("fdUndoRemoval").addEventListener("click",() => {
  if (!lastRemoval) return;
  const {player,previousSelection,previousObjective} = lastRemoval;
  player.selection = previousSelection;
  if (objective.value === "projection" && [...objective.options].some(option =>
    option.value === previousObjective && !option.disabled)) {
    objective.value = previousObjective;
  }
  clearRemoval();
  rebuildAfterRemoval();
});

function clearLineups() {
  optimizer?.terminate();
  optimizer = undefined;
  buildProgress = undefined;
  byId("fdCancel").hidden = true;
  refine.hidden = true;
  build.disabled = false;
  lineups = [];
  checkedLineups.clear();
  bulkPanel.hidden=true;
  updateBulkExport();
  exportButton.disabled = true;
  byId("fdEntryCheck").textContent="";
  byId("fdExportCheck").replaceChildren();
  byId("fdResults").replaceChildren();
  byId("fdResultsPanel").hidden = true;
}

const mandatoryInjuryHold = status => unavailable(String(status||"").trim()) || /^(PUP|NFI|RESERVE[ /-].*|PHYSICALLY UNABLE TO PERFORM|INJURED[ -]RESERVE)$/i.test(String(status||"").trim()) || /\b(injured reserve|out for season|ruled out|inactive|suspended|doubtful|questionable|non-football injury)\b/i.test(String(status||""));
let nflInjuryHolds = new Set();
function poolForBuild() {
  return players.map(player => mandatoryInjuryHold(player.status) ||
    (sport.value==="NFL" && (nflInjuryHolds.has(player.id) || /^(jalen hurts|tyquan thornton|joshua palmer|josh palmer)$/i.test(player.name.trim()))) ||
    ((sport.value==="NFL" || avoidQuestionable.checked) && uncertainAvailability(player.status)) ?
    {...player,selection:"exclude"} : player);
}
async function verifyNFLInjuries() {
  const pool = players;
  const response = await fetch("/api/nba/fanduel?sport=NFL&availability=1",{cache:"no-store",signal:AbortSignal.timeout(12000)});
  if (!response.ok) throw new Error("NFL injury feed unavailable.");
  const data = await response.json();
  const age = Date.now()-Date.parse(data.checkedAt);
  if (!(age>=-30000 && age<300000) || !Array.isArray(data.reports) || !Array.isArray(data.teams)) throw new Error("NFL injury feed is stale or incomplete.");
  if (pool!==players || sport.value!=="NFL") throw new Error("Player pool changed; retry.");
  const teams = new Set(data.teams);
  if (pool.some(p=>p.selection!=="exclude" && Number.isFinite(p.points) && !teams.has(teamCode(p.team,"NFL")))) throw new Error("NFL injury coverage is missing a slate team.");
  const held = new Set(data.reports.filter(r=>mandatoryInjuryHold(r.status)||uncertainAvailability(r.status)||/^(injured|reserve|non-football injury)$/i.test(r.status)).map(r=>teamCode(r.team,"NFL")+":"+matchName(r.name)));
  nflInjuryHolds = new Set(pool.filter(p=>held.has(teamCode(p.team,"NFL")+":"+matchName(p.name))).map(p=>p.id));
  byId("fdNewsStatus").textContent="NFL injury feed checked "+new Date().toLocaleTimeString()+" · "+nflInjuryHolds.size+" players held out.";
}
function injuryBlocked(error) {
  clearLineups();
  byId("fdResultsPanel").hidden=false;
  byId("fdBuildStatus").textContent="Build/export blocked: "+error.message;
}

function checkSlate(pool, profile, selectedSport) {
  const eligible = pool.filter(player => player.selection !== "exclude" && Number.isFinite(player.points));
  const games = [...new Set(pool.map(player => player.game).filter(Boolean))].sort();
  const warnings = [];
  if (eligible.length < profile.roster.length) warnings.push("Too few eligible players to fill the roster.");
  const teams = new Map();
  for (const player of eligible) teams.set(player.team,(teams.get(player.team) || 0)+1);
  if (teams.size < 3) warnings.push("Fewer than three teams have eligible players.");
  const teamCapacity = [...teams.values()].reduce((sum,size) => sum + Math.min(size,profile.maxTeam),0);
  if (eligible.length >= profile.roster.length && teamCapacity < profile.roster.length) {
    warnings.push("Team limits leave too few eligible players to fill the roster.");
  }
  const pools = profile.roster.map(([,positions]) =>
    eligible.filter(player => player.positions.some(position => positions.includes(position))));
  const missing = new Set(profile.roster.filter((_,index) => !pools[index].length).map(([slot]) => slot));
  if (missing.size) warnings.push("No eligible players for " + [...missing].join(", ") + ".");
  if (!missing.size && eligible.length >= profile.roster.length) {
    // Reassign players across eligible slots to account for repeated positions and FLEX.
    const assigned = new Map();
    function assign(index,visited) {
      for (const player of pools[index]) {
        if (visited.has(player.id)) continue;
        visited.add(player.id);
        if (!assigned.has(player.id) || assign(assigned.get(player.id),visited)) {
          assigned.set(player.id,index);
          return true;
        }
      }
      return false;
    }
    const unfilled = profile.roster.filter((_,index) => !assign(index,new Set())).map(([label]) => label);
    if (unfilled.length) {
      warnings.push("Too few distinct players to fill every slot. Unfilled slots: "+unfilled.join(", ")+".");
    }
    const cheapestSlots = pools.reduce((sum,slotPool) => sum + slotPool.reduce((lowest,player) =>
      Math.min(lowest,player.salary),Infinity),0);
    const cheapestDistinct = eligible.map(player => player.salary).sort((a,b) => a-b)
      .slice(0,profile.roster.length).reduce((sum,salary) => sum+salary,0);
    if (Math.max(cheapestSlots,cheapestDistinct) > profile.salaryCap) {
      warnings.push("This pool cannot fill a roster under the "+dollars.format(profile.salaryCap)+" salary cap.");
    }
  }
  if (selectedSport === "CFB" && eligible.length && eligible.every(player => player.game) &&
      new Set(eligible.map(player => player.game)).size === 1) {
    warnings.push("The college football roster requires at least two games.");
  }
  return {eligible:eligible.length,games,warnings};
}

function renderSlateCheck() {
  const profile = profiles[sport.value];
  const {eligible,games,warnings} = checkSlate(poolForBuild(),profile,sport.value);
  byId("fdQuestionableHint").hidden = !avoidQuestionable.checked;
  const slateName = loadedLiveSlate?.name || importedSlateName;
  byId("fdSlateCheck").textContent = (slateName ? slateName+" · " : "") +
    players.length + " players · " + eligible + " eligible · " +
    (games.length ? games.length + " listed games" : "game details unavailable") + " · " +
    dollars.format(profile.salaryCap) + " cap · " + profile.roster.length + " roster slots. " +
    (warnings.join(" ") || "Confirm these games match your FanDuel contest.");
  byId("fdGames").hidden = !games.length;
  byId("fdGameList").replaceChildren(...games.map(game => {
    const item = document.createElement("li");
    item.textContent = game;
    return item;
  }));
  if (!optimizer) build.disabled = Boolean(warnings.length);
}

function renderPlayers() {
  byId("fdLiveOverrides").hidden = !loadedLiveSlate;
  restoreLiveProjections.hidden = !loadedLiveSlate?.projectionText;
  renderSlateCheck();
  byId("fdSaveControls").hidden = !importedSlateName;
  renderPlayerRows();
}

function renderPlayerRows() {
  const body = byId("fdPlayers");
  body.replaceChildren();
  const query = search.value.trim().toLowerCase();
  const visible = players.filter(player =>
    (player.name+" "+player.team).toLowerCase().includes(query) &&
    (!positionFilter.value || player.positions.includes(positionFilter.value)) &&
    (!selectionFilter.value || player.selection === selectionFilter.value));
  visible.sort((a,b) => sortPlayers[playerSort.value](a,b) || a.name.localeCompare(b.name));
  const lastPage = Math.max(0,Math.ceil(visible.length/playersPerPage)-1);
  playerPage = Math.min(playerPage,lastPage);
  const first = playerPage*playersPerPage;
  const page = visible.slice(first,first+playersPerPage);
  previousPlayers.disabled = playerPage === 0;
  nextPlayers.disabled = playerPage === lastPage;
  byId("fdPlayerPages").hidden = lastPage === 0;
  byId("fdVisiblePlayers").textContent = page.length ?
    "Showing "+(first+1)+"–"+(first+page.length)+" of "+visible.length+" matching players" :
    "No players match these filters.";
  for (const player of page) {
    const row = body.insertRow();
    const nameCell = row.insertCell();
    nameCell.textContent = player.name;
    const meta = document.createElement("small");
    meta.className = "player-mobile-meta";
    const injury = player.injurySource ? player.status+" ("+player.injurySource+")" : player.status;
    meta.textContent = [player.positions.join("/"),player.team,injury,player.source || "Missing projection"]
      .filter(Boolean).join(" · ");
    nameCell.append(meta);
    for (const [value,desktopOnly] of [
      [player.positions.join("/"),true],[player.team,true],[dollars.format(player.salary),false],
      [Number.isFinite(player.points) ? player.points.toFixed(1) : "—",false],
      [player.source || "Missing",true],[injury || "—",true]
    ]) {
      const cell = row.insertCell();
      cell.textContent = value;
      if (desktopOnly) cell.className = "player-detail";
    }
    const playerControls = document.createElement("div");
    playerControls.className = "player-controls";
    row.insertCell().append(playerControls);
    const selection = document.createElement("select");
    selection.setAttribute("aria-label",player.name+" selection");
    for (const [value,label] of [["available","Available"],["lock","Lock"],["exclude","Exclude"]]) {
      const option = document.createElement("option");
      option.value = value;
      option.textContent = label;
      const blockedByStatus = Boolean(loadedLiveSlate && unavailable(player.status));
      option.disabled = (value !== "exclude" && blockedByStatus) ||
        (value === "lock" && !Number.isFinite(player.points));
      selection.append(option);
    }
    selection.value = player.selection;
    selection.addEventListener("change",() => {
      if (selection.value === "exclude") {
        removePlayer(player.id);
        byId("fdUndoRemoval").focus();
        return;
      }
      player.selection = selection.value;
      if (lastRemoval?.player === player) clearRemoval();
      if (lastRemoval && selection.value === "lock") {
        objective.value = "projection";
        rebuildAfterRemoval();
        return;
      }
      clearLineups();
      if (selectionFilter.value) renderPlayers();
      else renderSlateCheck();
    });
    playerControls.append(selection);
    if (mode.value === "gpp") {
      const cap = document.createElement("input");
      cap.type = "number";
      cap.min = "0";
      cap.max = "100";
      cap.required = true;
      cap.value = player.maxExposure ?? 100;
      cap.setAttribute("aria-label",player.name+" maximum exposure percent");
      cap.addEventListener("change",() => {
        if (!cap.reportValidity()) {
          cap.value = player.maxExposure ?? 100;
          return;
        }
        player.maxExposure = cap.valueAsNumber;
        clearLineups();
        renderSlateCheck();
      });
      const capLabel = document.createElement("label");
      capLabel.className = "player-exposure";
      capLabel.append("Max %",cap);
      playerControls.append(capLabel);
    }
  }
}

function resetImport() {
  importForm.reset();
  byId("fdSalaryOnly").hidden = true;
  byId("fdSlateChoice").hidden = true;
  importedSlate.replaceChildren();
  loadedSalaryFile = inspectedFile = undefined;
  loadedSlateKey = inspectedSalary = undefined;
}

importedSlate.addEventListener("change",() => {
  if (importedSlate.value) importForm.requestSubmit();
});

for (const input of [salaries,projections]) {
  input.addEventListener("change",() => {
    if (salaries.files.length && !salaries.disabled) importForm.requestSubmit();
  });
}

importForm.addEventListener("submit",async event => {
  event.preventDefault();
  if (!salaries.files.length || salaries.disabled) return;
  autoRequest?.abort();
  autoRequest = undefined;
  byId("fdSalaryOnly").hidden = !projections.files.length;
  autoLoad.disabled = true;
  sport.disabled = true;
  salaries.disabled = projections.disabled = importedSlate.disabled = true;
  importForm.querySelector("button").disabled = true;
  byId("fdSalaryOnly").disabled = true;
  byId("fdResumeSlate").disabled = true;
  try {
    const salaryFile = salaries.files[0];
    const projectionFile = projections.files[0];
    if (salaryFile.size > 5_000_000 || projectionFile?.size > 5_000_000) throw new Error("Use CSV files under 5 MB.");
    if (salaryFile !== inspectedFile) {
      byId("fdSlateChoice").hidden = true;
      importedSlate.replaceChildren();
      const inspection = inspectSalaryCSV(await salaryFile.text());
      inspectedSalary = inspection;
      inspectedFile = salaryFile;
      if (inspection.slates.length > 1) {
        importedSlate.append(new Option("Choose a slate",""),...inspection.slates.map(slate =>
          new Option([slate.name,slate.date,slate.entries+" entries"].filter(Boolean).join(" · "),slate.key)));
        byId("fdSlateChoice").hidden = false;
      }
    }
    const {slates} = inspectedSalary;
    const chosen = slates.length === 1 ? slates[0] : slates.find(slate => slate.key === importedSlate.value);
    if (slates.length > 1 && !chosen) {
      byId("fdStatus").textContent = "Choose the contest slate in your cheatsheet to build lineups." +
        (players.length ? " Your previous slate is still loaded." : "");
      byId("fdManualImport").open = true;
      return;
    }
    const projectionText = await projectionFile?.text();
    if (projectionFile && !projectionText.trim()) throw new Error("The projections file is empty. Choose another file or use the salary file alone.");
    const result = importPlayers("",projectionText,sport.value,{inspection:inspectedSalary,slateKey:chosen?.key});
    if (salaryFile === loadedSalaryFile && chosen?.key === loadedSlateKey) {
      const previous = new Map(players.map(player => [player.id,player]));
      for (const player of result.players) {
        const prior = previous.get(player.id);
        if (!prior) continue;
        player.selection = prior.selection === "lock" && !Number.isFinite(player.points) ?
          "available" : prior.selection;
        player.maxExposure = prior.maxExposure;
      }
    } else {
      search.value = positionFilter.value = selectionFilter.value = "";
      playerPage = 0;
    }
    loadedSalaryFile = salaryFile;
    loadedSlateKey = chosen?.key;
    importedSlateName = [salaryFile.name,chosen?.name,chosen?.date].filter(Boolean).join(" · ");
    byId("fdSaveStatus").textContent = "";
    slateLockAt = null;
    loadedLiveSlate = undefined;
    clearRemoval();
    clearLineups();
    players = result.players;
    const missing = players.filter(player => !Number.isFinite(player.points)).length;
    const averages = players.filter(player => player.source === "FanDuel FPPG").length;
    const excluded = players.filter(player => player.selection === "exclude").length;
    byId("fdStatus").textContent = players.length+" players loaded. "+averages+" use historical FPPG, "+
      missing+" have no projection, and "+excluded+" are excluded."+
      (result.skipped ? " Skipped "+result.skipped+" rows without usable player data." : "");
    if (projectionFile) byId("fdStatus").textContent += " Custom projections matched "+result.matched+" of "+players.length+" players.";
    if (result.preview) byId("fdStatus").textContent += " " +
      (chosen ? [chosen.name,chosen.date].filter(Boolean).join(" · ")+" cheatsheet loaded." : "Cheatsheet loaded.") +
      " Review exports use local IDs for players without FanDuel IDs.";
    byId("fdPool").hidden = false;
    renderPlayers();
    buildCurrentLineups();
  } catch (error) {
    byId("fdStatus").textContent = (error.message || "Could not read the player pool.") +
      (players.length ? " Your previous slate is still loaded." : "");
    byId("fdManualImport").open = true;
  } finally {
    salaries.disabled = projections.disabled = importedSlate.disabled = false;
    importForm.querySelector("button").disabled = false;
    byId("fdSalaryOnly").disabled = false;
    byId("fdResumeSlate").disabled = false;
    autoLoad.disabled = !liveSlate.value;
    sport.disabled = false;
  }
});

byId("fdSalaryOnly").addEventListener("click",() => {
  projections.value = "";
  importForm.requestSubmit();
});

function removalSummary(player,previous,rebuilt) {
  const removed = player.name + " excluded.";
  if (!rebuilt) return removed + " No valid replacement lineup found. You can undo the removal.";
  if (!previous?.ids.has(player.id)) return removed + " Lineups rebuilt.";
  const additions = rebuilt.picks.filter(pick => !previous.ids.has(pick.player.id)).map(pick => pick.player.name);
  const delta = rebuilt.points - previous.points;
  const change = Math.abs(delta) < .005 ? "unchanged" :
    (delta > 0 ? "+" : "−") + Math.abs(delta).toFixed(2) + " FPTS";
  return removed + " New top lineup adds " + additions.join(", ") + ". Projected total " +
    previous.points.toFixed(2) + " → " + rebuilt.points.toFixed(2) + " FPTS (" + change + ").";
}

function compareLineups(highCeiling,simulation) {
  const comparison = document.createElement("details");
  comparison.className = "lineup-comparison";
  const summary = document.createElement("summary");
  summary.textContent = "Compare "+lineups.length+" lineups";
  const table = document.createElement("table");
  const headings = ["Lineup","Projected FPTS","FPTS vs. Lineup 1","Salary left","Players changed"];
  if (highCeiling) headings.push("Ceiling FPTS");
  if (simulation) {
    headings.push("Modeled win share",sport.value==="CFB" ? "Modeled top-1% share" : "Modeled top-3% share");
    if (!jointTargets.includes(simulation.target)) headings.push("Added "+targetLabel(simulation.target)+" coverage");
  }
  const header = table.createTHead().insertRow();
  for (const label of headings) {
    const cell = document.createElement("th");
    cell.scope = "col";
    cell.textContent = label;
    header.append(cell);
  }
  const body = table.createTBody();
  const top = lineups[0];
  const signed = new Intl.NumberFormat("en-US",{signDisplay:"exceptZero",minimumFractionDigits:2,maximumFractionDigits:2});
  for (const [index,lineup] of lineups.entries()) {
    const row = body.insertRow();
    const link = document.createElement("a");
    const id = "fdLineup"+(index+1);
    link.href = "#"+id;
    link.textContent = "Lineup "+(index+1);
    link.addEventListener("click",event => {
      const details = byId(id);
      details.open = true;
      if (event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return;
      event.preventDefault();
      details.querySelector("summary").focus({preventScroll:true});
      details.scrollIntoView({block:"start"});
    });
    row.insertCell().append(link);
    const changed = [...lineup.ids].filter(player => !top.ids.has(player)).length;
    const values = [lineup.points.toFixed(2),signed.format(lineup.points-top.points),
      dollars.format(profiles[sport.value].salaryCap-lineup.salary),changed];
    if (highCeiling) values.push(lineup.ceiling.toFixed(2));
    if (simulation) {
      values.push(percent.format(lineup.tournament.win),percent.format(sport.value==="CFB" ? lineup.tournament.top1 : lineup.tournament.top3));
      if (!jointTargets.includes(simulation.target)) values.push(percent.format(lineup.tournament.addedWinCoverage));
    }
    for (const value of values) row.insertCell().textContent = value;
  }
  const wrapper = document.createElement("div");
  wrapper.className = "tablewrap";
  wrapper.append(table);
  comparison.append(summary,wrapper);
  return comparison;
}

function renderLineups(result,requested,highCeiling) {
  const status = byId("fdBuildStatus");
  const eligibleIds = new Set(poolForBuild().filter(p=>p.selection!=="exclude").map(p=>p.id));
  if (result.lineups.some(l=>l.picks.some(({player})=>!eligibleIds.has(player.id)))) { injuryBlocked(new Error("Lineup failed eligibility validation. Rebuild.")); return; }
  lineups = result.simulation ? result.lineups : [...result.lineups].sort((a,b) => highCeiling ? b.ceiling - a.ceiling : b.points - a.points);
  const heading = byId("fdResultsHeading");
  const slateName = loadedLiveSlate?.name || importedSlateName;
  heading.textContent = slateName ? "Lineups · "+slateName : "Lineups";
  status.textContent = lineups.length ? "Built "+lineups.length+" of "+requested+" requested lineups. Ranked by "+(highCeiling ? "total ceiling estimates." : "total projected points.") :
    "No valid lineup found. Check projections, locks, exclusions, and roster eligibility.";
  if (result.simulation) {
    const {scenarios,opponents,ownershipPlayers,fieldPlayers} = result.simulation;
    status.textContent = "Built "+lineups.length+" of "+requested+(" lineups. Selected for "+targetLabel(result.simulation.target)+" coverage across ")+
      scenarios+" scenarios against "+opponents+" simulated opponents. "+
      (ownershipPlayers ? "Projected ownership influenced the field for "+ownershipPlayers+" of "+fieldPlayers+" eligible players." :
        "The field used projections and random variation. Import projected ownership to factor in expected popularity.");
  }
  if (result.simulation && (["NBA","CFB"].includes(sport.value) || result.simulation.target==="top3")) {
    status.textContent += " Experimental model. Shares describe simulated outcomes only.";
  }
  if (sport.value==="CFB" && result.simulation && result.simulation.opponents<result.simulation.requestedOpponents) {
    status.textContent += " The model filled "+result.simulation.opponents+" of "+result.simulation.requestedOpponents+" requested opponents.";
  }
  if (result.simulation?.allTop10Coverage != null) {
    const sim=result.simulation;
    status.textContent += " All lineups finished in the top 10 in "+percent.format(sim.allTop10Coverage)+
      " of modeled contests; at least one lineup tied or reached first in "+percent.format(sim.firstPointsCoverage)+
      "; both happened in "+percent.format(sim.firstAndAllTop10Coverage)+".";
  }
  if (result.simulation?.top1Coverage != null) {
    status.textContent += " At least one lineup reached the top 1% in "+percent.format(result.simulation.top1Coverage)+
      " of selection scenarios (rank "+result.simulation.top1Places+" or better, ties included).";
  }
  if (result.simulation?.top3Coverage != null) {
    status.textContent += " At least one lineup reached the top 3% in "+percent.format(result.simulation.top3Coverage)+
      " of selection scenarios (rank "+result.simulation.top3Places+" or better, ties included).";
  }
  if (result.simulation?.coverage != null && result.simulation.target!=="top3") status.textContent += " At least one lineup reached the top 20 in "+percent.format(result.simulation.coverage)+" of selection scenarios.";
  if (Number.isInteger(result.simulation?.balancedTeams)) {
    status.textContent += " Teams with enough rotation data for shared minutes: "+result.simulation.balancedTeams+".";
  }
  const comparison=result.simulation?.comparison;
  if (result.restriction) status.textContent += " " + result.restriction;
  if (result.exactFirst) status.textContent += " Top lineup maximizes projected points under your current rules.";
  refine.hidden = !result.limited || depth.value === "deep" || mode.value !== "gpp";
  if (result.limited) status.textContent += result.exactFirst ? " Additional lineup searches reached their limit." :
    " The search reached its limit. A better lineup or additional alternatives may exist.";
  if (lastRemoval) {
    const {player,previousLineup} = lastRemoval;
    const summary = removalSummary(player,previousLineup,lineups[0]);
    byId("fdRemovalStatus").textContent = summary;
    status.textContent += " " + summary;
  }
  const output = byId("fdResults");
  if (comparison) {
    const panel=document.createElement("section");
    const heading=document.createElement("h3");
    heading.textContent="Tournament vs. projected points";
    const table=document.createElement("table");
    table.createCaption().textContent="Best finish per portfolio across "+comparison.scenarios+" separate simulated contests. Ties count.";
    const headers=table.createTHead().insertRow();
    for (const label of ["Portfolio","First","Top 20","Top 3%"]) {
      const cell=document.createElement("th");
      cell.scope="col";
      cell.textContent=label;
      headers.append(cell);
    }
    const body=table.createTBody();
    for (const [label,firsts,hits,top3] of [
      ["Tournament",comparison.tournamentFirsts,comparison.tournamentHits,comparison.tournamentTop3],
      ["Projected points",comparison.projectionFirsts,comparison.projectionHits,comparison.projectionTop3]
    ]) {
      const row=body.insertRow();
      const name=document.createElement("th");
      name.scope="row";
      name.textContent=label;
      row.append(name);
      row.insertCell().textContent=firsts??"Unavailable";
      row.insertCell().textContent=hits;
      row.insertCell().textContent=top3??"Unavailable";
    }
    panel.append(heading,table);
    if (comparison.batches?.length) {
      const batches=comparison.batches;
      const top3=result.simulation.target==="top3";
      const counts=batch=>top3 ? [batch.tournamentTop3,batch.projectionTop3] : [batch.tournamentHits,batch.projectionHits];
      const pairs=batches.map(counts);
      const ahead=pairs.filter(([a,b])=>a>b).length;
      const tied=pairs.filter(([a,b])=>a===b).length;
      const summary=document.createElement("p");
      summary.textContent=(top3 ? "Top-3%" : "Top-20")+" comparison across "+batches.length+" batches of "+batches[0].scenarios+
        " simulated slates against the same field: tournament ahead in "+ahead+", tied in "+tied+
        ", behind in "+(batches.length-ahead-tied)+".";
      panel.append(summary);
    }
    output.append(panel);
  }
  if (result.highestProjected) {
    const best = result.highestProjected;
    const panel = document.createElement("details");
    const title = document.createElement("summary");
    title.textContent = "Highest projected lineup · "+best.points.toFixed(2)+" FPTS · "+dollars.format(best.salary);
    const list = document.createElement("ul");
    for (const {slot,player} of [...best.picks].sort((a,b)=>a.slot-b.slot)) {
      const item = document.createElement("li");
      item.textContent = profiles.NBA.roster[slot][0]+" · "+player.name+" · "+player.points.toFixed(2)+" FPTS";
      list.append(item);
    }
    panel.append(title,list);
    output.append(panel);
  }
  bulkPanel.hidden=!lineups.length;
  updateBulkExport();
  if (lineups.length > 1) output.append(compareLineups(highCeiling,result.simulation));
  for (const [index,lineup] of lineups.entries()) {
    const details = document.createElement("details");
    details.className = "lineup-card";
    details.id = "fdLineup"+(index+1);
    details.open = index === 0;
    const summary = document.createElement("summary");
    const total = lineup.points.toFixed(2);
    const projected = document.createElement("strong");
    projected.textContent = total;
    const label = document.createElement("span");
    label.className = "lineup-name";
    label.textContent = "Lineup "+(index+1);
    const value = document.createElement("span");
    value.className = "lineup-value";
    const units = document.createElement("small");
    units.textContent = "Projected FPTS";
    value.append(projected,units);
    const meta = document.createElement("span");
    meta.className = "lineup-meta";
    meta.textContent = dollars.format(lineup.salary)+" used · "+dollars.format(profiles[sport.value].salaryCap-lineup.salary)+" remaining";
    const historical = lineup.picks.filter(({player}) => player.source === "FanDuel FPPG").length;
    const uncertain = lineup.picks.filter(({player}) => uncertainAvailability(player.status));
    if (historical) meta.append(" · "+historical+" using historical FPPG");
    if (uncertain.length) meta.append(" · Status to check: "+uncertain.map(({player}) => player.name).join(", "));
    if (highCeiling) meta.append(" · "+lineup.ceiling.toFixed(2)+" summed ceiling FPTS");
    if (lineup.tournament?.top20 != null) meta.append(" · "+percent.format(lineup.tournament.top20)+" modeled top 20");
    if (lineup.tournament) {
      const {top,top3,win,ceiling,duplicates} = lineup.tournament;
      if (sport.value==="CFB" && lineup.tournament.top1 != null) {
        meta.append(" · "+percent.format(lineup.tournament.top1)+" modeled top-1% share");
      }
      if (top3 != null) meta.append(" · "+percent.format(top3)+" modeled top-3% share");
      meta.append(" · "+percent.format(win)+" modeled win · "+percent.format(top)+" modeled top-10% · "+ceiling.toFixed(1)+" simulated 90th percentile · "+duplicates+" field duplicates");
    }
    summary.append(label,value,meta);
    const wrapper = document.createElement("div");
    wrapper.className = "tablewrap";
    const table = document.createElement("table");
    const headings = table.createTHead().insertRow();
    for (const label of ["Slot","Player","Team","Salary","Projected FPTS"]) {
      const heading = document.createElement("th");
      heading.scope = "col";
      heading.textContent = label;
      headings.append(heading);
    }
    const body = table.createTBody();
    for (const {slot,player} of lineup.picks) {
      const row = body.insertRow();
      for (const value of [profiles[sport.value].roster[slot][0],player.name,player.team,dollars.format(player.salary),player.points.toFixed(2)]) {
        row.insertCell().textContent = value;
      }
      const remove = document.createElement("button");
      remove.type = "button";
      remove.className = "remove-player";
      remove.textContent = "Remove";
      remove.setAttribute("aria-label","Remove "+player.name+" and rebuild for projected points");
      remove.addEventListener("click",() => {
        removePlayer(player.id,lineup);
        byId("fdUndoRemoval").focus();
      });
      row.cells[1].append(remove);
    }
    const totals = table.createTFoot().insertRow();
    const totalLabel = document.createElement("th");
    totalLabel.scope = "row";
    totalLabel.colSpan = 3;
    totalLabel.textContent = "Lineup total";
    totals.append(totalLabel);
    totals.insertCell().textContent = dollars.format(lineup.salary);
    totals.insertCell().textContent = total;
    wrapper.append(table);
    details.append(summary,wrapper);
    const card=document.createElement("div");
    card.className="lineup-export-row";
    const picker=document.createElement("label");
    picker.className="lineup-export-check";
    const checkbox=document.createElement("input");
    checkbox.type="checkbox";
    checkbox.setAttribute("aria-label","Select lineup "+(index+1)+" for FanDuel export");
    checkbox.addEventListener("change",()=>{
      if (checkbox.checked) checkedLineups.add(lineup);
      else checkedLineups.delete(lineup);
      if (checkedLineups.size) bulkPanel.open=true;
      updateBulkExport();
    });
    picker.append(checkbox);
    card.append(picker,details);
    output.append(card);
  }
  if (lineups.length > 1) {
    const exposureByPlayer = new Map();
    for (const lineup of lineups) {
      for (const {player} of lineup.picks) {
        const entry = exposureByPlayer.get(player.id) ?? {player,count:0};
        entry.count++;
        exposureByPlayer.set(player.id,entry);
      }
    }
    const portfolio = document.createElement("details");
    const summary = document.createElement("summary");
    summary.textContent = "Portfolio exposure and ownership · "+lineups.length+" lineups";
    const list = document.createElement("ul");
    const entries = [...exposureByPlayer.values()].sort((a,b) => b.count-a.count || a.player.name.localeCompare(b.player.name));
    const percentage = new Intl.NumberFormat("en-US",{style:"percent",maximumFractionDigits:1});
    for (const {player,count} of entries) {
      const item = document.createElement("li");
      const exposure = count/lineups.length;
      const leverage = (exposure-player.ownership)*100;
      const ownership = Number.isFinite(player.ownership) ?
        " · Field " + percentage.format(player.ownership) + " · " +
        (leverage > 0 ? "+" : "") + leverage.toFixed(1) + " pp vs. field" : " · Field ownership unavailable";
      item.textContent = player.name+" ("+player.team+") · Exposure "+percentage.format(exposure)+
        " ("+count+"/"+lineups.length+")"+ownership;
      list.append(item);
    }
    const overlap = document.createElement("p");
    let sharedTotal = 0;
    let mostShared = 0;
    let comparisons = 0;
    for (const [index,lineup] of lineups.entries()) {
      for (const previous of lineups.slice(0,index)) {
        const shared = [...lineup.ids].filter(id => previous.ids.has(id)).length;
        sharedTotal += shared;
        mostShared = Math.max(mostShared,shared);
        comparisons++;
      }
    }
    if (comparisons) overlap.textContent = "Lineup overlap: " + (sharedTotal/comparisons).toFixed(1) +
      " shared players on average · highest " + mostShared + ".";
    portfolio.append(summary,overlap,list);
    output.append(portfolio);
  }
  const preflight=byId("fdExportCheck");
  preflight.replaceChildren();
  if (lineups.length) {
    const audit=summarizeReviewExport(lineups);
    const duplicates=lineups.length-audit.distinct;
    const heading=document.createElement("strong");
    heading.textContent="Review CSV · "+audit.distinct+" distinct rosters across "+lineups.length+" lineups";
    const details=document.createElement("p");
    details.textContent=(duplicates ? duplicates+" repeated "+(duplicates===1?"entry. ":"entries. ") : "")+
      "Inputs for "+audit.players+" distinct players:";
    const sources=document.createElement("ul");
    for (const [source,count] of audit.sources) {
      const item=document.createElement("li");
      const dates=audit.datedBySource.get(source) || [];
      const oldest=dates.length ? Math.min(...dates) : null;
      const freshness=dates.length ? "oldest update "+new Date(oldest).toLocaleString()+
        (dates.length<count ? " · "+(count-dates.length)+" update times unknown" : "") :
        source==="FanDuel FPPG" ? "historical average; as-of time unknown" : "update time unknown";
      item.textContent=source+" · "+count+" · "+freshness;
      sources.append(item);
    }
    preflight.append(heading,details,sources);
    if ([...audit.sources].some(([source,count])=>source==="Projection CSV" && (audit.datedBySource.get(source)?.length || 0)<count)) {
      const hint=document.createElement("p");
      hint.textContent="To track freshness, include Projection Updated At in your projection CSV with an ISO timestamp such as 2026-11-25T08:00:00-08:00.";
      preflight.append(hint);
    }
  }
  exportButton.disabled = !lineups.length;
  showEntryCheck();
}

async function buildCurrentLineups(news=null) {
  if (sport.value==="NFL") {
    clearLineups();
    build.disabled=true;
    byId("fdResultsPanel").hidden=false;
    byId("fdBuildStatus").textContent="Checking current NFL injuries…";
    try { await verifyNFLInjuries(); }
    catch(error) { injuryBlocked(error); return; }
    finally { build.disabled=false; }
  }
  return buildVerifiedLineups(news);
}
function buildVerifiedLineups(news=null) {
  news=news?.original ? news : null;
  if (slateLockAt && slateLockAt <= Date.now()) {
    clearLineups();
    byId("fdStatus").textContent = "The automatically loaded slate has reached its first game start. Load another available pool or import a different contest.";
    return;
  }
  const gpp = mode.value === "gpp";
  const candidates = poolForBuild().filter(p=>p.selection!=="exclude");
  const {warnings} = checkSlate(candidates,profiles[sport.value],sport.value);
  if (warnings.length) {
    clearLineups();
    byId("fdResultsPanel").hidden = false;
    byId("fdBuildStatus").textContent = warnings.join(" ");
    return;
  }
  if (gpp && (!count.reportValidity() || !difference.reportValidity() || !exposure.reportValidity())) return;
  clearLineups();
  byId("fdResultsPanel").hidden = false;
  byId("fdBuildStatus").textContent = "Building lineups…";
  build.disabled = true;
  const requested = gpp ? count.valueAsNumber : 1;
  const finish = () => {
    optimizer?.terminate();
    optimizer = undefined;
    byId("fdCancel").hidden = true;
    build.disabled = false;
  };
  const highCeiling = objective.value === "ceiling";
  const tournament = gpp && tournamentSports.includes(sport.value) && objective.value === "tournament";
  if (tournament && sport.value==="NBA" && !byId("fdFieldSize").reportValidity()) return finish();
  if (tournament && sport.value==="CFB") {
    if (jointTargets.includes(byId("fdTarget").value) && requested>10) {
      byId("fdBuildStatus").textContent="Choose up to 10 lineups for the all-top-10 target.";
      return finish();
    }
    const issues=cfbMatchupIssue(candidates.filter(p=>Number.isFinite(p.points) && !unavailable(p.status)));
    if (issues) {
      byId("fdBuildStatus").textContent = issues;
      return finish();
    }
  }
  if (tournament) byId("fdBuildStatus").textContent = "Building lineup candidates and simulating tournament outcomes…";
  if (highCeiling && !players.some(player => player.selection !== "exclude" && Number.isFinite(player.ceiling))) {
    byId("fdBuildStatus").textContent = "High Ceiling needs a numeric Ceiling column matched to players in this slate.";
    return finish();
  }
  const activeWorker = new Worker("/fanduel-worker.js",{type:"module"});
  optimizer = activeWorker;
  const options = {target:byId("fdTarget").value,fieldSize:Number(byId("fdFieldSize").value),exactFirst:objective.value === "projection",
    exposure:gpp ? exposure.valueAsNumber : 100,stack:byId("fdFootballStack").hidden ? 0 : Number(stack.value)};
  if (news && tournament && sport.value==="NBA") options.originalIds=news.original.lineups.map(roster=>roster.map(p=>p.id));
  buildProgress = {lineups:[],limited:false,requested,highCeiling,tournament,exactFirst:options.exactFirst};
  byId("fdCancel").hidden = false;
  activeWorker.addEventListener("message",({data}) => {
    if (optimizer !== activeWorker) return;
    if (data.progress) {
      buildProgress.lineups.push(data.progress);
      buildProgress.limited = data.limited;
      const completed = buildProgress.lineups.length;
      byId("fdBuildStatus").textContent = completed === requested && tournament ?
        "Ranking the completed lineups against modeled opponents…" :
        "Building lineups… "+completed+" of "+requested+" complete.";
      return;
    }
    finish();
    buildProgress = undefined;
    if (slateLockAt && slateLockAt <= Date.now()) {
      byId("fdBuildStatus").textContent = "The slate reached its first game start during the search.";
    } else if (data.error) byId("fdBuildStatus").textContent = data.error;
    else {
      renderLineups(data,requested,highCeiling);
      if (loadedLiveSlate && lineups.length && slateLockAt > Date.now()) saveBuildHistory(data.baseline,data.ownershipForecast,data.simulation?.comparison,news,data.simulation?.newsComparison);
      if (cfbCapture && lineups.length===requested && data.lineups.length===requested && data.baseline?.length===requested) {
        try {
          const snapshot=makeCfbSnapshot(cfbCapture,payload,data,Date.now());
          saveCfbSnapshot(localStorage,snapshot);
          byId("fdHistoryStatus").textContent="Paired pre-lock CFB snapshot saved on this device.";
          byId("fdCfbSnapshotDownload").hidden=false;
        } catch {
          byId("fdHistoryStatus").textContent="The paired CFB snapshot could not be saved on this device.";
        }
      }
      if (news) showNewsComparison(news,data.simulation?.newsComparison);
    }
  });
  activeWorker.addEventListener("error",() => {
    if (optimizer !== activeWorker) return;
    finish();
    buildProgress = undefined;
    byId("fdBuildStatus").textContent = "The lineup builder could not start.";
  });
  const pool = gpp ? candidates : candidates.map(player => ({...player,maxExposure:100}));
  const payload={players:pool,highCeiling,tournament,count:requested,difference:gpp ? difference.valueAsNumber : 1,
    sport:sport.value,deep:gpp && depth.value === "deep",options};
  const cfbCapture=tournament && payload.sport==="CFB" && loadedLiveSlate && Number.isFinite(slateLockAt) ? {
    startedAt:Date.now(),lockAt:slateLockAt,slateId:String(loadedLiveSlate.id),slate:loadedLiveSlate.name,
    excluded:poolForBuild().filter(player=>player.selection==="exclude")
  } : null;
  activeWorker.postMessage(payload);
}
refine.addEventListener("click",() => {
  depth.value = "deep";
  byId("fdDepthHint").hidden = false;
  buildCurrentLineups();
});
byId("fdCancel").addEventListener("click",() => {
  const completed = buildProgress;
  clearLineups();
  byId("fdResultsPanel").hidden = false;
  const status = byId("fdBuildStatus");
  if (completed?.lineups.length && !(slateLockAt && slateLockAt <= Date.now())) {
    renderLineups(completed,completed.requested,completed.highCeiling);
    status.textContent = "Build canceled. "+status.textContent+
      (completed.tournament ? " Tournament simulation stopped before ranking." : "");
    exportButton.focus();
  } else {
    status.textContent = "Build canceled. Your slate and player selections are ready for another build.";
    build.focus();
  }
});

function showBuildResults() {
  const panel = byId("fdResultsPanel");
  if (!panel.hidden) panel.scrollIntoView({block:"start"});
}

build.addEventListener("click",event => {
  buildCurrentLineups();
  if (event.isTrusted) showBuildResults();
});

function updateLiveProjections(text) {
  const slate = loadedLiveSlate;
  const baseline = players.map(player => {
    const {points,ceiling,ownership,source,projectionUpdatedAt} = slate.baseline.get(player.id);
    return {...player,points,ceiling,ownership,source,projectionUpdatedAt};
  });
  const result = applyPlayerProjections(baseline,text,sport.value,{date:slate.date});
  players = result.players;
  for (const player of players) {
    if (player.selection === "lock" && !Number.isFinite(player.points)) player.selection = "available";
  }
  slate.projectionText = text;
  clearRemoval();
  clearLineups();
  renderPlayers();
  buildCurrentLineups();
  return result.matched;
}

liveProjections.addEventListener("change",async () => {
  const current = loadedLiveSlate;
  const file = liveProjections.files[0];
  if (!current || !file) return;
  try {
    if (file.size > 5_000_000) throw new Error("Use a CSV under 5 MB.");
    const text = await file.text();
    if (loadedLiveSlate !== current || liveProjections.files[0] !== file) return;
    if (!text.trim()) throw new Error("The projections CSV is empty.");
    const matched = updateLiveProjections(text);
    liveProjectionStatus.textContent = "Custom projections matched "+matched+" of "+players.length+" players.";
  } catch (error) {
    if (loadedLiveSlate === current) liveProjectionStatus.textContent = error.message;
  }
});

restoreLiveProjections.addEventListener("click",() => {
  liveProjections.value = "";
  updateLiveProjections("");
  liveProjectionStatus.textContent = "Live slate projections restored.";
});

async function loadPublicPool(listOnly = false,savedPool = null) {
  const previousId = liveSlate.value;
  if (!listOnly && !previousId) return;
  if (listOnly) {
    liveSlate.disabled = true;
    liveSlate.replaceChildren(new Option("Looking for slates…",""));
  }
  autoRequest?.abort();
  const request = new AbortController();
  autoRequest = request;
  autoLoad.disabled = true;
  byId("fdStatus").textContent = listOnly ? "Looking for upcoming FanDuel slates…" : "Loading the selected FanDuel slate…";
  const timeout = setTimeout(()=>request.abort(),25000);
  try {
    const query = new URLSearchParams({sport:sport.value});
    if (listOnly) query.set("list","1");
    else query.set("slate",previousId);
    let data = savedPool;
    if (!data) {
      const response = await fetch("/api/nba/fanduel?"+query,{signal:request.signal});
      data = await response.json();
      if (!response.ok) throw new Error(data.error || "No public FanDuel player pool is available.");
    }
    if (autoRequest !== request || request.signal.aborted) return;
    if (listOnly) {
      if (!data.slates?.length) throw new Error("No upcoming Classic slates are available. You can import a FanDuel contest CSV.");
      listedSlates = data.slates;
      liveSlate.replaceChildren(new Option("Choose a slate",""),...data.slates.map(slate => new Option(
        [slate.label,slate.lockAt && new Date(slate.lockAt).toLocaleString(),
          slate.games && slate.games+" games"].filter(Boolean).join(" · "),slate.id)));
      if (data.slates.some(slate => slate.id === previousId)) liveSlate.value = previousId;
      liveSlate.disabled = false;
      if (automatic.checked && !importedSlateName) {
        const choice = automaticSlateChoice(data.slates,sport.value,previousId);
        if (choice.slate) {
          liveSlate.value = String(choice.slate.id);
          return loadPublicPool();
        }
        if (choice.message) {
          liveSlate.value = "";
          const resumeAt = Date.now()+30*60000;
          const message = choice.message+" Automatic recheck after "+new Date(resumeAt).toLocaleTimeString()+".";
          if (!loadedLiveSlate) writeSession({resumeAt,message});
          byId("fdStatus").textContent = loadedLiveSlate ? choice.message : message;
          return;
        }
      }
      byId("fdStatus").textContent = "Choose the slate that matches your FanDuel contest, then build.";
      return;
    }
    if (!Array.isArray(data.players) || !(data.lockAt > Date.now())) throw new Error("The public pool has expired.");
    if (!savedPool) {
      const nextDay = new Date(data.lockAt);
      nextDay.setHours(24,0,0,0);
      writeSession({id:previousId,data,slates:listedSlates,resumeAt:nextDay.getTime()});
    }
    const sameSlate = loadedLiveSlate?.id === previousId;
    const priorSelections = new Map(sameSlate ? players.map(player => [player.id,player]) : []);
    const publishedAt=data.projectionCoverage?.updatedAt ?? (data.poolType==="public preview" ? data.updatedAt : null);
    let selectedPlayers=data.players.map(player=>({...player,projectionUpdatedAt:
      player.source==="Daily Fantasy Fuel" && Number.isFinite(Date.parse(publishedAt)) ? new Date(publishedAt).toISOString() : null}));
    const baseline=new Map(selectedPlayers.map(player=>[player.id,{...player}]));
    let projectionText = sameSlate ? loadedLiveSlate.projectionText : "";
    liveProjectionStatus.textContent = "";
    if (projectionText) {
      try {
        const result = applyPlayerProjections(selectedPlayers,projectionText,sport.value,{date:data.date});
        selectedPlayers = result.players;
        liveProjectionStatus.textContent = "Custom projections matched "+result.matched+" of "+selectedPlayers.length+" players.";
      } catch {
        projectionText = "";
        liveProjectionStatus.textContent = "Custom projections did not match this refresh. Live slate estimates are in use.";
      }
    }
    if (!projectionText) liveProjections.value = "";
    const removedLocks = [];
    for (const player of selectedPlayers) {
      const previous = priorSelections.get(player.id);
      if (!previous) continue;
      player.maxExposure = previous.maxExposure;
      if (previous.selection === "lock" && (player.selection === "exclude" || !Number.isFinite(player.points))) {
        removedLocks.push(player.name);
      } else if (player.selection !== "exclude" && !unavailable(previous.status)) {
        player.selection = previous.selection;
      }
    }
    clearLineups();
    clearRemoval();
    slateLockAt = data.lockAt;
    loadedLiveSlate = {id:previousId,updatedAt:data.updatedAt,date:data.date,name:data.label+" · "+data.date,baseline,projectionText};
    loadedSalaryFile = loadedSlateKey = undefined;
    importedSlateName = undefined;
    players = selectedPlayers;
    playerPage = 0;
    const updated = data.updatedAt ? " · updated "+new Date(data.updatedAt).toLocaleString() : "";
    const coverage = data.projectionCoverage;
    const injuries = data.injuryCoverage;
    const countSummary = sport.value === "NBA" && data.poolType === "salary feed" &&
      Number.isInteger(data.listedPlayerCount) ? " Player IDs matched the provider count ("+
        players.length+"/"+data.listedPlayerCount+")." : "";
    const estimateSummary = coverage ?
      " Daily Fantasy Fuel projections matched "+coverage.matched+" of "+coverage.eligible+
      " available players (updated "+new Date(coverage.updatedAt).toLocaleTimeString()+"). Other players use FanDuel FPPG when available." :
      data.poolType === "salary feed" ? " Uses historical FPPG." : " Uses the public preview, which may omit players.";
    byId("fdStatus").textContent = data.label+" · "+data.date+" · "+players.length+" players across "+data.gameCount+
      " games · "+data.provider+updated+". First listed game: "+new Date(data.lockAt).toLocaleString()+"."+countSummary+estimateSummary+
      (injuries ? " ESPN injury updates excluded "+injuries.excluded+" additional players." : "")+
      (removedLocks.length ? " Unlocked after refresh: "+removedLocks.join(", ")+".": "");
    byId("fdStatus").textContent += " Using this snapshot until lock. Load slate and build refreshes salary and projection data.";
    byId("fdPool").hidden = false;
    if (sport.value==="NBA" && objective.value!=="ceiling") {
      const current = loadedLiveSlate;
      await refreshNBAContext(current,true);
      if (autoRequest!==request || current!==loadedLiveSlate || request.signal.aborted) return;
    }
    renderPlayers();
    buildCurrentLineups();
  } catch (error) {
    if (autoRequest !== request) return;
    byId("fdStatus").textContent = request.signal.aborted ? "Automatic slate loading timed out. You can import a FanDuel CSV." :
      error.message || "Automatic slate loading is unavailable.";
    if (listOnly) liveSlate.replaceChildren(new Option("No live slates loaded",""));
    if (!players.length) byId("fdManualImport").open = true;
  } finally {
    clearTimeout(timeout);
    if (autoRequest === request) {
      autoRequest = undefined;
      autoLoad.disabled = !liveSlate.value;
    }
  }
}
function applySport() {
  if (bulkTemplate && bulkTemplate.sport!==sport.value) {
    bulkFile.value="";
    clearBulkTemplate();
  }
  const profile = profiles[sport.value];
  byId("fdNflCsvSource").hidden = sport.value !== "NFL";
  byId("fdCfbCsvSource").hidden = sport.value !== "CFB";
  byId("fdRules").textContent = dollars.format(profile.salaryCap)+" cap · "+profile.roster.map(([slot])=>slot).join(", ");
  byId("fdTeamRules").textContent = "Lock or exclude players before building. Use at least three teams and at most "+
    profile.maxTeam+" players per team"+(profile.maxHitters ? ", including at most "+profile.maxHitters+" hitters" : "")+
    ". Check current player availability before using a lineup.";
  const positions = [...new Set(profile.roster.flatMap(([,eligible]) => eligible))];
  positionFilter.replaceChildren(new Option("All positions",""),
    ...positions.map(position => new Option(position,position)));
  difference.max = profile.roster.length;
  difference.value = Math.min(difference.valueAsNumber || 2,profile.roster.length);
}
autoLoad.addEventListener("click",() => loadPublicPool());
refreshSlates.addEventListener("click",() => loadPublicPool(true));
liveSlate.addEventListener("change",() => {
  autoRequest?.abort();
  autoRequest = undefined;
  autoLoad.disabled = !liveSlate.value;
  if (automatic.checked && liveSlate.value) {
    loadPublicPool();
    return;
  }
  const selected = liveSlate.value;
  const current = loadedLiveSlate?.name || importedSlateName;
  const selectedMessage = selected ? "Tap Load slate and build to use this selection." : "Choose a slate.";
  byId("fdStatus").textContent = selectedMessage+
    (current ? " Currently loaded: "+current+"." : "");
});
sport.addEventListener("change",() => {
  autoRequest?.abort();
  autoRequest = undefined;
  clearRemoval();
  players = [];
  slateLockAt = null;
  loadedLiveSlate = undefined;
  importedSlateName = undefined;
  search.value = selectionFilter.value = "";
  playerPage = 0;
  resetImport();
  clearLineups();
  byId("fdPool").hidden = true;
  applySport();
  byId("fdTarget").value=tournamentTargets[sport.value] ?? "first";
  if (sport.value==="CFB") objective.value="projection";
  applyMode();
  liveSlate.value = "";
  listedSlates = [];
  startAutomaticSession();
});
function applyMode() {
  const cash = mode.value === "cash";
  const tournament = objective.querySelector('option[value="tournament"]');
  tournament.disabled = tournament.hidden = cash || !tournamentSports.includes(sport.value);
  byId("fdTargetLabel").hidden = tournament.disabled || objective.value!=="tournament";
  const target=byId("fdTarget");
  for (const value of jointTargets) {
    const option=target.querySelector('option[value="'+value+'"]');
    option.disabled=option.hidden=sport.value!=="CFB";
    if (option.disabled && target.value===value) target.value=tournamentTargets[sport.value] ?? "first";
  }
  const topOne=target.querySelector('option[value="top1"]');
  topOne.disabled=topOne.hidden=sport.value!=="CFB";
  if (topOne.disabled && target.value==="top1") target.value=tournamentTargets[sport.value] ?? "first";
  const nbaOnly=target.querySelector('option[value="top20"]');
  nbaOnly.disabled=nbaOnly.hidden=sport.value!=="NBA";
  if (nbaOnly.disabled && target.value==="top20") target.value="first";
  byId("fdFieldLabel").hidden = cash || sport.value!=="NBA" || objective.value!=="tournament";
  if (tournament.disabled && objective.value === "tournament") objective.value = "projection";
  for (const label of document.querySelectorAll("[data-gpp]")) label.hidden = cash;
  byId("fdFootballStack").hidden = cash || !["NFL","CFB"].includes(sport.value);
  byId("fdExposureHint").hidden = cash;
  byId("fdDepthHint").hidden = cash || depth.value !== "deep";
  build.textContent = cash ? "Build cash lineup" : "Build GPP lineups";
  clearLineups();
  if (players.length) renderSlateCheck();
}
objective.addEventListener("change",applyMode);
byId("fdTarget").addEventListener("change",event=>{
  tournamentTargets[sport.value]=event.target.value;
  clearLineups();
});
byId("fdFieldSize").addEventListener("change",clearLineups);
mode.addEventListener("change",() => {
  applyMode();
  renderPlayers();
});
applySport();
applyMode();
showSavedSlate();
startAutomaticSession();

function resetPlayerPage() {
  playerPage = 0;
  renderPlayerRows();
}
search.addEventListener("input",resetPlayerPage);
for (const filter of [positionFilter,selectionFilter,playerSort]) {
  filter.addEventListener("change",resetPlayerPage);
}
previousPlayers.addEventListener("click",() => {
  playerPage--;
  renderPlayerRows();
  if (previousPlayers.disabled) nextPlayers.focus();
});
nextPlayers.addEventListener("click",() => {
  playerPage++;
  renderPlayerRows();
  if (nextPlayers.disabled) previousPlayers.focus();
});
count.addEventListener("change",applyMode);
difference.addEventListener("change",applyMode);
exposure.addEventListener("change",applyMode);
stack.addEventListener("change",applyMode);
depth.addEventListener("change",applyMode);
avoidQuestionable.addEventListener("change",() => {
  clearLineups();
  renderSlateCheck();
});
function downloadCSV(csv,filename) {
  const url=URL.createObjectURL(new Blob([csv],{type:"text/csv;charset=utf-8"}));
  const download=document.createElement("a");
  download.href=url;
  download.download=filename;
  download.click();
  setTimeout(()=>URL.revokeObjectURL(url),1000);
}

function updateBulkExport() {
  const contest=bulkTemplate?.contests.get(bulkContest.value);
  const selected=checkedLineups.size;
  bulkButton.disabled=bulkBusy || !contest || !selected || selected>contest.entries.length;
  const empty=contest?.entries.filter(entry=>!entry.occupied).length ?? 0;
  const replaced=Math.max(0,selected-empty);
  bulkStatus.textContent=selected+" lineup"+(selected===1 ? "" : "s")+" checked."+
    (contest ? " "+contest.entries.length+" entries in the selected contest." : "")+
    (contest && selected>contest.entries.length ? " Check fewer lineups." :
      contest && replaced ? " This export replaces "+replaced+" existing lineup"+(replaced===1 ? "." : "s.") : "");
}

function clearBulkTemplate() {
  bulkTemplate=undefined;
  bulkContest.replaceChildren(new Option("Choose a contest",""));
  bulkContest.disabled=true;
  updateBulkExport();
}

bulkFile.addEventListener("change",async()=>{
  const file=bulkFile.files[0];
  const selectedSport=sport.value;
  clearBulkTemplate();
  if (!file) return;
  try {
    const source=await file.text();
    if (bulkFile.files[0]!==file || sport.value!==selectedSport) return;
    bulkTemplate=readFanDuelEntries(source,selectedSport);
    for (const [id,contest] of bulkTemplate.contests) {
      bulkContest.add(new Option(contest.name+" · "+contest.entries.length+" entries",id));
    }
    if (bulkTemplate.contests.size===1) bulkContest.selectedIndex=1;
    bulkContest.disabled=false;
    updateBulkExport();
  } catch (error) {
    if (bulkFile.files[0]===file && sport.value===selectedSport) bulkStatus.textContent=error.message;
  }
});
bulkContest.addEventListener("change",updateBulkExport);
bulkButton.addEventListener("click",async()=>{
  const selected=lineups.filter(lineup=>checkedLineups.has(lineup));
  const built=lineups;
  const template=bulkTemplate;
  const contestId=bulkContest.value;
  bulkBusy=true;
  updateBulkExport();
  let message;
  try {
    if (Number.isFinite(slateLockAt) && slateLockAt<=Date.now()) throw new Error("This slate has locked.");
    const result=fillFanDuelEntries(template,contestId,selected);
    if (template.sport==="NFL") await verifyNFLInjuries();
    if (built!==lineups || template!==bulkTemplate || contestId!==bulkContest.value ||
        selected.length!==checkedLineups.size || selected.some(lineup=>!checkedLineups.has(lineup))) return;
    if (Number.isFinite(slateLockAt) && slateLockAt<=Date.now()) throw new Error("This slate has locked.");
    const eligible=new Set(poolForBuild().filter(player=>player.selection!=="exclude").map(player=>player.id));
    if (selected.some(lineup=>lineup.picks.some(({player})=>!eligible.has(player.id)))) {
      throw new Error("A checked lineup contains a player now held out. Rebuild before exporting.");
    }
    downloadCSV(result.csv,"fanduel-"+contestId+"-lppe-entries.csv");
    message="Downloaded "+result.count+" "+(result.count===1 ? "entry" : "entries")+". Upload the file in FanDuel → Upcoming → CSV Edit.";
  } catch (error) {
    if (built===lineups && template===bulkTemplate && contestId===bulkContest.value) message=error.message;
  } finally {
    bulkBusy=false;
    updateBulkExport();
    if (message) bulkStatus.textContent=message;
  }
});

exportButton.addEventListener("click",async () => {
  if (sport.value==="NFL") {
    exportButton.disabled=true;
    try {
      await verifyNFLInjuries();
      const eligible = new Set(poolForBuild().filter(p=>p.selection!=="exclude").map(p=>p.id));
      if (lineups.some(l=>l.picks.some(({player})=>!eligible.has(player.id)))) throw new Error("A lineup contains a player now held out. Rebuild.");
    } catch(error) { injuryBlocked(error); return; }
    finally { exportButton.disabled=!lineups.length; }
  }
  if (!lineups.length) return;
  downloadCSV(reviewCSV(lineups,sport.value),"fanduel-"+sport.value.toLowerCase()+"-lineups-review.csv");
});

byId("fdSpreadFive").addEventListener("click",() => {
  count.value = "20";
  exposure.value = "80";
  difference.value = "3";
  applyMode();
  byId("fdBuildStatus").textContent = "Ready to build 20 lineups with at least three different players per pair and a 16-lineup cap per unlocked player.";
});

byId("fdContestReview").addEventListener("submit",async event => {
  event.preventDefault();
  const output = byId("fdContestResult");
  const file = byId("fdLeaderboard").files[0];
  const username = byId("fdReviewUser").value.trim();
  if (!file) return;
  try {
    const rows = parseCSV(await file.text());
    const result = reviewContest(rows,username);
    output.textContent = "Field: "+result.entries.toLocaleString()+" entries."+
      (result.cutoff===null ? "" : " Top-20 cutoff: "+result.cutoff.toFixed(2)+".");
    if (result.top3) {
      const {top3Places,bestRank,bestPercentile,top3Count,top3Rate}=result.top3;
      output.append(top3Places ? " Top 3% includes rank "+top3Places+" or better." : " The field has fewer than 34 scored entries.");
      if (result.top3Cutoff!==null) output.append(" Top-3% cutoff: "+result.top3Cutoff.toFixed(2)+" FPTS.");
      if (bestRank!==null) output.append(" Best rank "+bestRank+" (top "+bestPercentile.toFixed(2)+"%). "+
        top3Count+" of "+result.userEntries+" entries reached the top 3% ("+percent.format(top3Rate)+").");
    } else output.append(" Top-3% review requires a complete, finalized leaderboard.");
    if (result.winningScore!==null) output.append(" Winning score: "+result.winningScore.toFixed(2)+".");
    if (result.userEntries) {
      if (result.winningScore!==null) output.append(" First-place finishes: "+result.wins+". Gap to first: "+Math.max(0,result.winningScore-result.best).toFixed(2)+".");
      output.append(" "+username+" placed "+result.top20Entries+" of "+result.userEntries+
        " entries in the top 20. Best score: "+result.best.toFixed(2)+"."+
        (result.cutoff===null ? "" : " Points short: "+Math.max(0,result.cutoff-result.best).toFixed(2)+"."));
    } else if (username) output.append(" No entries matched "+username+".");
    // Historical audit only: never feed realized results into pre-lock projections.
    const field=rows.filter(row=>row.entryid);
    const handle=username.toLowerCase();
    const own=field.filter(row=>handle && row.entryname.replace(/\s*\(\d+\/\d+\)$/,"").trim().toLowerCase()===handle);
    const top=field.filter(row=>Number(row.rank)<=100);
    const roster=row=>[...new Set(Array.from((row.lineup||"").matchAll(/\((\d+-\d+)\)/g),m=>m[1]))].sort();
    const money=v=>v?.trim()?Number(v.replace(/[$,]/g,"")):NaN;
    const panel=document.createElement("details"), heading=document.createElement("summary");
    heading.textContent="Historical GPP audit · top 100 ranks";
    panel.open=true;panel.append(heading);
    const note=value=>{const p=document.createElement("p");p.textContent=value;panel.append(p);};
    const valid=group=>group.filter(row=>roster(row).length===9);
    const a=valid(top),b=valid(own);
    note("Roster coverage: "+a.length+"/"+top.length+" top-ranked entries; "+b.length+"/"+own.length+" personal entries. Ties at rank 100 included. Historical results are not forecasts.");
    if(b.length){
      const unique=new Set(b.map(row=>roster(row).join("|"))).size;
      note(unique+" distinct rosters; "+(b.length-unique)+" repeated entries beyond first copy.");
    }
    const fee=money(rows.find(row=>row.contestinfo==="Entry Fee")?.contestvalue);
    if(own.length && own.every(row=>Number.isFinite(money(row.won)))){
      const won=own.reduce((sum,row)=>sum+money(row.won),0);
      note("Cash rate: "+percent.format(own.filter(row=>money(row.won)>0).length/own.length)+"; payouts $"+won.toFixed(2)+(fee>0?" · entry cost $"+(fee*own.length).toFixed(2)+" · ROI "+percent.format(won/(fee*own.length)-1):""));
    }
    const counts=group=>{const map=new Map();for(const row of group)for(const id of roster(row))map.set(id,(map.get(id)||0)+1);return map;};
    const ac=counts(a),bc=counts(b),meta=new Map();
    for(const row of rows){const id=(row.player||"").match(/\((\d+-\d+)\)$/)?.[1];if(id)meta.set(id,row);}
    const table=document.createElement("table"),head=table.createTHead().insertRow();
    for(const label of ["Player","Top exposure","Your exposure","Field ownership","Top vs field (pp)","Actual FPTS/$1k"]){const th=document.createElement("th");th.textContent=label;head.append(th);}
    const body=table.createTBody();
    for(const [id,n] of [...ac].sort((x,y)=>y[1]-x[1]).slice(0,25)){
      const m=meta.get(id),salary=money(m?.salary),pts=money(m?.fpts);
      const tr=body.insertRow();
      for(const value of [m?.player?.replace(/\s*\(\d+-\d+\)$/,"")||id,percent.format(n/a.length),b.length?percent.format((bc.get(id)||0)/b.length):"—",m?.drafted||"—",m?.drafted && Number.isFinite(parseFloat(m.drafted)) ? (100*n/a.length-parseFloat(m.drafted)).toFixed(1) : "—",salary>0&&Number.isFinite(pts)?(pts*1000/salary).toFixed(2)+"x":"—"])tr.insertCell().textContent=value;
    }
    note("Complete nine-player rosters in field: "+valid(field).length+"/"+field.length+". Exposure uses complete rosters only; ownership uses the published field percentage.");
    const wrap=document.createElement("div");wrap.className="tablewrap";wrap.append(table);panel.append(wrap);output.append(panel);
    const archive=byId("fdReplayArchive").files[0];
    const imported=archive ? readNBAArchive(await archive.text()) : null;
    try {
      const records=imported ?? readBuildHistory();
      const replay = scoreSavedBuilds(rows,records,result.cutoff);
      let matchedForecast=false;
      for (const record of records) {
        const review=ownershipReview(rows,record.tournament);
        if (!review) continue;
        matchedForecast=true;
        const panel=document.createElement("details"),title=document.createElement("summary");
        title.textContent="Ownership forecast accuracy · "+review.players.length+" of "+review.forecastCount+" player IDs scored";
        panel.append(title);
        const coverage=document.createElement("p");
        coverage.textContent=(review.lockMatched ? "Contest start matches the saved lock." : "Contest start unknown in this export.")+
          " Positive bias means LPPE expected higher ownership than the field showed.";
        panel.append(coverage);
        for (const group of review.groups) {
          const note=document.createElement("p");
          note.textContent=group.name+" · "+group.mae.toFixed(1)+" pp mean absolute error · "+(group.bias>0?"+":"")+group.bias.toFixed(1)+" pp bias ("+group.count+" players)";
          panel.append(note);
        }
        const list=document.createElement("ul");
        for (const p of review.players) {
          const li=document.createElement("li");
          li.textContent=p.name+" · forecast "+p.predicted.toFixed(1)+"% · actual "+p.observed.toFixed(1)+"%";
          list.append(li);
        }
        panel.append(list);output.append(panel);
      }
      if (!matchedForecast) output.append(" No matching pre-lock ownership forecast was saved for this export.");
      const paired=pairHeldOut(rows,replay);
      if (paired) {
        const snapshot=records[paired.tournament.recordIndex]?.[paired.tournament.version];
        const ceilings=reviewPlayerCeilings(rows,snapshot);
        if (ceilings) {
          const panel=document.createElement("details"),title=document.createElement("summary");
          title.textContent="Player ceiling accuracy · first pre-lock build";
          const explanation=document.createElement("p");
          explanation.textContent="Share scoring above the simulated 90th percentile. Long-run reference: about 10%. Missing or conflicting results: "+ceilings.missing+".";
          panel.append(title,explanation);
          for (const group of ceilings.groups) {
            const note=document.createElement("p");
            note.textContent=group.label+" · "+group.above+" of "+group.total+" ("+percent.format(group.above/group.total)+")";
            panel.append(note);
          }
          output.append(panel);
        }
        const history=JSON.parse(localStorage.getItem("lppe-fd-top20-benchmark-v1") || "{}");
        const prior=history[paired.key];
        if (!prior || (prior.contest===paired.contest &&
            Date.parse(paired.tournament.capturedAt)<=Date.parse(prior.tournament.capturedAt))) history[paired.key]=paired;
        localStorage.setItem("lppe-fd-top20-benchmark-v1",JSON.stringify(history));
        const values=Object.values(history);
        const note=document.createElement("p");
        note.textContent="First pre-lock builds across "+values.length+" reviewed slates · at least one top-20 finish: tournament "+
          values.filter(x=>x.tournament.hits>0).length+"/"+values.length+" · projection-only "+
          values.filter(x=>x.projection.hits>0).length+"/"+values.length+". One contest per slate, equal entry counts.";
        output.append(note);
      }
      const top3Pair=pairHeldOut(rows,replay,"top3");
      if (top3Pair) {
        const key="lppe-fd-top3-benchmark-v1";
        const history=JSON.parse(localStorage.getItem(key) || "{}");
        const prior=history[top3Pair.key];
        if (!prior || (prior.contest===top3Pair.contest &&
            Date.parse(top3Pair.tournament.capturedAt)<=Date.parse(prior.tournament.capturedAt))) {
          history[top3Pair.key]=top3Pair;
          localStorage.setItem(key,JSON.stringify(history));
        }
        const result=summarizeTop3Pairs(Object.values(history),"top3");
        const interval=bounds=>bounds.map(value=>percent.format(value)).join(" to ");
        output.append(" Top-3% paper replay across "+result.count+" paired slates. Tournament "+
          result.tournament+"/"+result.count+" (95% interval "+interval(result.tournamentInterval)+
          "); projected points "+result.projection+"/"+result.count+" (95% interval "+interval(result.projectionInterval)+
          "). Tournament improved "+result.improved+" and regressed "+result.regressed+" slates.");
      } else if (!paired && replay.length) {
        output.append(" Paired benchmark pending. Use complete standings and an archive containing both original builds for the same slate, lock and lineup count.");
      }
      for (const item of replay) {
        const note = document.createElement("p");
        note.textContent = item.slate+" · "+item.version+" saved build · scored "+item.scored+"/"+item.total+
          " lineups · best "+item.best.toFixed(1)+(item.hits === null ? "" : " · "+item.hits+" reached the top-20 score")+(item.top3?.top3Places ? " · "+item.top3.top3Count+" reached the paper top 3%" : "")+" · paper best rank "+item.bestRank+" · "+item.gapToFirst.toFixed(1)+" points from first"+(item.net===null ? "" : " · estimated net "+dollars.format(item.net));
        output.append(note);
      }
      if (!replay.length) output.append(" No saved pre-lock lineup could be scored. Check that the standings include one consistent point total for every player ID in the lineup.");
    } catch { output.append(" Saved build history is unavailable."); }
  } catch (error) {
    output.textContent = error.message;
  }
});

automatic.addEventListener("change",() => {
  try { localStorage.setItem("fd-automatic",automatic.checked ? "on" : "off"); } catch {}
  startAutomaticSession();
});
setInterval(startAutomaticSession,60000);
async function checkNBAChanges() {
  const slate=loadedLiveSlate;
  if (!slate || sport.value!=="NBA" || !automatic.checked || document.hidden || autoRequest || optimizer ||
      objective.value==="ceiling" || Date.now()>=slateLockAt) return;
  const original=lineups.length ? slate.lastSnapshot : null;
  const changes=[];
  const before=nbaRoleProjections(players).map(p=>({id:p.id,minutes:p.minutes}));
  if (await refreshNBAContext(slate,false,changes) && loadedLiveSlate===slate && !autoRequest && Date.now()<slateLockAt) {
    renderPlayers();
    const previous=new Map(before.map(p=>[p.id,p.minutes]));
    const teams=new Set(changes.map(c=>c.team));
    const minutes=nbaRoleProjections(players).filter(p=>teams.has(p.team) && !unavailable(p.status) &&
      Number.isFinite(previous.get(p.id)) && Number.isFinite(p.minutes) &&
      Math.abs(p.minutes-previous.get(p.id))>=0.1).map(p=>p.name+" "+previous.get(p.id).toFixed(1)+" → "+p.minutes.toFixed(1));
    buildCurrentLineups(changes.length && original ? {original,changes,minutes} : null);
  }
}
setInterval(checkNBAChanges,300000);
document.addEventListener("visibilitychange",checkNBAChanges);
function showNewsComparison(news,comparison) {
  const panel=document.createElement("section");
  const title=document.createElement("h3");
  title.textContent="Automatic NBA news rebuild";
  panel.append(title);
  const add=text=>{const p=document.createElement("p");p.textContent=text;panel.append(p)};
  for (const c of news.changes) {
    const affected=news.original.lineups.flatMap((roster,i)=>roster.some(p=>p.id===c.id)?[i+1]:[]);
    add(c.name+" · "+c.status+" · ESPN "+c.timeLabel+" "+new Date(c.at).toLocaleString()+
      " · original lineups containing player: "+(affected.join(", ")||"none")+(c.locked?" · unavailable manual lock released":""));
  }
  add("Estimated teammate minutes: "+(news.minutes.join("; ")||"no measurable change with available rotation data"));
  const usage=rosters=>{const counts=new Map();for(const roster of rosters)for(const p of roster)counts.set(p.id,(counts.get(p.id)||0)+1);return counts};
  const current=lineups.map(l=>l.picks.map(p=>p.player));
  const old=usage(news.original.lineups),next=usage(current);
  const names=new Map([...news.original.lineups.flat(),...current.flat()].map(p=>[p.id,p.name]));
  const max=(counts,n)=>n ? Math.round(100*Math.max(0,...counts.values())/n)+"%" : "unavailable";
  add("Maximum player exposure: original "+max(old,news.original.lineups.length)+" · rebuilt "+max(next,current.length));
  add("Player appearances (original → rebuilt): "+([...names].filter(([id])=>old.get(id)!==next.get(id)).map(([id,name])=>name+" "+(old.get(id)||0)+" → "+(next.get(id)||0)).join("; ")||"unchanged"));
  add(comparison ? "Same "+comparison.scenarios+" simulated contests, including ties. Original → rebuilt: first "+comparison.projectionFirsts+" → "+comparison.tournamentFirsts+"; top 20 "+comparison.projectionHits+" → "+comparison.tournamentHits+"." :
    "A matched tournament simulation is unavailable for these builds.");
  byId("fdResults").prepend(panel);
}
document.addEventListener("visibilitychange",startAutomaticSession);

try {
  byId("fdCfbSnapshotDownload").hidden=!readStoredCfbSnapshots(localStorage).length;
} catch {}
byId("fdCfbSnapshotDownload").addEventListener("click",()=>{
  try {
    const snapshots=readStoredCfbSnapshots(localStorage);
    const url=URL.createObjectURL(new Blob([JSON.stringify(snapshots)],{type:"application/json"}));
    const link=document.createElement("a");
    link.href=url;
    link.download="lppe-cfb-prelock-snapshots.json";
    link.click();
    setTimeout(()=>URL.revokeObjectURL(url),1000);
  } catch {
    byId("fdHistoryStatus").textContent="Saved CFB snapshots could not be downloaded.";
  }
});

const historyPrefix = "lppe-fd-build-v1/";
function saveBuildHistory(baseline,ownershipForecast,comparison,news,newsComparison) {
  const now = Date.now();
  if (now >= slateLockAt) return;
  const key = historyPrefix+JSON.stringify([sport.value,loadedLiveSlate.id,slateLockAt]);
  const serialize = portfolio => portfolio.map(lineup => lineup.picks.map(({player}) => ({
    id:player.id,name:player.name,team:player.team,points:player.points,source:player.source,projectionUpdatedAt:player.projectionUpdatedAt,salary:player.salary,
    ceiling:player.ceiling,ownership:player.ownership,minutes:player.minutes,starter:player.starter})));
  const snapshot = {capturedAt:new Date(now).toISOString(),sport:sport.value,slate:loadedLiveSlate.name,
    lockAt:new Date(slateLockAt).toISOString(),requested:Number(count.value),
    target:objective.value==="tournament" ? byId("fdTarget").value : null,
    settings:Object.fromEntries(slateSettings.map(control => [control.id,control.value])),
    lineups:serialize(lineups)};
  loadedLiveSlate.lastSnapshot=snapshot;
  try {
    const existing = JSON.parse(localStorage.getItem(key));
    const record = {...existing,first:existing?.first || snapshot,latest:snapshot};
    if (news) {
      record["newsBefore_"+now]=news.original;
      record["newsAfter_"+now]={...snapshot,news:news.changes,minuteChanges:news.minutes,comparison:newsComparison};
    }
    if (baseline?.length) {
      record.tournament = {...snapshot,ownershipForecast,comparison};
      record.projection = {...snapshot,settings:{...snapshot.settings,fdObjective:"projection"},lineups:serialize(baseline)};
      const first=snapshot.target==="top3" ? "initialTop3" : "initialTournament";
      const firstBaseline=snapshot.target==="top3" ? "initialTop3Baseline" : "initialBaseline";
      if (!record[first] && snapshot.lineups.length===snapshot.requested && baseline.length===snapshot.requested) {
        record[first]={...snapshot,ownershipForecast};
        record[firstBaseline]=record.projection;
      }
    }
    localStorage.setItem(key,JSON.stringify(record));
    byId("fdHistoryStatus").textContent = "First and latest pre-lock builds saved on this device for "+loadedLiveSlate.name+".";
  } catch {
    byId("fdHistoryStatus").textContent = "Build history could not be saved on this device.";
  }
}
function readBuildHistory() {
  return Object.keys(localStorage).filter(key => key.startsWith(historyPrefix))
    .map(key => JSON.parse(localStorage.getItem(key)));
}
byId("fdBuildHistory").addEventListener("click",() => {
  try {
    const records = readBuildHistory();
    if (!records.length) {
      byId("fdHistoryStatus").textContent = "History starts with a completed live build before slate lock.";
      return;
    }
    const url = URL.createObjectURL(new Blob([JSON.stringify(records)],{type:"application/json"}));
    const link = document.createElement("a");
    link.href = url;
    link.download = "lppe-prelock-builds.json";
    link.click();
    setTimeout(() => URL.revokeObjectURL(url),1000);
  } catch { byId("fdHistoryStatus").textContent = "Saved builds could not be downloaded."; }
});

async function refreshNBAContext(slate,initial,changes=[]) {
  if (slate.checking) return false;
  slate.checking=true;
  const read = async path => {
    const response=await fetch("/api/nba/model"+path,{signal:AbortSignal.timeout(7500)});
    if (!response.ok) throw new Error("Public context unavailable");
    return response.json();
  };
  try {
    const [health,history,starters]=await Promise.allSettled([
      read("?availability=1"),initial || !slate.hasRotation ? read("") : Promise.resolve(null),read("?starters=1")
    ]);
    if (loadedLiveSlate!==slate || sport.value!=="NBA" || Date.now()>=slateLockAt) return false;
    let changed=false;
    if (history.value?.players?.length && history.value.schedule?.some(game =>
      new Date(game.start).toLocaleDateString("en-CA",{timeZone:"America/New_York"})===slate.date)) {
      players=addRotations(players,history.value.players,Date.now());
      slate.hasRotation=players.some(p=>p.rotation);
      changed=slate.hasRotation;
    }
    for (const team of starters.value?.teams || []) {
      if (Date.parse(team.start)<slateLockAt || new Date(team.start).toLocaleDateString("en-CA",{timeZone:"America/New_York"})!==slate.date) continue;
      const names=new Set(team.starters.map(matchName));
      const teammates=players.filter(p=>p.team===teamCode(team.team));
      if (teammates.filter(p=>names.has(matchName(p.name))).length!==5) continue;
      for (const p of teammates) {
        const starting=names.has(matchName(p.name));
        if (p.confirmedStarter!==starting) {
          if (!initial && (starting || p.confirmedStarter===true)) changes.push({id:p.id,name:p.name,team:p.team,status:starting?"confirmed starter":"confirmed bench",at:Date.now(),timeLabel:"observed"});
          p.confirmedStarter=starting;changed=true;
        }
      }
    }
    let excluded=0;
    const reports=health.value?.reports || [];
    const now=Date.now();
    const latest=new Map();
    for (const report of reports) {
      const when=Date.parse(report.updatedAt);
      if (!(when<=now && now-when<=72*3600000)) continue;
      const id=teamCode(report.team)+":"+matchName(report.player);
      if (!latest.has(id) || when>latest.get(id).when) latest.set(id,{...report,when});
    }
    const ids=players.map(p=>p.team+":"+matchName(p.name));
    for (const [i,p] of players.entries()) {
      const report=latest.get(ids[i]);
      if (!report || ids.indexOf(ids[i])!==ids.lastIndexOf(ids[i]) ||
          report.when<=(p.newsAt??(Date.parse(slate.updatedAt)||0))) continue;
      const returnDay=String(report.returnDate||"").slice(0,10);
      if (report.status==="Out" && ((/^\d{4}-\d{2}-\d{2}$/.test(returnDay) && returnDay>slate.date) || (!returnDay && new Date(report.when).toLocaleDateString("en-CA",{timeZone:"America/New_York"})===slate.date)) && !unavailable(p.status)) {
        changes.push({id:p.id,name:p.name,team:p.team,status:"ruled out",at:report.when,timeLabel:"reported",locked:p.selection==="lock"});
        p.priorStatus=p.status;
        p.priorSelection=p.selection==="lock"?"available":p.selection;
        p.status="Out";p.selection="exclude";p.newsAt=report.when;changed=true;excluded++;
      } else if (p.newsAt && /^(active|available)$/i.test(report.status)) {
        changes.push({id:p.id,name:p.name,team:p.team,status:"available",at:report.when,timeLabel:"reported"});
        p.status=p.priorStatus;p.selection=p.priorSelection;p.newsAt=report.when;changed=true;
      }
    }
    byId("fdNewsStatus").textContent="Public NBA rotation history matched "+players.filter(p=>p.rotation).length+
      " players · "+players.filter(p=>p.confirmedStarter===true).length+" confirmed starters. "+(health.status==="fulfilled" ? "Availability checked "+new Date().toLocaleTimeString()+"." : "Availability feed unavailable.")+
      (excluded ? " Newly ruled out: "+excluded+"." : "");
    return changed;
  } finally { slate.checking=false; }
}

function showEntryCheck() {
  const output=byId("fdEntryCheck");
  output.textContent="";
  const raw=byId("fdEnteredIds").value.trim();
  if (!raw || sport.value!=="NBA" || !lineups.length) return;
  const entries=raw.split(/\r?\n/).map(row=>row.trim().split(/[\s,]+/));
  const planned=lineups.map(l=>l.picks.map(p=>String(p.player.id)));
  const known=new Set(players.map(p=>String(p.id)));
  if (entries.some(ids=>ids.length!==9 || new Set(ids).size!==9 || ids.some(id=>!known.has(id)))) {
    output.textContent="Entry comparison unavailable. Check that each row has nine distinct IDs from this slate.";
    return;
  }
  const result=reconcileNBAEntries(planned,entries);
  const notes=[result.matched+" of "+planned.length+" planned rosters matched · "+result.distinct+" distinct rosters in "+entries.length+" supplied entries."];
  if (result.missing.length) notes.push("Missing build lineup numbers: "+result.missing.join(", ")+".");
  if (result.extra.length) notes.push("Extra or different entry rows: "+result.extra.join(", ")+".");
  if (result.repeated.length) notes.push("Repeated roster on entry rows: "+result.repeated.join(", ")+".");
  output.textContent=notes.join(" ");
}
let swapTracker;
let swapExpiry;
let stoppedDraftSlate;
const swapStatus=byId("fdSwapStatus");
function stopSwap() {
  clearTimeout(swapExpiry);
  swapTracker?.worker?.terminate();
  swapTracker=undefined;
  byId("fdStopSwap").hidden=true;
  byId("fdSwapResults").replaceChildren();
}
async function refreshSwaps() {
  if (!swapTracker && automatic.checked && !document.hidden && sport.value==="NBA" && loadedLiveSlate &&
      slateLockAt && Date.now()>=slateLockAt && Date.now()-slateLockAt<12*3600000 &&
      stoppedDraftSlate!==slateLockAt && loadedLiveSlate.lastSnapshot && lineups.length && lineups.length<=20) {
    const pool={date:loadedLiveSlate.date,updatedAt:loadedLiveSlate.updatedAt,players:players.map(p=>({...p}))};
    const entries=lineups.map(l=>[...l.picks].sort((a,b)=>a.slot-b.slot).map(p=>p.player.id));
    swapTracker={pool,entries,lockedTeams:new Set(),busy:false,draft:true};
    byId("fdStopSwap").hidden=false;
  }
  const tracker=swapTracker;
  if (!tracker || tracker.busy || document.hidden) return;
  tracker.busy=true;
  clearTimeout(swapExpiry);
  const output=byId("fdSwapResults");
  output.replaceChildren();
  swapStatus.textContent="Checking NBA game locks and availability…";
  try {
    const get=async path=>{
      const r=await fetch("/api/nba/model?"+path,{signal:AbortSignal.timeout(12000)});
      if(!r.ok) throw new Error("Public NBA updates are unavailable. Retry before making a swap.");
      return r.json();
    };
    const [schedule,injuries]=await Promise.all([get("swapGames="+tracker.pool.date.replaceAll("-","")),get("availability=1")]);
    if(tracker!==swapTracker)return;
    if (!Array.isArray(injuries.reports) || !(Date.now()-Date.parse(injuries.checkedAt)<600000) ||
        !Array.isArray(schedule.games) || !(Date.now()-schedule.checkedAt<120000)) {
      throw new Error("Current lock times and availability could not be verified.");
    }
    const worker=new Worker("/fanduel-worker.js",{type:"module"});
    tracker.worker=worker;
    const data=await new Promise((resolve,reject)=>{
      worker.onmessage=({data})=>data.error ? reject(new Error(data.error)) : resolve(data);
      worker.onerror=()=>reject(new Error("Late-swap search failed."));
      worker.postMessage({swap:{pool:tracker.pool,entries:tracker.entries,games:schedule.games,reports:injuries.reports,priorLocks:[...tracker.lockedTeams]}});
    });
    if (tracker!==swapTracker)return;
    for(const swap of data.swaps) for(const team of swap.activeTeams)tracker.lockedTeams.add(team);
    const until=Math.min(...data.swaps.map(s=>s.expiresAt));
    if (!Number.isFinite(until)) {
      stoppedDraftSlate=slateLockAt;stopSwap();swapStatus.textContent="All games are locked.";return;
    }
    if(until<=Date.now()) {swapStatus.textContent="A game just locked. Rechecking.";return;}
    for(const [i,swap] of data.swaps.entries()) {
      const card=document.createElement("details"), summary=document.createElement("summary"),list=document.createElement("ol");
      card.open=i===0;
      summary.textContent="Entry "+(i+1)+" · "+swap.picks.filter(p=>p.changed).length+" proposed changes · "+dollars.format(swap.salary);
      for(const pick of swap.picks) {
        const li=document.createElement("li");
        const old=tracker.pool.players.find(p=>p.id===tracker.entries[i][pick.slot]);
        li.textContent=profiles.NBA.roster[pick.slot][0]+" · "+(pick.changed?old.name+" → ":"")+pick.name+
          (pick.locked?" · locked":"")+" · "+pick.id;
        list.append(li);
      }
      card.append(summary,list);output.append(card);
    }
    swapStatus.textContent=(tracker.draft ? "Tracking the last LPPE build. " : "Tracking your supplied entries. ")+
      "Checked "+new Date().toLocaleTimeString()+". Apply desired swaps in FanDuel and import actual entries to track them.";
    swapExpiry=setTimeout(()=>{output.replaceChildren();refreshSwaps();},Math.max(1,until-Date.now()));
  } catch(error) {
    if(tracker===swapTracker)swapStatus.textContent=error.message;
  } finally {
    tracker.worker?.terminate();tracker.worker=undefined;tracker.busy=false;
  }
}
byId("fdSwap").addEventListener("click",()=>{
  stopSwap();
  let pool=readSession()?.data;
  if(sport.value!=="NBA" || !pool?.players?.length) {swapStatus.textContent="Load the matching live NBA slate first.";return;}
  if (loadedLiveSlate && pool.lockAt===slateLockAt && readSession()?.id===loadedLiveSlate.id) pool={...pool,players:players.map(p=>({...p}))};
  const entries=byId("fdEnteredIds").value.trim().split(/\r?\n/).map(line=>line.trim().split(/[\s,]+/));
  if(entries.length>20 || entries.some(ids=>ids.length!==9 || new Set(ids).size!==9 || ids.some(id=>!pool.players.some(p=>p.id===id)))) {
    swapStatus.textContent="Enter 1–20 lineups with nine distinct player IDs from this slate on each line.";return;
  }
  swapTracker={pool,entries,lockedTeams:new Set(),busy:false};
  byId("fdStopSwap").hidden=false;refreshSwaps();
});
byId("fdStopSwap").addEventListener("click",()=>{stoppedDraftSlate=slateLockAt;stopSwap();swapStatus.textContent="Tracking stopped.";});
byId("fdEnteredIds").addEventListener("input",()=>{showEntryCheck();if(swapTracker){stopSwap();swapStatus.textContent="Restart tracking to use the edited entries.";}});
sport.addEventListener("change",()=>{stopSwap();swapStatus.textContent="";});
setInterval(refreshSwaps,300000);
document.addEventListener("visibilitychange",()=>{if(!document.hidden)refreshSwaps();});

byId("fdSwapFile").addEventListener("change",async event=>{
  const file=event.target.files[0];
  if(!file)return;
  stopSwap();
  byId("fdEnteredIds").value="";
  showEntryCheck();
  try {
    const entries=enteredNBAIds(await file.text());
    byId("fdEnteredIds").value=entries.map(ids=>ids.join(", ")).join("\n");
    showEntryCheck();
    byId("fdSwap").click();
  } catch(error) { swapStatus.textContent=error.message; }
});

setInterval(async () => {
  if (sport.value!=="NFL" || document.hidden || !lineups.length || optimizer) return;
  try {
    await verifyNFLInjuries();
    const eligible = new Set(poolForBuild().filter(p=>p.selection!=="exclude").map(p=>p.id));
    if (lineups.some(l=>l.picks.some(({player})=>!eligible.has(player.id)))) injuryBlocked(new Error("Injury status changed. Rebuild lineups."));
  } catch(error) { injuryBlocked(error); }
},300000);
