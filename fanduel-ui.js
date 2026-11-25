import {enteredNBAIds,ownershipReview,pairHeldOut,readNBAArchive} from "./fanduel-nba-review.js";
import { addRotations, nbaRoleProjections } from "./fanduel-nba-tournament.js";
import { matchName, teamCode, applyPlayerProjections, importPlayers, inspectSalaryCSV, parseCSV, profiles, scoreSavedBuilds, reviewContest, summarizeReviewExport, reviewCSV, unavailable } from "./fanduel-optimizer.js";

const byId = id => document.getElementById(id);
const percent = new Intl.NumberFormat("en-US",{style:"percent",maximumFractionDigits:1});
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
    loadPublicPool(false,saved.data);
    return;
  }
  if (saved?.resumeAt > now) {
    byId("fdStatus").textContent = "Live requests paused until "+new Date(saved.resumeAt).toLocaleString()+". Refresh slates to start sooner.";
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
    if (Object.hasOwn(saved.settings,control.id)) control.value = control.id==="fdTarget" && saved.settings.fdTarget==="top100" ? "first" : saved.settings[control.id];
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
  exportButton.disabled = true;
  byId("fdExportCheck").replaceChildren();
  byId("fdResults").replaceChildren();
  byId("fdResultsPanel").hidden = true;
}

function poolForBuild() {
  if (!avoidQuestionable.checked) return players;
  return players.map(player => player.selection === "available" && uncertainAvailability(player.status) ?
    {...player,selection:"exclude"} : player);
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
  if (simulation) headings.push("Modeled win share",simulation.target==="top20" ? "Added top-20 coverage" : "Added win coverage");
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
    if (simulation) values.push(percent.format(lineup.tournament.win),percent.format(lineup.tournament.addedWinCoverage));
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
  lineups = result.simulation ? result.lineups : [...result.lineups].sort((a,b) => highCeiling ? b.ceiling - a.ceiling : b.points - a.points);
  const heading = byId("fdResultsHeading");
  const slateName = loadedLiveSlate?.name || importedSlateName;
  heading.textContent = slateName ? "Lineups · "+slateName : "Lineups";
  status.textContent = lineups.length ? "Built "+lineups.length+" of "+requested+" requested lineups. Ranked by "+(highCeiling ? "total ceiling estimates." : "total projected points.") :
    "No valid lineup found. Check projections, locks, exclusions, and roster eligibility.";
  if (result.simulation) {
    const {scenarios,opponents,ownershipPlayers,fieldPlayers} = result.simulation;
    status.textContent = "Built "+lineups.length+" of "+requested+(" lineups. Selected for "+(result.simulation.target==="top20"?"top-20":"first-place")+" coverage across ")+
      scenarios+" scenarios against "+opponents+" simulated opponents. "+
      (ownershipPlayers ? "Projected ownership influenced the field for "+ownershipPlayers+" of "+fieldPlayers+" eligible players." :
        "The field used projections and random variation. Import projected ownership to factor in expected popularity.");
  }
  if (result.simulation && sport.value==="NBA") status.textContent += " Experimental model. Win shares describe simulated outcomes only.";
  if (result.simulation?.coverage != null) status.textContent += " At least one lineup reached the top 20 in "+percent.format(result.simulation.coverage)+" of selection scenarios.";
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
    for (const label of ["Portfolio","First","Top 20"]) {
      const cell=document.createElement("th");
      cell.scope="col";
      cell.textContent=label;
      headers.append(cell);
    }
    const body=table.createTBody();
    for (const [label,firsts,hits] of [
      ["Tournament",comparison.tournamentFirsts,comparison.tournamentHits],
      ["Projected points",comparison.projectionFirsts,comparison.projectionHits]
    ]) {
      const row=body.insertRow();
      const name=document.createElement("th");
      name.scope="row";
      name.textContent=label;
      row.append(name);
      row.insertCell().textContent=firsts??"Unavailable";
      row.insertCell().textContent=hits;
    }
    panel.append(heading,table);
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
      const {top,win,ceiling,duplicates} = lineup.tournament;
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
    output.append(details);
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
}

