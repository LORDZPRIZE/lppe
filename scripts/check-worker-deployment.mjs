import {setTimeout as delay} from "node:timers/promises";

const expected = process.env.EXPECTED_SHA;
const version = process.env.EXPECTED_VERSION;
if (!(expected ? /^[a-f0-9]{40}$/.test(expected) : /^\d+\.\d+$/.test(version ?? ""))) {
  throw new Error("Supply EXPECTED_SHA or EXPECTED_VERSION for the Worker release.");
}
for (let attempt=0;attempt<12;attempt++) {
  try {
    const response = await fetch("https://lppe-api.lord-joseph.workers.dev/health",{
      cache:"no-store",signal:AbortSignal.timeout(6000)
    });
    const health = await response.json();
    if (response.ok && health.status==="online" && health.revision && (expected ? health.tag===expected : health.version===version)) {
      console.log("Production Worker revision verified",health.revision);
      process.exit(0);
    }
  } catch {}
  if (attempt<11) await delay(5000);
}
throw new Error("The production Worker did not report the expected release.");
