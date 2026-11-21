const workerOrigin = "https://lppe-api.lord-joseph.workers.dev";

export async function onRequestGet({request}) {
  const scan = new URL(request.url).searchParams.get("scan") === "1";
  const path = scan ? "/api/prizepicks/scan" : "/api/prizepicks";
  const backend = "worker";
  try {
    const result = await fetch(workerOrigin + path,{signal:AbortSignal.timeout(18000)});
    const headers = new Headers({
      "Content-Type":result.headers.get("Content-Type") || "application/json",
      "Cache-Control":"no-store",
      "X-LPPE-Board-Backend":backend
    });
    const retry = result.headers.get("Retry-After");
    if (retry) headers.set("Retry-After",retry);
    return new Response(result.body,{status:result.status,headers});
  } catch {
    return Response.json({error:"PrizePicks board temporarily unavailable"},{
      status:502,headers:{"Cache-Control":"no-store","X-LPPE-Board-Backend":backend}
    });
  }
}
