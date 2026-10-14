// Stage B3: EIP-712 verification wired to the state machine and the chain
// (SPEC.md 5 steps 4-5, 5.2, 5.5, 7). Written before gateway/authorize.js.
const { expect } = require("chai");
const path = require("path");
const { ethers } = require("hardhat");
const { time, reset } = require("@nomicfoundation/hardhat-network-helpers");
const { connectChain } = require("../../gateway/chain");
const { createRequestStore } = require("../../gateway/requests");
const { createUnlockService, UNLOCK_TYPES } = require("../../gateway/authorize");

const ROOM = 101;
const PRICE = ethers.parseEther("0.01");
const NIGHT = 24 * 60 * 60;
const CHAIN_ID = 31337;
const SESSION = "session-a";
const PROJECT_ROOT = path.join(__dirname, "..", "..");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// One fake clock drives everything: wall time (gateway clock, expiresAt) and a
// monotonic counter (state machine deadlines) that advance together.
function fakeTime(wallSeconds) {
  const t = { wall: wallSeconds * 1000, mono: 0 };
  t.advance = (ms) => {
    t.wall += ms;
    t.mono += ms;
  };
  return t;
}

async function setupRealChain() {
  await reset();
  const [, payer, renter, stranger] = await ethers.getSigners();
  const booking = await ethers.deployContract("RentalBooking");
  await booking.setRoom(ROOM, PRICE, true);
  const day0 = (Math.floor((await time.latest()) / NIGHT) + 2) * NIGHT;
  const checkIn = day0;
  const checkOut = day0 + 2 * NIGHT;
  await booking.connect(payer).book(ROOM, checkIn, checkOut, renter.address, { value: PRICE * 2n });

  const t = fakeTime(checkIn + 60); // gateway clock: one minute into the stay
  const chain = await connectChain({
    provider: ethers.provider,
    address: await booking.getAddress(),
    chainId: CHAIN_ID,
    projectRoot: PROJECT_ROOT,
    now: () => t.wall,
  });
  const store = createRequestStore({ monoNow: () => t.mono, wallNow: () => t.wall });
  const service = createUnlockService({ store, chain });
  return { booking, chain, store, service, t, payer, renter, stranger, checkIn, checkOut };
}

// Creates a request for `wallet`, records the fob tap and fetches the challenge.
function openRequest(ctx, wallet) {
  const { requestId } = ctx.store.create({ roomId: ROOM, wallet, sessionId: SESSION });
  ctx.store.recordFob(requestId);
  const typed = ctx.service.challenge(requestId, SESSION);
  return { requestId, typed };
}

function sign(signer, typed, overrides = {}) {
  const domain = { ...typed.domain, ...(overrides.domain ?? {}) };
  const message = { ...typed.message, ...(overrides.message ?? {}) };
  return signer.signTypedData(domain, UNLOCK_TYPES, message);
}

