import {test} from "node:test";
import assert from "node:assert/strict";
import {normalizeInjuries,availability,refreshDFS,SPORTS} from "./dfs-intelligence.js";
const now=Date.parse("2026-11-26T12:00:00Z");
const row=(status,updatedAt=new Date(now).toISOString())=>({playerId:"1",status,updatedAt,source:"fixture"});
test("all supported sports normalize independently",()=>{for(const sport of SPORTS){const board=normalizeInjuries({sport,complete:true,reports:[row("available")]},sport,now);assert.equal(availability(board,"1",now),"available");assert.equal(availability(board,"2",now),"unknown");}});
test("inactive overrides conflicting available report",()=>{const b=normalizeInjuries({sport:"NBA",complete:true,reports:[row("available"),row("out")]}, "NBA",now);assert.equal(availability(b,"1",now),"blocked");});
test("stale or incomplete reports never confirm availability",()=>{for(const b of [normalizeInjuries({sport:"NFL",complete:false,reports:[row("available")]}, "NFL",now),normalizeInjuries({sport:"NFL",complete:true,reports:[row("available",new Date(now-7200000).toISOString())]}, "NFL",now)]) assert.equal(availability(b,"1",now),"unknown");});
test("missing storage and provider are explicit",async()=>{assert.equal((await refreshDFS({})).status,"missing_storage");const store=new Map();const r=await refreshDFS({DFS_ARCHIVE:{put:async(k,v)=>store.set(k,v)}},["NBA"]);assert.equal(r.outcomes.length,2);assert.ok(r.outcomes.every(x=>x.status==="not_configured"));});
