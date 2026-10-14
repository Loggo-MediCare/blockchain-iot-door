// EIP-712 unlock authorization (SPEC.md 5 steps 4-5, 5.2, 5.5, 7).
//
// The only inputs taken from the browser are the request id, session id, the
// nonce (which selects the challenge) and the signature. The typed data that
// is verified is rebuilt from the gateway's own state: the domain from the
// chain that passed the bytecode check, the message from the challenge
// snapshot returned by beginVerify(). Any domain, message, time or checkOut the
// browser sends is ignored.
//
// A grant is returned only when the signature, request state, attempt token,
// deadline and the current on-chain booking all agree. This module never
// builds or sends an unlock command; that is B4.
const { ethers } = require("ethers");

const UNLOCK_TYPES = {
  Unlock: [
    { name: "action", type: "string" },
    { name: "roomId", type: "uint256" },
    { name: "wallet", type: "address" },
    { name: "requestId", type: "bytes32" },
    { name: "nonce", type: "bytes32" },
    { name: "expiresAt", type: "uint64" },
  ],
};

const COMMAND_VALIDITY_SECONDS = 5;

function createUnlockService({ store, chain }) {
  const domain = Object.freeze({
    name: "BlockchainIoTDoor",
    version: "1",
    chainId: chain.chainId,
    verifyingContract: chain.address,
  });

  // `step` names the check that refused, so tests can tell which layer acted.
  function failure(requestId, code, detail, step) {
    return { ok: false, code, step, detail, state: store.get(requestId)?.state };
  }

  // Ends a claimed verification. The request may already be terminal (for
  // example EXPIRED while the chain call was pending); that is fine.
  function rejectClaim(requestId, code, detail, step) {
    try {
      store.reject(requestId, code);
    } catch {
      // already terminal
    }
    return failure(requestId, code, detail, step);
  }

  return {
    domain,

    // Typed data for the wallet to sign, built entirely from server state.
    challenge(requestId, sessionId) {
      const c = store.issueChallenge(requestId, sessionId);
      return {
        domain,
        types: UNLOCK_TYPES,
        primaryType: "Unlock",
        message: {
          action: "UNLOCK",
          roomId: c.roomId,
          wallet: c.wallet,
          requestId,
          nonce: c.nonce,
          expiresAt: c.expiresAt,
        },
      };
    },

    async submit(requestId, body) {
      const { sessionId, nonce, signature } = body ?? {};

      // 1. Synchronous claim. Checks state, session, nonce and deadline.
      let claim;
      try {
        claim = store.beginVerify(requestId, { nonce, sessionId });
      } catch (err) {
        return failure(requestId, err.code ?? "BAD_REQUEST", err.message, "claim");
      }

      // 2. Signature over the server-owned challenge (synchronous, no chain call).
      const message = {
        action: "UNLOCK",
        roomId: claim.roomId,
        wallet: claim.wallet,
        requestId,
        nonce: claim.nonce,
        expiresAt: claim.expiresAt,
      };
      let signer = null;
      try {
        signer = ethers.verifyTypedData(domain, UNLOCK_TYPES, message, signature);
      } catch {
        signer = null;
      }
      if (signer !== claim.wallet) return rejectClaim(requestId, "BAD_SIGNATURE", undefined, "signature");

      // 3. Current on-chain booking, with the gateway clock and a real timeout.
      let access;
      try {
        access = await chain.checkAccess(claim.roomId, claim.wallet);
      } catch (err) {
        return rejectClaim(requestId, err.code === "CHAIN_IDENTITY" ? "CHAIN_IDENTITY" : "RPC_ERROR", err.message, "chain");
      }
      if (!access.allowed) return rejectClaim(requestId, "NO_ACCESS", undefined, "chain");

      // 4. No await from here on: authorize, consume, build the grant.
      const now = chain.gatewaySeconds();
      const booking = access.booking;
      if (!booking || !(booking.checkOut > now)) return rejectClaim(requestId, "INCONSISTENT_BOOKING", undefined, "booking");
      try {
        store.authorize(requestId, claim.attempt); // refuses a late result by itself
      } catch (err) {
        return failure(requestId, err.code, err.message, "authorize");
      }
      let grant;
      try {
        grant = store.consume(requestId, claim.attempt);
      } catch (err) {
        return failure(requestId, err.code, err.message, "consume");
      }
      return {
        ok: true,
        grant: {
          ...grant,
          bookingId: booking.bookingId,
          checkOut: booking.checkOut,
          // SPEC 5.5: never valid after the stay ends.
          commandExpiresAt: Math.min(now + COMMAND_VALIDITY_SECONDS, booking.checkOut),
        },
      };
    },
  };
}

module.exports = { createUnlockService, UNLOCK_TYPES, COMMAND_VALIDITY_SECONDS };
