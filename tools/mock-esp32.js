// Stand-in for the ESP32 door on the Mac, applying the same rules as
// esp32/door_lock/door_lock.ino, so the listener and the attack tests can run
// without hardware. Usage: DOOR_SECRET=<hex> PORT=18080 node tools/mock-esp32.js
const crypto = require("crypto");
const http = require("http");

const SECRET = process.env.DOOR_SECRET;
const PORT = Number(process.env.PORT ?? 18080);
const MIN_INTERVAL_MS = 1000;

let lastNonce = 0n;
let lastRequestAt = null;

function authorize(action, params) {
  const now = Date.now();
  if (lastRequestAt !== null && now - lastRequestAt < MIN_INTERVAL_MS) return [429, "too many requests"];
  lastRequestAt = now;

  const nonce = params.get("nonce");
  const sig = (params.get("sig") ?? "").toLowerCase();
  if (!nonce || !sig) return [401, "missing signature"];

  const expected = crypto.createHmac("sha256", SECRET).update(`${action}|${nonce}`).digest("hex");
  if (sig.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) {
    return [401, "bad signature"];
  }
  if (BigInt(nonce) <= lastNonce) return [409, "replayed command"];
  lastNonce = BigInt(nonce);
  return null;
}

http
  .createServer((req, res) => {
    const url = new URL(req.url, "http://localhost");
    const action = url.pathname.slice(1);
    if (action !== "on" && action !== "off") {
      res.writeHead(404).end("not found");
      return;
    }
    const rejected = authorize(action, url.searchParams);
    const [status, body] = rejected ?? [200, action === "on" ? "door unlocked" : "door locked"];
    console.log(`${req.url.split("&sig")[0]} -> ${status} ${body}`);
    res.writeHead(status, { "content-type": "text/plain" }).end(body);
  })
  .listen(PORT, "127.0.0.1", () => console.log(`Mock ESP32 door on http://127.0.0.1:${PORT}`));
