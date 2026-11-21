import { importPlayers, reviewCSV, roster } from "./fanduel-optimizer.js";

const byId = id => document.getElementById(id);
const dollars = new Intl.NumberFormat("en-US",{style:"currency",currency:"USD",maximumFractionDigits:0});
const importForm = byId("fdImport");
const salaries = byId("fdSalaries");
const projections = byId("fdProjections");
const search = byId("fdSearch");
const count = byId("fdCount");
const difference = byId("fdDifference");
const build = byId("fdBuild");
const exportButton = byId("fdExport");
let players = [];
let lineups = [];
let optimizer;

function clearLineups() {
  optimizer?.terminate();
  optimizer = undefined;
  build.disabled = false;
  lineups = [];
  exportButton.disabled = true;
  byId("fdResults").replaceChildren();
  byId("fdResultsPanel").hidden = true;
}

function renderPlayers() {
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
      player.selection = selection.value;
      clearLineups();
    });
    row.insertCell().append(selection);
  }
}

importForm.addEventListener("submit",async event => {
  event.preventDefault();
  importForm.querySelector("button").disabled = true;
  clearLineups();
  byId("fdPool").hidden = true;
  try {
    const salaryFile = salaries.files[0];
    const projectionFile = projections.files[0];
    if (salaryFile.size > 5_000_000 || projectionFile?.size > 5_000_000) throw new Error("Use CSV files under 5 MB.");
    const result = importPlayers(await salaryFile.text(),await projectionFile?.text());
    players = result.players.sort((a,b) => (b.points ?? -Infinity)-(a.points ?? -Infinity) || a.name.localeCompare(b.name));
    const missing = players.filter(player => !Number.isFinite(player.points)).length;
    const averages = players.filter(player => player.source === "FanDuel FPPG").length;
    const excluded = players.filter(player => player.selection === "exclude").length;
    byId("fdStatus").textContent = players.length+" players loaded. "+averages+" use historical FPPG, "+
      missing+" have no projection, and "+excluded+" were excluded based on CSV injury status."+
      (result.skipped ? " Skipped "+result.skipped+" rows without usable player data." : "");
    byId("fdPool").hidden = false;
    renderPlayers();
  } catch (error) {
    players = [];
    byId("fdStatus").textContent = error.message || "Could not read the player pool.";
  } finally {
    importForm.querySelector("button").disabled = false;
  }
});

function renderLineups(result,requested) {
  const status = byId("fdBuildStatus");
  lineups = result.lineups;
  status.textContent = lineups.length ? "Built "+lineups.length+" of "+requested+" requested lineups." :
    "No valid lineup found. Check projections, locks, exclusions, and roster eligibility.";
  if (result.limited) status.textContent += " The search reached its limit. A better lineup or additional alternatives may exist.";
  const output = byId("fdResults");
  for (const [index,lineup] of lineups.entries()) {
    const details = document.createElement("details");
    details.open = index === 0;
    const summary = document.createElement("summary");
    summary.textContent = "Lineup "+(index+1)+" · "+lineup.points.toFixed(1)+" projected FPTS · "+dollars.format(lineup.salary);
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
      for (const value of [roster[slot][0],player.name,player.team,dollars.format(player.salary),player.points.toFixed(1)]) {
        row.insertCell().textContent = value;
      }
    }
    wrapper.append(table);
    details.append(summary,wrapper);
    output.append(details);
  }
  exportButton.disabled = !lineups.length;
}

build.addEventListener("click",() => {
  if (!count.reportValidity() || !difference.reportValidity()) return;
  clearLineups();
  byId("fdResultsPanel").hidden = false;
  byId("fdBuildStatus").textContent = "Building lineups…";
  build.disabled = true;
  const requested = count.valueAsNumber;
  const finish = () => {
    optimizer?.terminate();
    optimizer = undefined;
    build.disabled = false;
  };
  optimizer = new Worker("/fanduel-worker.js",{type:"module"});
  optimizer.addEventListener("message",({data}) => {
    finish();
    if (data.error) byId("fdBuildStatus").textContent = data.error;
    else renderLineups(data,requested);
  });
  optimizer.addEventListener("error",() => {
    finish();
    byId("fdBuildStatus").textContent = "The lineup builder could not start.";
  });
  optimizer.postMessage({players,count:requested,difference:difference.valueAsNumber});
});
search.addEventListener("input",renderPlayers);
count.addEventListener("change",clearLineups);
difference.addEventListener("change",clearLineups);
exportButton.addEventListener("click",() => {
  const url = URL.createObjectURL(new Blob([reviewCSV(lineups)],{type:"text/csv;charset=utf-8"}));
  const download = document.createElement("a");
  download.href = url;
  download.download = "fanduel-nba-lineups-review.csv";
  download.click();
  setTimeout(() => URL.revokeObjectURL(url),1000);
});