function buildCurrentLineups(news=null) {
  news=news?.original ? news : null;
  if (slateLockAt && slateLockAt <= Date.now()) {
    clearLineups();
    byId("fdStatus").textContent = "The automatically loaded slate has reached its first game start. Load another available pool or import a different contest.";
    return;
  }
  const gpp = mode.value === "gpp";
  const candidates = poolForBuild();
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
  const tournament = gpp && ["NBA","NFL"].includes(sport.value) && objective.value === "tournament";
  if (tournament && sport.value==="NBA" && !byId("fdFieldSize").reportValidity()) return finish();
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
  activeWorker.postMessage({players:pool,highCeiling,tournament,count:requested,difference:gpp ? difference.valueAsNumber : 1,
    sport:sport.value,deep:gpp && depth.value === "deep",options});
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
        const upcoming = data.slates.filter(slate => !slate.lockAt || slate.lockAt > Date.now());
        const preferred = upcoming.find(slate => String(slate.id) === previousId) ||
          upcoming[0];
        if (preferred) {
          liveSlate.value = String(preferred.id);
          return loadPublicPool();
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
    const estimateSummary = coverage ?
      " Daily Fantasy Fuel projections matched "+coverage.matched+" of "+coverage.eligible+
      " available players (updated "+new Date(coverage.updatedAt).toLocaleTimeString()+"). Other players use FanDuel FPPG when available." :
      data.poolType === "salary feed" ? " Uses historical FPPG." : " Uses the public preview, which may omit players.";
    byId("fdStatus").textContent = data.label+" · "+data.date+" · "+players.length+" players across "+data.gameCount+
      " games · "+data.provider+updated+". First listed game: "+new Date(data.lockAt).toLocaleString()+"."+estimateSummary+
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
  const profile = profiles[sport.value];
  byId("fdNflCsvSource").hidden = sport.value !== "NFL";
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
  applyMode();
  liveSlate.value = "";
  listedSlates = [];
  startAutomaticSession();
});
function applyMode() {
  const cash = mode.value === "cash";
  const tournament = objective.querySelector('option[value="tournament"]');
  tournament.disabled = tournament.hidden = cash || !["NBA","NFL"].includes(sport.value);
  byId("fdTargetLabel").hidden = cash || sport.value!=="NBA" || objective.value!=="tournament";
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
byId("fdTarget").addEventListener("change",clearLineups);
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
exportButton.addEventListener("click",() => {
  const url = URL.createObjectURL(new Blob([reviewCSV(lineups,sport.value)],{type:"text/csv;charset=utf-8"}));
  const download = document.createElement("a");
  download.href = url;
  download.download = "fanduel-"+sport.value.toLowerCase()+"-lineups-review.csv";
  download.click();
  setTimeout(() => URL.revokeObjectURL(url),1000);
});

byId("fdSpreadFive").addEventListener("click",() => {
  count.value = "5";
  exposure.value = "80";
  difference.value = "3";
  applyMode();
  byId("fdBuildStatus").textContent = "Ready to build five lineups with at least three different players per pair and a four-lineup cap per unlocked player.";
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
    if (result.winningScore!==null) output.append(" Winning score: "+result.winningScore.toFixed(2)+".");
    if (result.userEntries) {
      if (result.winningScore!==null) output.append(" First-place finishes: "+result.wins+". Gap to first: "+Math.max(0,result.winningScore-result.best).toFixed(2)+".");
      output.append(" "+username+" placed "+result.top20Entries+" of "+result.userEntries+
        " entries in the top 20. Best score: "+result.best.toFixed(2)+"."+
        (result.cutoff===null ? "" : " Points short: "+Math.max(0,result.cutoff-result.best).toFixed(2)+"."));
    } else if (username) output.append(" No entries matched "+username+".");
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
        title.textContent="Ownership forecast accuracy · "+review.players.length+" matched players";
        panel.append(title);
        for (const group of review.groups) {
          const note=document.createElement("p");
          note.textContent=group.name+" · "+group.mae.toFixed(1)+" percentage points mean absolute error ("+group.count+" players)";
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
      for (const item of replay) {
        const note = document.createElement("p");
        note.textContent = item.slate+" · "+item.version+" saved build · scored "+item.scored+"/"+item.total+
          " lineups · best "+item.best.toFixed(1)+(item.hits === null ? "" : " · "+item.hits+" reached the top-20 score")+" · paper best rank "+item.bestRank+" · "+item.gapToFirst.toFixed(1)+" points from first"+(item.net===null ? "" : " · estimated net "+dollars.format(item.net));
        output.append(note);
      }
      if (!replay.length) output.append(" No saved pre-lock lineups fully matched this export by FanDuel player ID.");
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
      if (!record.initialTournament) {
        record.initialTournament=snapshot;
        record.initialBaseline=record.projection;
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
byId("fdEnteredIds").addEventListener("input",()=>{if(swapTracker){stopSwap();swapStatus.textContent="Restart tracking to use the edited entries.";}});
sport.addEventListener("change",()=>{stopSwap();swapStatus.textContent="";});
setInterval(refreshSwaps,300000);
document.addEventListener("visibilitychange",()=>{if(!document.hidden)refreshSwaps();});

byId("fdSwapFile").addEventListener("change",async event=>{
  const file=event.target.files[0];
  if(!file)return;
  stopSwap();
  try {
    const entries=enteredNBAIds(await file.text());
    byId("fdEnteredIds").value=entries.map(ids=>ids.join(", ")).join("\n");
    byId("fdSwap").click();
  } catch(error) { swapStatus.textContent=error.message; }
});