describe("Gateway B3: EIP-712 unlock verification", function () {
  describe("against the real contract and real wallet signatures", function () {
    let ctx;
    beforeEach(async function () {
      ctx = await setupRealChain();
    });

    it("authorizes a correct signature for a valid booking, with a trusted checkOut", async function () {
      const { requestId, typed } = openRequest(ctx, ctx.renter.address);
      const signature = await sign(ctx.renter, typed);
      const result = await ctx.service.submit(requestId, { sessionId: SESSION, nonce: typed.message.nonce, signature });

      expect(result.ok, JSON.stringify(result, (k, v) => (typeof v === "bigint" ? v.toString() : v))).to.equal(true);
      expect(result.grant).to.include({ requestId, wallet: ctx.renter.address, bookingId: 1n, checkOut: ctx.checkOut });
      expect(result.grant.roomId).to.equal(BigInt(ROOM));
      expect(result.grant.commandExpiresAt).to.equal(ctx.checkIn + 60 + 5); // min(now + 5 s, checkOut)
      expect(ctx.store.get(requestId).state).to.equal("CONSUMED");
    });

    it("builds the challenge from server state and server domain", function () {
      const { requestId, typed } = openRequest(ctx, ctx.renter.address);
      expect(typed.primaryType).to.equal("Unlock");
      expect(typed.domain).to.deep.equal({
        name: "BlockchainIoTDoor",
        version: "1",
        chainId: CHAIN_ID,
        verifyingContract: ctx.chain.address,
      });
      expect(typed.message).to.include({ action: "UNLOCK", wallet: ctx.renter.address, requestId });
      expect(typed.message.roomId).to.equal(BigInt(ROOM));
      expect(typed.message.expiresAt).to.equal(ctx.checkIn + 60 + 30);
    });

    const tampered = [
      ["another wallet signs", (c) => ({ signer: c.stranger })],
      ["the room id was changed before signing", () => ({ message: { roomId: 102n } })],
      ["the requestId differs", () => ({ message: { requestId: "0x" + "ab".repeat(32) } })],
      ["the nonce differs", () => ({ message: { nonce: "0x" + "cd".repeat(32) } })],
      ["action is not UNLOCK", () => ({ message: { action: "LOCK" } })],
      ["expiresAt was extended", () => ({ message: { expiresAt: 4_000_000_000 } })],
      ["the chain id differs", () => ({ domain: { chainId: 1 } })],
      ["verifyingContract differs", () => ({ domain: { verifyingContract: "0x" + "12".repeat(20) } })],
      ["the domain name differs", () => ({ domain: { name: "SomeOtherApp" } })],
    ];
    for (const [label, change] of tampered) {
      it(`rejects when ${label}`, async function () {
        const { requestId, typed } = openRequest(ctx, ctx.renter.address);
        const { signer = ctx.renter, ...overrides } = change(ctx);
        const signature = await sign(signer, typed, overrides);
        const result = await ctx.service.submit(requestId, { sessionId: SESSION, nonce: typed.message.nonce, signature });
        expect(result).to.include({ ok: false, code: "BAD_SIGNATURE" });
        expect(ctx.store.get(requestId).state).to.equal("REJECTED");
      });
    }

    it("ignores a client-supplied domain and message that match the client's signature", async function () {
      const { requestId, typed } = openRequest(ctx, ctx.renter.address);
      const fakeDomain = { ...typed.domain, chainId: 1 };
      const fakeMessage = { ...typed.message, roomId: 999n };
      const signature = await ctx.renter.signTypedData(fakeDomain, UNLOCK_TYPES, fakeMessage);
      const result = await ctx.service.submit(requestId, {
        sessionId: SESSION,
        nonce: typed.message.nonce,
        signature,
        domain: fakeDomain,
        message: fakeMessage,
        types: UNLOCK_TYPES,
      });
      expect(result).to.include({ ok: false, code: "BAD_SIGNATURE" });
    });

    const clientFields = [
      ["action", "LOCK"],
      ["roomId", 102n],
      ["requestId", "0x" + "ab".repeat(32)],
      ["expiresAt", 4_000_000_000],
      ["wallet", "0x" + "34".repeat(20)],
    ];
    for (const [field, value] of clientFields) {
      it(`ignores a client-supplied ${field} even when the signature matches it on the server domain`, async function () {
        const { requestId, typed } = openRequest(ctx, ctx.renter.address);
        const tamperedMessage = { ...typed.message, [field]: value };
        // Signed over the real server domain, so only the message differs.
        const signature = await ctx.renter.signTypedData(typed.domain, UNLOCK_TYPES, tamperedMessage);
        const result = await ctx.service.submit(requestId, {
          sessionId: SESSION,
          nonce: typed.message.nonce,
          signature,
          message: tamperedMessage,
          [field]: value,
        });
        expect(result).to.include({ ok: false, code: "BAD_SIGNATURE", step: "signature" });
      });
    }

    it("rejects a malformed signature without throwing", async function () {
      const { requestId, typed } = openRequest(ctx, ctx.renter.address);
      for (const signature of ["0x1234", "", null, 42]) {
        const { requestId: id, typed: tp } = openRequest(ctx, ctx.renter.address);
        const result = await ctx.service.submit(id, { sessionId: SESSION, nonce: tp.message.nonce, signature });
        expect(result).to.include({ ok: false, code: "BAD_SIGNATURE" });
      }
      expect(ctx.store.get(requestId).state).to.equal("CHALLENGE_ISSUED"); // untouched
    });

    it("rejects an old nonce after a re-issue, before any verification", async function () {
      const { requestId, typed: first } = openRequest(ctx, ctx.renter.address);
      ctx.service.challenge(requestId, SESSION); // re-issue
      const signature = await sign(ctx.renter, first);
      const result = await ctx.service.submit(requestId, { sessionId: SESSION, nonce: first.message.nonce, signature });
      expect(result).to.include({ ok: false, code: "BAD_NONCE" });
    });

    it("rejects a signature that arrives after the signing window", async function () {
      const { requestId, typed } = openRequest(ctx, ctx.renter.address);
      const signature = await sign(ctx.renter, typed);
      ctx.t.advance(30_000);
      const result = await ctx.service.submit(requestId, { sessionId: SESSION, nonce: typed.message.nonce, signature });
      expect(result).to.include({ ok: false, code: "EXPIRED" });
    });

    it("rejects a valid signature when the booking was cancelled", async function () {
      await ctx.booking.connect(ctx.payer).cancel(1); // chain time is still before check-in
      const { requestId, typed } = openRequest(ctx, ctx.renter.address);
      const signature = await sign(ctx.renter, typed);
      const result = await ctx.service.submit(requestId, { sessionId: SESSION, nonce: typed.message.nonce, signature });
      expect(result).to.include({ ok: false, code: "NO_ACCESS" });
      expect(ctx.store.get(requestId).state).to.equal("REJECTED");
    });

    it("rejects a valid signature after the renter checked out", async function () {
      await time.increaseTo(ctx.checkIn + 30);
      await ctx.booking.connect(ctx.renter).checkOut(1);
      const { requestId, typed } = openRequest(ctx, ctx.renter.address);
      const signature = await sign(ctx.renter, typed);
      const result = await ctx.service.submit(requestId, { sessionId: SESSION, nonce: typed.message.nonce, signature });
      expect(result).to.include({ ok: false, code: "NO_ACCESS" });
    });

    it("rejects the payer (valid signature, but not the renter)", async function () {
      const { requestId, typed } = openRequest(ctx, ctx.payer.address);
      const signature = await sign(ctx.payer, typed);
      const result = await ctx.service.submit(requestId, { sessionId: SESSION, nonce: typed.message.nonce, signature });
      expect(result).to.include({ ok: false, code: "NO_ACCESS" });
    });

    it("ignores injected time and checkOut fields from the client", async function () {
      // Gateway clock after the stay; the client claims a time inside it and a late checkOut.
      ctx.t.wall = (ctx.checkOut + 3600) * 1000;
      const { requestId, typed } = openRequest(ctx, ctx.renter.address);
      const signature = await sign(ctx.renter, typed);
      const result = await ctx.service.submit(requestId, {
        sessionId: SESSION,
        nonce: typed.message.nonce,
        signature,
        time: ctx.checkIn + 60,
        timestamp: ctx.checkIn + 60,
        now: ctx.checkIn + 60,
        checkOut: 4_000_000_000,
      });
      expect(result).to.include({ ok: false, code: "NO_ACCESS" });
    });

    it("caps the command validity at the booking's checkOut", async function () {
      ctx.t.wall = (ctx.checkOut - 2) * 1000; // two seconds before the stay ends
      const { requestId, typed } = openRequest(ctx, ctx.renter.address);
      const signature = await sign(ctx.renter, typed);
      const result = await ctx.service.submit(requestId, {
        sessionId: SESSION,
        nonce: typed.message.nonce,
        signature,
        checkOut: 4_000_000_000, // ignored
      });
      expect(result.ok, JSON.stringify(result, (k, v) => (typeof v === "bigint" ? v.toString() : v))).to.equal(true);
      expect(result.grant.commandExpiresAt).to.equal(ctx.checkOut);
    });

    it("refuses a valid signature when no fob tap was recorded", async function () {
      const { requestId } = ctx.store.create({ roomId: ROOM, wallet: ctx.renter.address, sessionId: SESSION });
      expect(() => ctx.service.challenge(requestId, SESSION)).to.throw(/FOB_VERIFIED/);
      const result = await ctx.service.submit(requestId, { sessionId: SESSION, nonce: "0x" + "00".repeat(32), signature: "0x" });
      expect(result).to.include({ ok: false, code: "WRONG_STATE" });
    });

    it("refuses authorization when the contract identity changes after startup", async function () {
      const { requestId, typed } = openRequest(ctx, ctx.renter.address);
      const signature = await sign(ctx.renter, typed);
      // The node is reset and the old demo contract lands at the same address.
      await reset();
      const impostor = await ethers.deployContract("SimpleIoT");
      expect(await impostor.getAddress()).to.equal(ctx.chain.address);
      const result = await ctx.service.submit(requestId, { sessionId: SESSION, nonce: typed.message.nonce, signature });
      expect(result).to.include({ ok: false, code: "CHAIN_IDENTITY" });
      expect(ctx.store.get(requestId).state).to.equal("REJECTED");
    });

    it("cannot be replayed: the same signature twice yields one grant", async function () {
      const { requestId, typed } = openRequest(ctx, ctx.renter.address);
      const signature = await sign(ctx.renter, typed);
      const body = { sessionId: SESSION, nonce: typed.message.nonce, signature };
      expect((await ctx.service.submit(requestId, body)).ok).to.equal(true);
      expect(await ctx.service.submit(requestId, body)).to.include({ ok: false });
    });
  });

  describe("timing and races (controllable fake chain)", function () {
    const renter = ethers.Wallet.createRandom();

    function setupFakeChain(checkAccessImpl) {
      const t = fakeTime(1_800_000_000);
      const calls = { checkAccess: 0 };
      const chain = {
        address: "0x" + "77".repeat(20),
        chainId: CHAIN_ID,
        gatewaySeconds: () => Math.floor(t.wall / 1000),
        async checkAccess(roomId, wallet) {
          calls.checkAccess++;
          return checkAccessImpl({ roomId, wallet, t });
        },
      };
      const store = createRequestStore({ monoNow: () => t.mono, wallNow: () => t.wall });
      const service = createUnlockService({ store, chain });
      return { t, calls, store, service, chain };
    }

    const validAccess = ({ t }) => ({
      allowed: true,
      checkedAt: Math.floor(t.wall / 1000),
      booking: { bookingId: 7n, checkOut: Math.floor(t.wall / 1000) + NIGHT },
    });

    async function signedRequest(ctx) {
      const { requestId } = ctx.store.create({ roomId: ROOM, wallet: renter.address, sessionId: SESSION });
      ctx.store.recordFob(requestId);
      const typed = ctx.service.challenge(requestId, SESSION);
      const signature = await renter.signTypedData(typed.domain, UNLOCK_TYPES, typed.message);
      return { requestId, body: { sessionId: SESSION, nonce: typed.message.nonce, signature } };
    }

    it("two parallel submissions with a 200 ms chain call: one chain query, one grant", async function () {
      const ctx = setupFakeChain(async (args) => {
        await sleep(200);
        return validAccess(args);
      });
      const { requestId, body } = await signedRequest(ctx);
      const results = await Promise.all([ctx.service.submit(requestId, body), ctx.service.submit(requestId, body)]);
      expect(results.filter((r) => r.ok)).to.have.lengthOf(1);
      expect(results.filter((r) => !r.ok)[0]).to.include({ code: "WRONG_STATE" });
      expect(ctx.calls.checkAccess).to.equal(1);
    });

    it("never authorizes when the chain answers 'allowed' after the 5 s verifying deadline", async function () {
      let release;
      const ctx = setupFakeChain(async (args) => {
        await new Promise((r) => (release = r));
        return validAccess(args);
      });
      const { requestId, body } = await signedRequest(ctx);
      const pending = ctx.service.submit(requestId, body);
      await sleep(10); // let submit reach the await
      ctx.t.advance(5_000);
      release();
      const result = await pending;
      // authorize() must refuse by itself, not leave it to consume().
      expect(result).to.include({ ok: false, code: "EXPIRED", step: "authorize" });
      expect(ctx.store.get(requestId).state).to.equal("EXPIRED");
    });

    it("moves to REJECTED when the chain call throws", async function () {
      const ctx = setupFakeChain(async () => {
        throw new Error("connection refused");
      });
      const { requestId, body } = await signedRequest(ctx);
      const result = await ctx.service.submit(requestId, body);
      expect(result).to.include({ ok: false, code: "RPC_ERROR" });
      expect(ctx.store.get(requestId).state).to.equal("REJECTED");
    });

    it("moves to REJECTED when the chain call times out", async function () {
      const ctx = setupFakeChain(async () => {
        throw new Error("hasAccess timed out after 5000 ms");
      });
      const { requestId, body } = await signedRequest(ctx);
      const result = await ctx.service.submit(requestId, body);
      expect(result).to.include({ ok: false, code: "RPC_ERROR" });
      expect(ctx.store.get(requestId).state).to.equal("REJECTED");
    });

    it("times out a chain call that never answers, and grants nothing", async function () {
      // Real chain module, real hasAccess timeout; the provider's eth_call hangs forever.
      await reset();
      const [, payer, renterSigner] = await ethers.getSigners();
      const booking = await ethers.deployContract("RentalBooking");
      await booking.setRoom(ROOM, PRICE, true);
      const day0 = (Math.floor((await time.latest()) / NIGHT) + 2) * NIGHT;
      await booking.connect(payer).book(ROOM, day0, day0 + NIGHT, renterSigner.address, { value: PRICE });

      let hang = false;
      const hangingProvider = new Proxy(ethers.provider, {
        get(target, prop) {
          if (prop === "call" && hang) return () => new Promise(() => {}); // never settles
          const value = Reflect.get(target, prop, target);
          return typeof value === "function" ? value.bind(target) : value;
        },
      });
      const t = fakeTime(day0 + 60);
      const chain = await connectChain({
        provider: hangingProvider,
        address: await booking.getAddress(),
        chainId: CHAIN_ID,
        projectRoot: PROJECT_ROOT,
        now: () => t.wall,
        rpcTimeoutMs: 300,
      });
      const store = createRequestStore({ monoNow: () => t.mono, wallNow: () => t.wall });
      const service = createUnlockService({ store, chain });
      const { requestId } = store.create({ roomId: ROOM, wallet: renterSigner.address, sessionId: SESSION });
      store.recordFob(requestId);
      const typed = service.challenge(requestId, SESSION);
      const signature = await renterSigner.signTypedData(typed.domain, UNLOCK_TYPES, typed.message);

      hang = true;
      const started = Date.now();
      const result = await service.submit(requestId, { sessionId: SESSION, nonce: typed.message.nonce, signature });
      const elapsed = Date.now() - started;
      expect(result).to.include({ ok: false, code: "RPC_ERROR", step: "chain" });
      expect(store.get(requestId).state).to.equal("REJECTED");
      expect(elapsed).to.be.within(250, 1500);
    });

    it("rejects when hasAccess says yes but no matching booking was found", async function () {
      const ctx = setupFakeChain(({ t }) => ({ allowed: true, checkedAt: Math.floor(t.wall / 1000), booking: null }));
      const { requestId, body } = await signedRequest(ctx);
      const result = await ctx.service.submit(requestId, body);
      expect(result).to.include({ ok: false, code: "INCONSISTENT_BOOKING" });
    });

    it("rejects a booking whose checkOut is already past (no zero-length or negative command)", async function () {
      const ctx = setupFakeChain(({ t }) => ({
        allowed: true,
        checkedAt: Math.floor(t.wall / 1000),
        booking: { bookingId: 7n, checkOut: Math.floor(t.wall / 1000) },
      }));
      const { requestId, body } = await signedRequest(ctx);
      const result = await ctx.service.submit(requestId, body);
      expect(result).to.include({ ok: false, code: "INCONSISTENT_BOOKING" });
    });

    it("does not call the chain at all for a bad signature", async function () {
      const ctx = setupFakeChain(validAccess);
      const { requestId, body } = await signedRequest(ctx);
      const other = ethers.Wallet.createRandom();
      const typed = ctx.service.challenge(requestId, SESSION);
      const badSig = await other.signTypedData(typed.domain, UNLOCK_TYPES, typed.message);
      const result = await ctx.service.submit(requestId, { ...body, nonce: typed.message.nonce, signature: badSig });
      expect(result).to.include({ ok: false, code: "BAD_SIGNATURE" });
      expect(ctx.calls.checkAccess).to.equal(0);
    });
  });
});
