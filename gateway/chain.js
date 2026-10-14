// Gateway connection to the RentalBooking contract (SPEC.md section 5, step 5).
//
// Startup refuses to authorize anything unless the RPC answers on the expected
// chain id AND the code at the configured address is RentalBooking. A local
// Hardhat chain that was restarted either has no code there, or, because
// addresses are derived from deployer + nonce, a different contract at the very
// same address.
//
// checkAccess() always asks hasAccess() with the gateway's own clock. It takes
// no time argument; anything extra a caller passes is ignored. Each call is one
// consistent read pinned to a single block: the contract identity is checked
// again (a local chain can be reset at any time), and the booking that grants
// access is returned so the caller gets a trusted checkOut.
const fs = require("fs");
const path = require("path");
const { ethers } = require("ethers");
const { parseRoomId, parseWallet } = require("./validate");

class GatewayStartupError extends Error {
  constructor(message) {
    super(message);
    this.name = "GatewayStartupError";
  }
}

class ChainIdentityError extends Error {
  constructor(message) {
    super(message);
    this.name = "ChainIdentityError";
    this.code = "CHAIN_IDENTITY";
  }
}

const BOOKED = 0n;

function withTimeout(promise, ms, what) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${what} timed out after ${ms} ms`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

// ABI, deployed bytecode and the byte ranges of immutables (e.g. `owner`),
// which differ per deployment and are masked before comparing code.
function loadRentalBookingArtifact(projectRoot) {
  const dir = path.join(projectRoot, "artifacts", "contracts", "RentalBooking.sol");
  const artifact = JSON.parse(fs.readFileSync(path.join(dir, "RentalBooking.json"), "utf8"));
  const dbg = JSON.parse(fs.readFileSync(path.join(dir, "RentalBooking.dbg.json"), "utf8"));
  const buildInfo = JSON.parse(fs.readFileSync(path.resolve(dir, dbg.buildInfo), "utf8"));
  const compiled = buildInfo.output.contracts["contracts/RentalBooking.sol"].RentalBooking;
  const immutableRanges = Object.values(compiled.evm.deployedBytecode.immutableReferences ?? {}).flat();
  return { abi: artifact.abi, deployedBytecode: artifact.deployedBytecode, immutableRanges };
}

function maskImmutables(code, ranges) {
  let hex = code.toLowerCase().replace(/^0x/, "");
  for (const { start, length } of ranges) {
    hex = hex.slice(0, start * 2) + "0".repeat(length * 2) + hex.slice((start + length) * 2);
  }
  return hex;
}

// 4 s leaves room inside the 5 s VERIFYING window for authorize() and consume().
async function connectChain({ provider, address, chainId, projectRoot, now = Date.now, rpcTimeoutMs = 4000 }) {
  if (typeof address !== "string" || !ethers.isAddress(address)) {
    throw new GatewayStartupError(`invalid contract address: ${String(address)}`);
  }

  let actualChainId;
  let code;
  try {
    actualChainId = Number(await withTimeout(provider.send("eth_chainId", []), rpcTimeoutMs, "eth_chainId"));
    code = await withTimeout(provider.getCode(address), rpcTimeoutMs, "eth_getCode");
  } catch (err) {
    throw new GatewayStartupError(`RPC unreachable or failing: ${err.shortMessage ?? err.message}`);
  }
  if (actualChainId !== chainId) {
    throw new GatewayStartupError(`wrong chain id: expected ${chainId}, RPC reports ${actualChainId}`);
  }
  if (code === "0x") {
    throw new GatewayStartupError(`no contract code at ${address}; was the chain restarted? Redeploy RentalBooking.`);
  }
  const artifact = loadRentalBookingArtifact(projectRoot);
  if (maskImmutables(code, artifact.immutableRanges) !== maskImmutables(artifact.deployedBytecode, artifact.immutableRanges)) {
    throw new GatewayStartupError(`code at ${address} is not RentalBooking (or was compiled from different source)`);
  }

  const contract = new ethers.Contract(address, artifact.abi, provider);
  const gatewaySeconds = () => Math.floor(now() / 1000);
  const verifiedCode = maskImmutables(code, artifact.immutableRanges);

  async function pinnedRead(room, renter, checkedAt) {
    const blockTag = await provider.getBlockNumber();
    // Identity first, at the pinned block; only then ask the contract.
    const currentCode = await provider.getCode(address, blockTag);
    if (currentCode === "0x") throw new ChainIdentityError(`no contract code at ${address} any more; chain reset?`);
    if (maskImmutables(currentCode, artifact.immutableRanges) !== verifiedCode) {
      throw new ChainIdentityError(`contract at ${address} is no longer RentalBooking`);
    }
    const allowed = await contract.hasAccess(room, renter, checkedAt, { blockTag });
    if (!allowed) return { allowed: false, checkedAt, booking: null };

    // Same block: find the booking that grants access, for its checkOut.
    const ids = await contract.getActiveBookingIds(room, { blockTag });
    const bookings = await Promise.all(ids.map((id) => contract.getBooking(id, { blockTag })));
    const match = bookings.findIndex(
      (b) => b.status === BOOKED && b.renter === renter && b.checkIn <= BigInt(checkedAt) && BigInt(checkedAt) < b.checkOut
    );
    const booking = match === -1 ? null : { bookingId: ids[match], checkOut: Number(bookings[match].checkOut) };
    return { allowed: true, checkedAt, booking };
  }

  return {
    address: ethers.getAddress(address),
    chainId,
    gatewaySeconds,
    // Extra arguments (e.g. a client-supplied time) are deliberately ignored.
    async checkAccess(roomId, wallet) {
      const room = parseRoomId(roomId);
      const renter = parseWallet(wallet);
      const checkedAt = gatewaySeconds();
      return withTimeout(pinnedRead(room, renter, checkedAt), rpcTimeoutMs, "checkAccess");
    },
  };
}

module.exports = { connectChain, GatewayStartupError, ChainIdentityError };
