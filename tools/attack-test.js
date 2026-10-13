// Tries the attacks from the NDNoT chapter against the door and checks each
// is blocked. Works against the mock or the real ESP32.
// Usage: DOOR=127.0.0.1:18080 DOOR_SECRET=<hex> node tools/attack-test.js
const crypto = require("crypto");

const DOOR = process.env.DOOR ?? "127.0.0.1:18080";
const SECRET = process.env.DOOR_SECRET;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function sign(action, nonce, secret = SECRET) {
  return crypto.createHmac("sha256", secret).update(`${action}|${nonce}`).digest("hex");
}

async function get(path) {
  const res = await fetch(`http://${DOOR}${path}`);
  return res.status;
}

async function check(name, path, expected) {
  await sleep(1100); // stay under the rate limit so each test sees its own rule
  const status = await get(path);
  console.log(`${status === expected ? "PASS" : "FAIL"}  ${name}: got ${status}, expected ${expected}`);
  return status === expected;
}

async function main() {
  const results = [];
  const nonce = Date.now();
  const validPath = `/on?nonce=${nonce}&sig=${sign("on", nonce)}`;

  results.push(await check("Unauthorized access (plain /on, no signature)", "/on", 401));
  results.push(await check("Forged signature (wrong secret)", `/on?nonce=${nonce}&sig=${sign("on", nonce, "attacker-guess")}`, 401));
  results.push(await check("Signature reused for a different action", `/off?nonce=${nonce}&sig=${sign("on", nonce)}`, 401));
  results.push(await check("Legitimate signed command", validPath, 200));
  results.push(await check("Replay attack (resend captured command)", validPath, 409));
  results.push(await check("Old nonce with valid signature", `/on?nonce=${nonce - 5000}&sig=${sign("on", nonce - 5000)}`, 409));

  await sleep(1100);
  const flood = await Promise.all(Array.from({ length: 20 }, () => get("/on")));
  const limited = flood.filter((s) => s === 429).length;
  const ok = limited >= 19;
  console.log(`${ok ? "PASS" : "FAIL"}  Flooding (20 requests at once): ${limited} rejected with 429`);
  results.push(ok);

  console.log(`\n${results.filter(Boolean).length}/${results.length} passed`);
  process.exitCode = results.every(Boolean) ? 0 : 1;
}

main();
