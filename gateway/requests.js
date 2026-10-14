// Unlock request state machine (SPEC.md 5.1 timers, 5.2 states and atomicity).
//
//   CREATED --fob--> FOB_VERIFIED --challenge--> CHALLENGE_ISSUED --beginVerify--> VERIFYING
//     --authorize--> AUTHORIZED --consume--> CONSUMED
//   any non-terminal state --deadline--> EXPIRED, --reject--> REJECTED
//
// Every method is synchronous. A caller must take the state (beginVerify)
// before awaiting the chain, and call consume() before producing an unlock
// command, so a parallel caller can never pass the same checks during an await.
//
// Deadlines use a monotonic clock, so NTP corrections cannot stretch or cut
// them. The wall clock is only used to tell the wallet when its challenge
// expires (Unix seconds in the EIP-712 message).
const crypto = require("crypto");
const { parseRoomId, parseWallet } = require("./validate");

const DEFAULT_LIMITS = {
  fobMs: 30_000, // creation -> fob tap
  signMs: 30_000, // fob tap -> signature received
  verifyMs: 5_000, // signature received -> consumed (covers the chain call)
  maxReissues: 3, // re-issued challenges after the first one
  retainMs: 5 * 60_000, // keep finished requests this long for the audit trail
};

const TERMINAL = new Set(["CONSUMED", "EXPIRED", "REJECTED"]);

class RequestError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "RequestError";
    this.code = code;
  }
}

function createRequestStore({
  monoNow = () => performance.now(),
  wallNow = Date.now,
  randomBytes = crypto.randomBytes,
  limits = {},
} = {}) {
  const cfg = { ...DEFAULT_LIMITS, ...limits };
  const requests = new Map();

  const randomHex32 = () => "0x" + Buffer.from(randomBytes(32)).toString("hex");

  // Moves a request to EXPIRED if the deadline of its current state has passed.
  // The result is stored, so an expired request stays expired.
  function refresh(req) {
    if (!TERMINAL.has(req.state) && monoNow() >= req.deadline) {
      req.state = "EXPIRED";
      req.finishedAt = monoNow();
    }
    return req;
  }

  function load(requestId) {
    const req = requests.get(requestId);
    if (!req) throw new RequestError("UNKNOWN_REQUEST", "unknown request");
    return refresh(req);
  }

  // Compare-and-set: only proceeds if the request is in `expected` right now.
  function expectState(req, expected) {
    if (req.state === "EXPIRED" && !expected.includes("EXPIRED")) {
      throw new RequestError("EXPIRED", "request expired");
    }
    if (!expected.includes(req.state)) {
      throw new RequestError("WRONG_STATE", `request is ${req.state}, expected ${expected.join(" or ")}`);
    }
  }

  function expectSession(req, sessionId) {
    if (sessionId !== req.sessionId) throw new RequestError("WRONG_SESSION", "request belongs to another session");
  }

  // Each verification claim gets its own token. Results from the async chain
  // check must present it, so a stale result can never authorize anything
  // other than the claim that started it.
  function expectAttempt(req, attempt) {
    if (typeof attempt !== "string" || attempt !== req.attempt) {
      throw new RequestError("BAD_ATTEMPT", "result does not belong to the current verification attempt");
    }
  }

  function finish(req, state, reason) {
    req.state = state;
    req.reason = reason;
    req.finishedAt = monoNow();
    req.nonce = null;
    req.attempt = null;
  }

  return {
    create({ roomId, wallet, sessionId }) {
      const room = parseRoomId(roomId);
      const renter = parseWallet(wallet);
      if (typeof sessionId !== "string" || sessionId.length === 0) throw new TypeError("invalid session id");

      let requestId = randomHex32();
      while (requests.has(requestId)) requestId = randomHex32();
      requests.set(requestId, {
        requestId,
        roomId: room,
        wallet: renter,
        sessionId,
        state: "CREATED",
        deadline: monoNow() + cfg.fobMs,
        challenges: 0,
        nonce: null,
      });
      return { requestId, fobDeadlineMs: cfg.fobMs };
    },

    recordFob(requestId) {
      const req = load(requestId);
      expectState(req, ["CREATED"]);
      req.state = "FOB_VERIFIED";
      // The signing phase gets its own full window, however late the tap was.
      req.deadline = monoNow() + cfg.signMs;
      req.signExpiresAt = Math.floor((wallNow() + cfg.signMs) / 1000);
    },

    issueChallenge(requestId, sessionId) {
      const req = load(requestId);
      expectState(req, ["FOB_VERIFIED", "CHALLENGE_ISSUED"]);
      expectSession(req, sessionId);
      if (req.challenges > cfg.maxReissues) {
        throw new RequestError("TOO_MANY_CHALLENGES", "challenge re-issued too many times");
      }
      req.challenges++;
      req.state = "CHALLENGE_ISSUED";
      req.nonce = randomHex32(); // replaces, and so invalidates, any earlier nonce
      // Re-issuing never extends the signing deadline.
      return { requestId, nonce: req.nonce, expiresAt: req.signExpiresAt, roomId: req.roomId, wallet: req.wallet };
    },

    // Synchronous claim of the right to verify. Call before any await.
    beginVerify(requestId, { nonce, sessionId }) {
      const req = load(requestId);
      expectState(req, ["CHALLENGE_ISSUED"]);
      expectSession(req, sessionId);
      if (typeof nonce !== "string" || nonce !== req.nonce) throw new RequestError("BAD_NONCE", "nonce is not current");
      // Snapshot of the server-owned challenge being consumed, taken in the same
      // synchronous step as the claim. The signature is checked against this,
      // never against anything the client sends.
      const challenge = { nonce: req.nonce, expiresAt: req.signExpiresAt };
      req.state = "VERIFYING";
      req.nonce = null; // consumed: no second attempt with the same nonce
      req.deadline = monoNow() + cfg.verifyMs;
      req.attempt = randomHex32();
      return { attempt: req.attempt, roomId: req.roomId, wallet: req.wallet, ...challenge };
    },

    // After the awaited checks passed. Re-checks state, deadline and attempt,
    // so a late result (after the 5 s deadline) is refused.
    authorize(requestId, attempt) {
      const req = load(requestId);
      expectState(req, ["VERIFYING"]);
      expectAttempt(req, attempt);
      req.state = "AUTHORIZED";
    },

    // Returns the one and only grant for this request; call before building
    // the unlock command. If sending that command fails, the request stays
    // CONSUMED: a new command needs a new request.
    consume(requestId, attempt) {
      const req = load(requestId);
      expectState(req, ["AUTHORIZED"]);
      expectAttempt(req, attempt);
      finish(req, "CONSUMED");
      return { requestId, roomId: req.roomId, wallet: req.wallet };
    },

    reject(requestId, reason) {
      const req = load(requestId);
      if (TERMINAL.has(req.state)) {
        throw new RequestError("WRONG_STATE", `request is already ${req.state}`);
      }
      finish(req, "REJECTED", reason);
    },

    get(requestId) {
      const req = requests.get(requestId);
      if (!req) return undefined;
      refresh(req);
      return { requestId, state: req.state, reason: req.reason, roomId: req.roomId, wallet: req.wallet };
    },

    // Drops finished requests once they are older than the retention period.
    sweep() {
      for (const [id, req] of requests) {
        refresh(req);
        if (TERMINAL.has(req.state) && monoNow() - req.finishedAt >= cfg.retainMs) requests.delete(id);
      }
    },
  };
}

module.exports = { createRequestStore, RequestError, DEFAULT_LIMITS };
