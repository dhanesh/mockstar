// Webhook receiver for one verify instance. Usage: bun receiver.ts <port> <jsonl-out>
// Appends one JSON line per request (method, path, headers, body) to <jsonl-out> and answers
// 200. GET /__rx/health returns {"ok":true,"pid":<this pid>} so launch can prove that the
// process it started is the one answering on the port.
import { appendFileSync } from "node:fs";

const [portArg, out] = process.argv.slice(2);
if (!portArg || !out) {
  console.error("usage: bun receiver.ts <port> <jsonl-out>");
  process.exit(2);
}

Bun.serve({
  hostname: "127.0.0.1",
  port: Number(portArg),
  async fetch(req) {
    const url = new URL(req.url);
    if (req.method === "GET" && url.pathname === "/__rx/health") {
      return Response.json({ ok: true, pid: process.pid });
    }
    const body = await req.text();
    appendFileSync(
      out,
      `${JSON.stringify({
        at: new Date().toISOString(),
        method: req.method,
        path: url.pathname,
        headers: Object.fromEntries(req.headers),
        body,
      })}\n`,
    );
    return Response.json({ received: true });
  },
});
console.log(`receiver listening on 127.0.0.1:${portArg} pid=${process.pid}`);
