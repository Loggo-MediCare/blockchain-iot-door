// Stage B1: the gateway's connection to the booking contract (SPEC.md section 5, step 5).
// Written before gateway/chain.js, test-first.
const { expect } = require("chai");
const path = require("path");
const { ethers } = require("hardhat");
const { time, reset } = require("@nomicfoundation/hardhat-network-helpers");
const { connectChain, GatewayStartupError } = require("../../gateway/chain");

const ROOM = 101;
const PRICE = ethers.parseEther("0.01");
const NIGHT = 24 * 60 * 60;
const PROJECT_ROOT = path.join(__dirname, "..", "..");
const CHAIN_ID = 31337;

// A controllable gateway clock, in milliseconds like Date.now().
function fakeClock(ms) {
  const clock = { ms, now: () => clock.ms, setSeconds: (s) => (clock.ms = s * 1000) };
  return clock;
}

async function deployWithStay() {
  const [, payer, renter, other] = await ethers.getSigners();
  const booking = await ethers.deployContract("RentalBooking");
  await booking.setRoom(ROOM, PRICE, true);
  const day0 = (Math.floor((await time.latest()) / NIGHT) + 2) * NIGHT;
  const checkIn = day0;
  const checkOut = day0 + 2 * NIGHT;
  await booking.connect(payer).book(ROOM, checkIn, checkOut, renter.address, { value: PRICE * 2n });
  return { booking, address: await booking.getAddress(), payer, renter, other, checkIn, checkOut };
}

function connect(address, clock, overrides = {}) {
  return connectChain({
    provider: ethers.provider,
    address,
    chainId: CHAIN_ID,
    projectRoot: PROJECT_ROOT,
    now: clock.now,
    ...overrides,
  });
}

describe("Gateway B1: chain connection", function () {
  beforeEach(async function () {
    await reset();
  });

  describe("startup checks", function () {
    it("connects when the address holds the deployed RentalBooking", async function () {
      const { address } = await deployWithStay();
      const chain = await connect(address, fakeClock(Date.now()));
      expect(chain.address).to.equal(address);
      expect(chain.chainId).to.equal(CHAIN_ID);
    });

    it("refuses to start when the address has no code (chain restarted)", async function () {
      const { address } = await deployWithStay();
      await reset(); // same RPC, empty chain
      await expect(connect(address, fakeClock(Date.now()))).to.be.rejectedWith(GatewayStartupError, /no contract code/);
    });

    it("refuses to start when a different contract sits at the same address", async function () {
      const { address } = await deployWithStay();
      await reset();
      // Same deployer, same nonce: the old demo contract lands at the same address.
      const impostor = await ethers.deployContract("SimpleIoT");
      expect(await impostor.getAddress()).to.equal(address);
      await expect(connect(address, fakeClock(Date.now()))).to.be.rejectedWith(GatewayStartupError, /not RentalBooking/);
    });

    it("refuses to start on the wrong chain id", async function () {
      const { address } = await deployWithStay();
      await expect(connect(address, fakeClock(Date.now()), { chainId: 1 })).to.be.rejectedWith(
        GatewayStartupError,
        /chain id/
      );
    });

    it("refuses to start when the RPC is unreachable", async function () {
      const dead = new ethers.JsonRpcProvider("http://127.0.0.1:9", CHAIN_ID, {
        staticNetwork: ethers.Network.from(CHAIN_ID),
      });
      await expect(
        connect(ethers.ZeroAddress.replace(/0$/, "1"), fakeClock(Date.now()), { provider: dead, rpcTimeoutMs: 2000 })
      ).to.be.rejectedWith(GatewayStartupError, /RPC/);
      dead.destroy();
    });

    it("rejects a malformed contract address", async function () {
      await expect(connect("0x1234", fakeClock(Date.now()))).to.be.rejectedWith(GatewayStartupError, /address/);
    });
  });

  describe("checkAccess uses on-chain data and the gateway clock only", function () {
    it("allows the renter during the stay and denies outside it", async function () {
      const { address, renter, checkIn, checkOut } = await deployWithStay();
      const clock = fakeClock(0);
      const chain = await connect(address, clock);

      clock.setSeconds(checkIn - 1);
      expect((await chain.checkAccess(ROOM, renter.address)).allowed).to.equal(false);
      clock.setSeconds(checkIn);
      expect((await chain.checkAccess(ROOM, renter.address)).allowed).to.equal(true);
      clock.setSeconds(checkOut - 1);
      expect((await chain.checkAccess(ROOM, renter.address)).allowed).to.equal(true);
      clock.setSeconds(checkOut);
      expect((await chain.checkAccess(ROOM, renter.address)).allowed).to.equal(false);
    });

    it("denies the payer and other wallets", async function () {
      const { address, payer, other, checkIn } = await deployWithStay();
      const clock = fakeClock(0);
      clock.setSeconds(checkIn + 60);
      const chain = await connect(address, clock);
      expect((await chain.checkAccess(ROOM, payer.address)).allowed).to.equal(false);
      expect((await chain.checkAccess(ROOM, other.address)).allowed).to.equal(false);
    });

    it("reflects a cancellation immediately (no caching)", async function () {
      const { booking, address, payer, renter, checkIn } = await deployWithStay();
      const clock = fakeClock(0);
      clock.setSeconds(checkIn + 60);
      const chain = await connect(address, clock);
      expect((await chain.checkAccess(ROOM, renter.address)).allowed).to.equal(true);
      await booking.connect(payer).cancel(1);
      expect((await chain.checkAccess(ROOM, renter.address)).allowed).to.equal(false);
    });

    it("ignores any time the caller tries to pass in (time injection)", async function () {
      const { address, renter, checkIn, checkOut } = await deployWithStay();
      const clock = fakeClock(0);
      const chain = await connect(address, clock);

      // Gateway clock outside the stay; attacker-supplied times inside it.
      clock.setSeconds(checkOut + 3600);
      for (const injected of [checkIn + 60, { time: checkIn + 60 }, { timestamp: checkIn + 60, now: checkIn + 60 }]) {
        expect((await chain.checkAccess(ROOM, renter.address, injected)).allowed).to.equal(false);
      }
      // And the reverse: gateway clock inside, injected time outside.
      clock.setSeconds(checkIn + 60);
      expect((await chain.checkAccess(ROOM, renter.address, { time: checkOut + 3600 })).allowed).to.equal(true);
    });

    it("reports which gateway time it used, for the audit log", async function () {
      const { address, renter, checkIn } = await deployWithStay();
      const clock = fakeClock(0);
      clock.setSeconds(checkIn + 123);
      const chain = await connect(address, clock);
      expect((await chain.checkAccess(ROOM, renter.address)).checkedAt).to.equal(checkIn + 123);
    });

    it("rejects malformed wallets and room ids before calling the contract", async function () {
      const { address } = await deployWithStay();
      const chain = await connect(address, fakeClock(Date.now()));
      for (const wallet of ["", "0x123", "not-an-address", null]) {
        await expect(chain.checkAccess(ROOM, wallet)).to.be.rejectedWith(/wallet/);
      }
      for (const room of [-1, 1.5, "101; drop", NaN, null]) {
        await expect(chain.checkAccess(room, ethers.Wallet.createRandom().address)).to.be.rejectedWith(/room/);
      }
    });
  });
});
