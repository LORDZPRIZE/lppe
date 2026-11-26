// This reader has no provider credentials or network fallback.
export async function onRequestGet({request}) {
  const date = new URL(request.url).searchParams.get("date") || "";
  const reply = (body,status) => Response.json(body,{status,headers:{"Cache-Control":"no-store"}});
  const parsed = Date.parse(date+"T00:00:00Z");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !Number.isFinite(parsed) ||
      new Date(parsed).toISOString().slice(0,10) !== date) {
    return reply({error:"Provide a valid NBA Main slate date (YYYY-MM-DD)."},400);
  }
  const key = new Request(new URL("/lppe-internal/fanduel-v9/NBA/saved-main/"+date,request.url));
  const cached = await caches.default.match(key);
  if (cached) {
    const snapshot = await cached.json();
    if (snapshot.date === date && snapshot.lockAt > Date.now()) return reply(snapshot,200);
  }
  return reply({error:"No saved pre-lock NBA Main pool is available here for this date."},404);
}
