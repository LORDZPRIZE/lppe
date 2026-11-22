import { importPlayers, profiles, reviewCSV } from "./fanduel-optimizer.js";

const byId = id => document.getElementById(id);
const percent = new Intl.NumberFormat("en-US",{style:"percent",maximumFractionDigits:1});
const dollars = new Intl.NumberFormat("en-US",{style:"currency",currency:"USD",maximumFractionDigits:0});
const importForm = byId("fdImport");
const autoLoad = byId("fdAutoLoad");
const sport = byId("fdSport");
const salaries = byId("fdSalaries");
const projections = byId("fdProjections");
const search = byId("fdSearch");
const count = byId("fdCount");
const difference = byId("fdDifference");
const exposure = byId("fdExposure");
const stack = byId("fdStack");
const objective = byId("fdObjective");
const mode = byId("fdMode");
const build = byId("fdBuild");
const exportButton = byId("fdExport");
let players = [];
let lineups = [];
let optimizer;
let autoRequest;
let slateLockAt = null;
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
  byId("fdCancel").hidden = true;
  build.disabled = false;
  lineups = [];
  exportButton.disabled = true;
  byId("fdResults").replaceChildren();
  byId("fdResultsPanel").hidden = true;
}

function checkSlate(pool, profile, selectedSport) {
  const eligible = pool.filter(player => player.selection !== "exclude" && Number.isFinite(player.points));
  const games = [...new Set(pool.map(player => player.game).filter(Boolean))].sort();
  const warnings = [];
  if (eligible.length < profile.roster.length) warnings.push("Too few eligible players to fill the roster.");
  if (new Set(eligible.map(player => player.team)).size < 3) warnings.push("Fewer than three teams have eligible players.");
  const missing = new Set(profile.roster.filter(([,positions]) =>
    !eligible.some(player => player.positions.some(position => positions.includes(position)))).map(([slot]) => slot));
  if (missing.size) warnings.push("No eligible players for " + [...missing].join(", ") + ".");
  if (selectedSport === "CFB" && games.length === 1 && eligible.every(player => player.game)) {
    warnings.push("The college football roster requires at least two games.");
  }
  return {eligible:eligible.length,games,warnings};
}

