import { buildLineups } from "./fanduel-optimizer.js";

self.addEventListener("message",({data}) => {
  try {
    self.postMessage(buildLineups(data.players,data.count,data.difference));
  } catch (error) {
    self.postMessage({error:error.message || "Could not build lineups."});
  }
});
