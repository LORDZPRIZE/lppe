import { buildLineups } from "./fanduel-optimizer.js";

self.addEventListener("message",({data}) => {
  try {
    self.postMessage(buildLineups(data.players,data.count,data.difference,160000,data.sport,data.options));
  } catch (error) {
    self.postMessage({error:error.message || "Could not build lineups."});
  }
});