function renderSlateCheck() {
  const profile = profiles[sport.value];
  const {eligible,games,warnings} = checkSlate(players,profile,sport.value);
  byId("fdSlateCheck").textContent = players.length + " players · " + eligible + " eligible · " +
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
  renderSlateCheck();
  const body = byId("fdPlayers");
  body.replaceChildren();
  const query = search.value.trim().toLowerCase();
  for (const player of players.filter(player => (player.name+" "+player.team).toLowerCase().includes(query))) {
    const row = body.insertRow();
    for (const value of [player.name,player.positions.join("/"),player.team,dollars.format(player.salary),
      Number.isFinite(player.points) ? player.points.toFixed(1) : "—",player.source || "Missing",player.status || "—"]) {
      row.insertCell().textContent = value;
    }
    const selection = document.createElement("select");
    selection.setAttribute("aria-label",player.name+" selection");
    for (const [value,label] of [["available","Available"],["lock","Lock"],["exclude","Exclude"]]) {
      const option = document.createElement("option");
      option.value = value;
      option.textContent = label;
      option.disabled = value === "lock" && !Number.isFinite(player.points);
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
      renderSlateCheck();
    });
    row.insertCell().append(selection);
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
      row.insertCell().append(cap);
    }
  }
}

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
  salaries.disabled = projections.disabled = true;
  importForm.querySelector("button").disabled = true;
  byId("fdSalaryOnly").disabled = true;
  try {
    const salaryFile = salaries.files[0];
    const projectionFile = projections.files[0];
    if (salaryFile.size > 5_000_000 || projectionFile?.size > 5_000_000) throw new Error("Use CSV files under 5 MB.");
    const projectionText = await projectionFile?.text();
    if (projectionFile && !projectionText.trim()) throw new Error("The projections file is empty. Choose another file or use the salary file alone.");
    const result = importPlayers(await salaryFile.text(),projectionText,sport.value);
    slateLockAt = null;
    clearRemoval();
    clearLineups();
    players = result.players.sort((a,b) => (b.points ?? -Infinity)-(a.points ?? -Infinity) || a.name.localeCompare(b.name));
    const missing = players.filter(player => !Number.isFinite(player.points)).length;
    const averages = players.filter(player => player.source === "FanDuel FPPG").length;
    const excluded = players.filter(player => player.selection === "exclude").length;
    byId("fdStatus").textContent = players.length+" players loaded. "+averages+" use historical FPPG, "+
      missing+" have no projection, and "+excluded+" were excluded based on CSV injury status."+
      (result.skipped ? " Skipped "+result.skipped+" rows without usable player data." : "");
    if (projectionFile) byId("fdStatus").textContent += " Custom projections matched "+result.matched+" of "+players.length+" players.";
    if (result.preview) byId("fdStatus").textContent += " Cheatsheet loaded. Review exports use local IDs for players without FanDuel IDs.";
    byId("fdPool").hidden = false;
    renderPlayers();
    build.click();
  } catch (error) {
    byId("fdStatus").textContent = (error.message || "Could not read the player pool.") +
      (players.length ? " Your previous slate is still loaded." : "");
    byId("fdManualImport").open = true;
  } finally {
    salaries.disabled = projections.disabled = false;
    importForm.querySelector("button").disabled = false;
    byId("fdSalaryOnly").disabled = false;
    autoLoad.disabled = false;
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

function renderLineups(result,requested,highCeiling) {
  const status = byId("fdBuildStatus");
  lineups = result.simulation ? result.lineups : [...result.lineups].sort((a,b) => highCeiling ? b.ceiling - a.ceiling : b.points - a.points);
  status.textContent = lineups.length ? "Built "+lineups.length+" of "+requested+" requested lineups. Ranked by "+(highCeiling ? "total ceiling estimates." : "total projected points.") :
    "No valid lineup found. Check projections, locks, exclusions, and roster eligibility.";
  if (result.simulation) {
    status.textContent = "Built "+lineups.length+" of "+requested+" lineups. Ranked by modeled top-10% finish share across "+
      result.simulation.scenarios+" scenarios and "+result.simulation.opponents+" modeled opponents. Estimates use slate projections and synthetic opponents.";
  }
  if (result.exactFirst) status.textContent += " Top lineup maximizes projected points under your current rules.";
  if (result.limited) status.textContent += result.exactFirst ? " Additional lineup searches reached their limit." :
    " The search reached its limit. A better lineup or additional alternatives may exist.";
  if (lastRemoval) {
    const {player,previousLineup} = lastRemoval;
    const summary = removalSummary(player,previousLineup,lineups[0]);
    byId("fdRemovalStatus").textContent = summary;
    status.textContent += " " + summary;
  }
  const output = byId("fdResults");
  for (const [index,lineup] of lineups.entries()) {
    const details = document.createElement("details");
    details.className = "lineup-card";
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
    if (highCeiling) meta.append(" · "+lineup.ceiling.toFixed(2)+" summed ceiling FPTS");
    if (lineup.tournament) {
      const {top,win,duplicates} = lineup.tournament;
      meta.append(" · "+percent.format(top)+" modeled top-10% · "+percent.format(win)+" modeled win · "+duplicates+" field duplicates");
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
  exportButton.disabled = !lineups.length;
}

function buildCurrentLineups() {
  if (slateLockAt && slateLockAt <= Date.now()) {
    clearLineups();
    byId("fdStatus").textContent = "The automatically loaded slate has reached its first game start. Load another available pool or import a different contest.";
    return;
  }
  const gpp = mode.value === "gpp";
  const {warnings} = checkSlate(players,profiles[sport.value],sport.value);
  if (warnings.length) {
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
  const tournament = gpp && sport.value === "NFL" && objective.value === "tournament";
  if (highCeiling && !players.some(player => player.selection !== "exclude" && Number.isFinite(player.ceiling))) {
    byId("fdBuildStatus").textContent = "High Ceiling needs a numeric Ceiling column matched to players in this slate.";
    return finish();
  }
  optimizer = new Worker("/fanduel-worker.js",{type:"module"});
  byId("fdCancel").hidden = false;
  optimizer.addEventListener("message",({data}) => {
    finish();
    if (slateLockAt && slateLockAt <= Date.now()) {
      byId("fdBuildStatus").textContent = "The slate reached its first game start during the search.";
    } else if (data.error) byId("fdBuildStatus").textContent = data.error;
    else renderLineups(data,requested,highCeiling);
  });
  optimizer.addEventListener("error",() => {
    finish();
    byId("fdBuildStatus").textContent = "The lineup builder could not start.";
  });
  const pool = gpp ? players : players.map(player => ({...player,maxExposure:100}));
  optimizer.postMessage({players:pool,highCeiling,tournament,count:requested,difference:gpp ? difference.valueAsNumber : 1,sport:sport.value,
    options:{exactFirst:objective.value === "projection",
      exposure:gpp ? exposure.valueAsNumber : 100,stack:byId("fdFootballStack").hidden ? 0 : Number(stack.value)}});
}
byId("fdCancel").addEventListener("click",() => {
  clearLineups();
  byId("fdResultsPanel").hidden = false;
  byId("fdBuildStatus").textContent = "Build canceled. Your slate and player selections are ready for another build.";
  build.focus();
});

function showBuildResults() {
  const panel = byId("fdResultsPanel");
  if (!panel.hidden) panel.scrollIntoView({block:"start"});
}

build.addEventListener("click",event => {
  buildCurrentLineups();
  if (event.isTrusted) showBuildResults();
});

async function loadPublicPool() {
  autoRequest?.abort();
  const request = new AbortController();
  autoRequest = request;
  autoLoad.disabled = true;
  byId("fdStatus").textContent = "Looking for an upcoming FanDuel player pool…";
  const timeout = setTimeout(()=>request.abort(),25000);
  try {
    const response = await fetch("/api/nba/fanduel?sport="+sport.value,{signal:request.signal});
    const data = await response.json();
    if (autoRequest !== request || request.signal.aborted) return;
    if (!response.ok) throw new Error(data.error || "No public FanDuel player pool is available.");
    if (!Array.isArray(data.players) || !(data.lockAt > Date.now())) throw new Error("The public pool has expired.");
    clearLineups();
    clearRemoval();
    slateLockAt = data.lockAt;
    players = data.players;
    const updated = data.updatedAt ? " · updated "+new Date(data.updatedAt).toLocaleString() : "";
    const baseline = data.poolType === "salary feed" ? " Uses historical FPPG." : " Uses the public preview, which may omit players.";
    byId("fdStatus").textContent = data.label+" · "+data.date+" · "+players.length+" players across "+data.gameCount+
      " games · "+data.provider+updated+". First listed game: "+new Date(data.lockAt).toLocaleString()+"."+baseline;
    byId("fdPool").hidden = false;
    renderPlayers();
    build.click();
  } catch (error) {
    if (autoRequest !== request) return;
    byId("fdStatus").textContent = request.signal.aborted ? "Automatic slate loading timed out. You can import a FanDuel CSV." :
      error.message || "Automatic slate loading is unavailable.";
    if (!players.length) byId("fdManualImport").open = true;
  } finally {
    clearTimeout(timeout);
    if (autoRequest === request) {
      autoRequest = undefined;
      autoLoad.disabled = false;
    }
  }
}
function applySport() {
  const profile = profiles[sport.value];
  byId("fdRules").textContent = dollars.format(profile.salaryCap)+" cap · "+profile.roster.map(([slot])=>slot).join(", ");
  byId("fdTeamRules").textContent = "Lock or exclude players before building. Use at least three teams and at most "+
    profile.maxTeam+" players per team"+(profile.maxHitters ? ", including at most "+profile.maxHitters+" hitters" : "")+
    ". Check current player availability before using a lineup.";
  difference.max = profile.roster.length;
  difference.value = Math.min(difference.valueAsNumber || 2,profile.roster.length);
}
autoLoad.addEventListener("click",() => {
  if (salaries.files.length) importForm.requestSubmit();
  else loadPublicPool();
});
sport.addEventListener("change",() => {
  autoRequest?.abort();
  autoRequest = undefined;
  clearRemoval();
  players = [];
  slateLockAt = null;
  importForm.reset();
  byId("fdSalaryOnly").hidden = true;
  clearLineups();
  byId("fdPool").hidden = true;
  applySport();
  applyMode();
  loadPublicPool();
});
function applyMode() {
  const cash = mode.value === "cash";
  const tournament = objective.querySelector('option[value="tournament"]');
  tournament.disabled = tournament.hidden = cash || sport.value !== "NFL";
  if (tournament.disabled && objective.value === "tournament") objective.value = "projection";
  for (const label of document.querySelectorAll("[data-gpp]")) label.hidden = cash;
  byId("fdFootballStack").hidden = cash || !["NFL","CFB"].includes(sport.value);
  byId("fdExposureHint").hidden = cash;
  build.textContent = cash ? "Build cash lineup" : "Build GPP lineups";
  clearLineups();
  if (players.length) renderSlateCheck();
}
objective.addEventListener("change",clearLineups);
mode.addEventListener("change",() => {
  applyMode();
  renderPlayers();
});
applySport();
applyMode();
loadPublicPool();

search.addEventListener("input",renderPlayers);
count.addEventListener("change",applyMode);
difference.addEventListener("change",applyMode);
exposure.addEventListener("change",applyMode);
stack.addEventListener("change",applyMode);
exportButton.addEventListener("click",() => {
  const url = URL.createObjectURL(new Blob([reviewCSV(lineups,sport.value)],{type:"text/csv;charset=utf-8"}));
  const download = document.createElement("a");
  download.href = url;
  download.download = "fanduel-"+sport.value.toLowerCase()+"-lineups-review.csv";
  download.click();
  setTimeout(() => URL.revokeObjectURL(url),1000);
});
