// Stage B2: request state machine (SPEC.md 5.1 timers, 5.2 states and atomicity).
// Written before gateway/requests.js, test-first.
const { expect } = require("chai");
const { createRequestStore, RequestError } = require("../../gateway/requests");

const ROOM = 101;
const WALLET = "0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC";
const SESSION = "session-a";

// Monotonic clock (deadlines) and wall clock (Unix expiresAt) are separate and
// move independently, so tests can make the wall clock jump.
function fakeClocks() {
  const c = { mono: 1_000_000, wall: Date.UTC(2026, 9, 15, 3, 0, 0) };
  c.monoNow = () => c.mono;
  c.wallNow = () => c.wall;
  c.advance = (ms) => {
    c.mono += ms;
    c.wall += ms;
  };
  return c;
}

function newStore(clocks, extra = {}) {
  return createRequestStore({ monoNow: clocks.monoNow, wallNow: clocks.wallNow, ...extra });
}

function readyToSign(store, clocks) {
  const { requestId } = store.create({ roomId: ROOM, wallet: WALLET, sessionId: SESSION });
  store.recordFob(requestId);
  const challenge = store.issueChallenge(requestId, SESSION);
  return { requestId, challenge };
}

function expectCode(fn, code) {
  let error;
  try {
    fn();
  } catch (err) {
    error = err;
  }
  expect(error, `expected RequestError ${code}`).to.be.instanceOf(RequestError);
  expect(error.code).to.equal(code);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

describe("Gateway B2: request state machine", function () {
  describe("requestId", function () {
    it("is 32 random bytes as 0x-prefixed hex", function () {
      const store = newStore(fakeClocks());
      const { requestId } = store.create({ roomId: ROOM, wallet: WALLET, sessionId: SESSION });
      expect(requestId).to.match(/^0x[0-9a-f]{64}$/);
    });

    it("never repeats across 10,000 requests", function () {
      const store = newStore(fakeClocks());
      const ids = new Set();
      for (let i = 0; i < 10_000; i++) ids.add(store.create({ roomId: ROOM, wallet: WALLET, sessionId: SESSION }).requestId);
      expect(ids.size).to.equal(10_000);
    });

    it("refuses to reuse an id even if the random source repeats", function () {
      const fixed = Buffer.alloc(32, 7);
      let calls = 0;
      const store = newStore(fakeClocks(), {
        randomBytes: (n) => {
          calls++;
          return calls <= 2 ? fixed : Buffer.alloc(n, calls);
        },
      });
      const a = store.create({ roomId: ROOM, wallet: WALLET, sessionId: SESSION }).requestId;
      const b = store.create({ roomId: ROOM, wallet: WALLET, sessionId: SESSION }).requestId;
      expect(a).to.not.equal(b);
    });

    it("validates room, wallet and session when creating", function () {
      const store = newStore(fakeClocks());
      expect(() => store.create({ roomId: -1, wallet: WALLET, sessionId: SESSION })).to.throw(/room/);
      expect(() => store.create({ roomId: ROOM, wallet: "0x12", sessionId: SESSION })).to.throw(/wallet/);
      expect(() => store.create({ roomId: ROOM, wallet: WALLET, sessionId: "" })).to.throw(/session/);
    });

    it("rejects unknown request ids", function () {
      const store = newStore(fakeClocks());
      expectCode(() => store.recordFob("0x" + "ab".repeat(32)), "UNKNOWN_REQUEST");
    });
  });

  describe("fob phase (30 s from creation)", function () {
    it("accepts a fob tap at 29.999 s", function () {
      const clocks = fakeClocks();
      const store = newStore(clocks);
      const { requestId } = store.create({ roomId: ROOM, wallet: WALLET, sessionId: SESSION });
      clocks.advance(29_999);
      store.recordFob(requestId);
      expect(store.get(requestId).state).to.equal("FOB_VERIFIED");
    });

    it("rejects a fob tap at exactly 30 s and marks the request EXPIRED", function () {
      const clocks = fakeClocks();
      const store = newStore(clocks);
      const { requestId } = store.create({ roomId: ROOM, wallet: WALLET, sessionId: SESSION });
      clocks.advance(30_000);
      expectCode(() => store.recordFob(requestId), "EXPIRED");
      expect(store.get(requestId).state).to.equal("EXPIRED");
    });

    it("accepts only the first of two simultaneous fob taps", function () {
      const store = newStore(fakeClocks());
      const { requestId } = store.create({ roomId: ROOM, wallet: WALLET, sessionId: SESSION });
      store.recordFob(requestId);
      expectCode(() => store.recordFob(requestId), "WRONG_STATE");
    });
  });

  describe("signing phase (30 s from the fob tap)", function () {
    it("gives the full 30 s even when the fob was tapped at 29 s", function () {
      const clocks = fakeClocks();
      const store = newStore(clocks);
      const { requestId } = store.create({ roomId: ROOM, wallet: WALLET, sessionId: SESSION });
      clocks.advance(29_000);
      store.recordFob(requestId);
      const challenge = store.issueChallenge(requestId, SESSION);
      clocks.advance(29_999);
      store.beginVerify(requestId, { nonce: challenge.nonce, sessionId: SESSION });
      expect(store.get(requestId).state).to.equal("VERIFYING");
    });

    it("rejects a signature at exactly 30 s after the fob tap", function () {
      const clocks = fakeClocks();
      const store = newStore(clocks);
      const { requestId, challenge } = readyToSign(store, clocks);
      clocks.advance(30_000);
      expectCode(() => store.beginVerify(requestId, { nonce: challenge.nonce, sessionId: SESSION }), "EXPIRED");
    });

    it("sets expiresAt (Unix seconds) to the end of the signing phase", function () {
      const clocks = fakeClocks();
      const store = newStore(clocks);
      const { requestId } = store.create({ roomId: ROOM, wallet: WALLET, sessionId: SESSION });
      store.recordFob(requestId);
      const fobWall = clocks.wall;
      clocks.advance(10_000);
      const challenge = store.issueChallenge(requestId, SESSION);
      expect(challenge.expiresAt).to.equal(Math.floor((fobWall + 30_000) / 1000));
      expect(challenge.nonce).to.match(/^0x[0-9a-f]{64}$/);
    });

    it("cannot issue a challenge before the fob tap", function () {
      const store = newStore(fakeClocks());
      const { requestId } = store.create({ roomId: ROOM, wallet: WALLET, sessionId: SESSION });
      expectCode(() => store.issueChallenge(requestId, SESSION), "WRONG_STATE");
    });
  });

  describe("challenge re-issue", function () {
    it("invalidates the old nonce immediately", function () {
      const clocks = fakeClocks();
      const store = newStore(clocks);
      const { requestId, challenge: first } = readyToSign(store, clocks);
      const second = store.issueChallenge(requestId, SESSION);
      expect(second.nonce).to.not.equal(first.nonce);
      expectCode(() => store.beginVerify(requestId, { nonce: first.nonce, sessionId: SESSION }), "BAD_NONCE");
      store.beginVerify(requestId, { nonce: second.nonce, sessionId: SESSION });
    });

    it("allows 3 re-issues and rejects the 4th", function () {
      const clocks = fakeClocks();
      const store = newStore(clocks);
      const { requestId } = readyToSign(store, clocks);
      for (let i = 0; i < 3; i++) store.issueChallenge(requestId, SESSION);
      expectCode(() => store.issueChallenge(requestId, SESSION), "TOO_MANY_CHALLENGES");
    });

    it("does not extend the signing deadline", function () {
      const clocks = fakeClocks();
      const store = newStore(clocks);
      const { requestId, challenge: first } = readyToSign(store, clocks);
      clocks.advance(25_000);
      const again = store.issueChallenge(requestId, SESSION);
      expect(again.expiresAt).to.equal(first.expiresAt);
      clocks.advance(5_000); // 30 s after the fob tap
      expectCode(() => store.beginVerify(requestId, { nonce: again.nonce, sessionId: SESSION }), "EXPIRED");
    });
  });

  describe("session binding", function () {
    it("rejects another session issuing or using a challenge", function () {
      const clocks = fakeClocks();
      const store = newStore(clocks);
      const { requestId, challenge } = readyToSign(store, clocks);
      expectCode(() => store.issueChallenge(requestId, "session-b"), "WRONG_SESSION");
      expectCode(() => store.beginVerify(requestId, { nonce: challenge.nonce, sessionId: "session-b" }), "WRONG_SESSION");
      expect(store.get(requestId).state).to.equal("CHALLENGE_ISSUED");
    });
  });

  describe("atomic verification", function () {
    it("lets only one of two identical submissions enter VERIFYING", function () {
      const clocks = fakeClocks();
      const store = newStore(clocks);
      const { requestId, challenge } = readyToSign(store, clocks);
      const submission = { nonce: challenge.nonce, sessionId: SESSION };
      store.beginVerify(requestId, submission);
      expectCode(() => store.beginVerify(requestId, submission), "WRONG_STATE");
    });

    it("produces exactly one consumption when two flows race across an await", async function () {
      const clocks = fakeClocks();
      const store = newStore(clocks);
      const { requestId, challenge } = readyToSign(store, clocks);
      let chainCalls = 0;

      // Same shape the B3 handler will have: take the state first, then await the chain.
      async function flow() {
        try {
          store.beginVerify(requestId, { nonce: challenge.nonce, sessionId: SESSION });
        } catch (err) {
          return `rejected:${err.code}`;
        }
        chainCalls++;
        await sleep(200); // slow hasAccess()
        store.authorize(requestId);
        return store.consume(requestId) ? "consumed" : "none";
      }

      const results = await Promise.all([flow(), flow(), flow()]);
      expect(results.filter((r) => r === "consumed")).to.have.lengthOf(1);
      expect(results.filter((r) => r === "rejected:WRONG_STATE")).to.have.lengthOf(2);
      expect(chainCalls).to.equal(1);
      expect(store.get(requestId).state).to.equal("CONSUMED");
    });

    it("consumes only once; a second consume is refused", function () {
      const clocks = fakeClocks();
      const store = newStore(clocks);
      const { requestId, challenge } = readyToSign(store, clocks);
      store.beginVerify(requestId, { nonce: challenge.nonce, sessionId: SESSION });
      store.authorize(requestId);
      const grant = store.consume(requestId);
      expect(grant).to.include({ requestId, roomId: 101n, wallet: WALLET });
      expectCode(() => store.consume(requestId), "WRONG_STATE");
    });

    it("refuses to consume while still VERIFYING (no grant without the chain check)", function () {
      const clocks = fakeClocks();
      const store = newStore(clocks);
      const { requestId, challenge } = readyToSign(store, clocks);
      store.beginVerify(requestId, { nonce: challenge.nonce, sessionId: SESSION });
      expectCode(() => store.consume(requestId), "WRONG_STATE");
      expect(store.get(requestId).state).to.equal("VERIFYING");
    });

    it("cannot authorize or consume out of order", function () {
      const clocks = fakeClocks();
      const store = newStore(clocks);
      const { requestId } = readyToSign(store, clocks);
      expectCode(() => store.authorize(requestId), "WRONG_STATE");
      expectCode(() => store.consume(requestId), "WRONG_STATE");
    });
  });

  describe("failure and recovery", function () {
    it("moves to REJECTED when verification fails, and the nonce cannot be retried", function () {
      const clocks = fakeClocks();
      const store = newStore(clocks);
      const { requestId, challenge } = readyToSign(store, clocks);
      store.beginVerify(requestId, { nonce: challenge.nonce, sessionId: SESSION });
      store.reject(requestId, "RPC timeout");
      expect(store.get(requestId)).to.include({ state: "REJECTED", reason: "RPC timeout" });
      expectCode(() => store.beginVerify(requestId, { nonce: challenge.nonce, sessionId: SESSION }), "WRONG_STATE");
      expectCode(() => store.issueChallenge(requestId, SESSION), "WRONG_STATE");
    });

    it("never stays stuck in VERIFYING: it expires after 5 s even if the chain never answers", function () {
      const clocks = fakeClocks();
      const store = newStore(clocks);
      const { requestId, challenge } = readyToSign(store, clocks);
      store.beginVerify(requestId, { nonce: challenge.nonce, sessionId: SESSION });
      clocks.advance(5_000);
      expect(store.get(requestId).state).to.equal("EXPIRED");
      expectCode(() => store.authorize(requestId), "EXPIRED");
    });

    it("refuses to consume once the request has expired, even if AUTHORIZED", function () {
      const clocks = fakeClocks();
      const store = newStore(clocks);
      const { requestId, challenge } = readyToSign(store, clocks);
      store.beginVerify(requestId, { nonce: challenge.nonce, sessionId: SESSION });
      store.authorize(requestId);
      clocks.advance(5_000);
      expectCode(() => store.consume(requestId), "EXPIRED");
    });

    it("refuses to consume a revoked request", function () {
      const clocks = fakeClocks();
      const store = newStore(clocks);
      const { requestId, challenge } = readyToSign(store, clocks);
      store.beginVerify(requestId, { nonce: challenge.nonce, sessionId: SESSION });
      store.authorize(requestId);
      store.reject(requestId, "revoked by admin");
      expectCode(() => store.consume(requestId), "WRONG_STATE");
    });

    it("keeps terminal states terminal", function () {
      const clocks = fakeClocks();
      const store = newStore(clocks);
      const { requestId, challenge } = readyToSign(store, clocks);
      store.beginVerify(requestId, { nonce: challenge.nonce, sessionId: SESSION });
      store.authorize(requestId);
      store.consume(requestId);
      expectCode(() => store.reject(requestId, "late"), "WRONG_STATE");
      expect(store.get(requestId).state).to.equal("CONSUMED");
    });

    it("an expired request can never be authorized again", function () {
      const clocks = fakeClocks();
      const store = newStore(clocks);
      const { requestId, challenge } = readyToSign(store, clocks);
      clocks.advance(30_000);
      expect(store.get(requestId).state).to.equal("EXPIRED");
      clocks.mono -= 60_000; // even if the clock source misbehaved later
      expectCode(() => store.beginVerify(requestId, { nonce: challenge.nonce, sessionId: SESSION }), "EXPIRED");
      expect(store.get(requestId).state).to.equal("EXPIRED");
    });
  });

  describe("monotonic deadlines", function () {
    it("is not fooled by the wall clock jumping back an hour", function () {
      const clocks = fakeClocks();
      const store = newStore(clocks);
      const { requestId } = store.create({ roomId: ROOM, wallet: WALLET, sessionId: SESSION });
      clocks.wall -= 3_600_000; // NTP step backwards
      clocks.mono += 30_000; // real time still passes
      expectCode(() => store.recordFob(requestId), "EXPIRED");
    });

    it("is not fooled by the wall clock jumping forward an hour", function () {
      const clocks = fakeClocks();
      const store = newStore(clocks);
      const { requestId } = store.create({ roomId: ROOM, wallet: WALLET, sessionId: SESSION });
      clocks.wall += 3_600_000;
      clocks.mono += 1_000;
      store.recordFob(requestId);
      expect(store.get(requestId).state).to.equal("FOB_VERIFIED");
    });
  });

  describe("housekeeping", function () {
    it("sweeps finished requests out of memory after a grace period", function () {
      const clocks = fakeClocks();
      const store = newStore(clocks);
      const { requestId } = store.create({ roomId: ROOM, wallet: WALLET, sessionId: SESSION });
      clocks.advance(30_000);
      store.sweep();
      expect(store.get(requestId).state).to.equal("EXPIRED"); // kept for a while for the audit trail
      clocks.advance(10 * 60_000);
      store.sweep();
      expect(store.get(requestId)).to.equal(undefined);
    });
  });
});
