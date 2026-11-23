import { completedNBA, nbaDate, recentNBA } from "./model.js";

const day = 86400000;
const version = "recent-average-v1";
const markets = ["points","rebounds","assists","three-pointers"];

export function projectSlate({players,schedule},capturedAt) {
  const forecasts = [];
  for (const player of players) {
    const games = schedule.filter(game => game.teams.includes(player.team) && Date.parse(game.start) > capturedAt);
    if (games.length !== 1 || !player.id || !games[0].id) continue;
    const [game] = games;
    const startsAt = Date.parse(game.start);
    const recent = player.games.filter(row => {
      const age = capturedAt-Date.parse(row.date);
      return age > 0 && age <= 11*day &&
        row.values.length >= markets.length && markets.every((_,i) => Number.isInteger(row.values[i]));
    });
    if (recent.length < 4) continue;
    for (const [index,market] of markets.entries()) {
      const projection = recent.reduce((sum,row) => sum+row.values[index],0)/recent.length;
      forecasts.push({
        gameId:game.id,playerId:player.id,market,player:player.player,team:player.team,
        startsAt,slateDate:nbaDate(startsAt),capturedAt,projection,sampleSize:recent.length
      });
    }
  }
  return forecasts;
}

async function writeBatch(db,statements) {
  let changed = 0;
  for (let offset = 0; offset < statements.length; offset += 50) {
    const results = await db.batch(statements.slice(offset,offset+50));
    changed += results.reduce((sum,result) => sum+(result.meta.changes ?? 0),0);
  }
  return changed;
}

const reply = (body,status = 200) => Response.json(body,{status,headers:{"Cache-Control":"no-store"}});

export async function onRequestGet({request,env}) {
  const db = env.NBA_FORECASTS;
  if (!db) return reply({error:"Shared NBA history is unavailable"},503);
  const params = new URL(request.url).searchParams;
  const days = Number(params.get("days") ?? 30);
  const market = params.get("market");
  if (![7,30,90].includes(days) || (market !== null && !markets.includes(market))) {
    return reply({error:"Choose a supported market and a 7-, 30-, or 90-day window"},400);
  }
  const filters = "WHERE starts_at >= ? AND model_version = ?" + (market ? " AND market = ?" : "");
  const values = [Date.now()-days*day,version,...(market ? [market] : [])];
  try {
    const [summary,history] = await db.batch([
      db.prepare(`SELECT market, COUNT(*) AS recorded, COUNT(actual) AS graded,
        AVG(ABS(actual-projection)) AS meanAbsoluteError, AVG(projection-actual) AS bias
        FROM nba_forecasts ${filters} GROUP BY market`).bind(...values),
      db.prepare(`SELECT game_id AS gameId, player_id AS playerId, market, player, team,
        starts_at AS startsAt, captured_at AS capturedAt, sample_size AS sampleSize,
        projection, actual FROM nba_forecasts ${filters}
        ORDER BY starts_at DESC, game_id, player_id, market LIMIT 100`).bind(...values)
    ]);
    return reply({modelVersion:version,summary:summary.results,forecasts:history.results});
  } catch (error) {
    console.error("NBA forecast history read failed",error);
    return reply({error:"Could not read shared NBA history"},503);
  }
}

export async function onRequestPost({request,env}) {
  const db = env.NBA_FORECASTS;
  const secret = env.NBA_FORECAST_JOB_TOKEN;
  if (!db || !secret) return reply({error:"Forecast job is unavailable"},503);
  if (request.headers.get("Authorization") !== "Bearer "+secret) return reply({error:"Unauthorized"},401);
  const params = new URL(request.url).searchParams;
  const action = params.get("action");
  const now = Date.now();
  try {
    if (action === "capture") {
      const part = params.get("part");
      if (!["0","1"].includes(part)) return reply({error:"Capture part must be 0 or 1"},400);
      const slate = await recentNBA(request,now,Number(part));
      const forecasts = projectSlate(slate,Date.now());
      const insert = db.prepare(`INSERT OR IGNORE INTO nba_forecasts
        (game_id,player_id,market,model_version,player,team,starts_at,slate_date,captured_at,projection,sample_size)
        VALUES (?,?,?,?,?,?,?,?,?,?,?)`);
      const inserted = await writeBatch(db,forecasts.map(row => insert.bind(
        row.gameId,row.playerId,row.market,version,row.player,row.team,row.startsAt,row.slateDate,
        row.capturedAt,row.projection,row.sampleSize
      )));
      return reply({inserted,eligible:forecasts.length,partial:slate.partial});
    }
    if (action === "grade") {
      const date = params.get("date") ?? nbaDate(now-day);
      if (!/^\d{8}$/.test(date) || date < nbaDate(now-15*day) || date > nbaDate(now)) {
        return reply({error:"Choose a results date within the past 15 days"},400);
      }
      const {results} = await db.prepare(`SELECT game_id,player_id,team,market FROM nba_forecasts
        WHERE slate_date = ? AND actual IS NULL AND model_version = ?`).bind(date,version).all();
      if (!results.length) return reply({graded:0,partial:false});
      const final = await completedNBA(request,date);
      const boxScores = new Map(final.results.map(game => [game.id,new Map(
        game.players.map(player => [player.id+":"+player.team,player.values])
      )]));
      const update = db.prepare(`UPDATE nba_forecasts SET actual = ?, graded_at = ?
        WHERE game_id = ? AND player_id = ? AND market = ? AND model_version = ? AND actual IS NULL`);
      const graded = await writeBatch(db,results.flatMap(row => {
        const actual = boxScores.get(row.game_id)?.get(row.player_id+":"+row.team)?.[markets.indexOf(row.market)];
        return Number.isInteger(actual) ? [update.bind(actual,now,row.game_id,row.player_id,row.market,version)] : [];
      }));
      return reply({graded,partial:final.partial});
    }
    return reply({error:"Choose capture or grade"},400);
  } catch (error) {
    console.error("NBA forecast job failed",error);
    return reply({error:"Forecast job failed"},502);
  }
}
