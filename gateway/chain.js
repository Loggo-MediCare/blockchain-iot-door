// Gateway connection to the RentalBooking contract (SPEC.md section 5, step 5).
//
// Startup refuses to authorize anything unless the RPC answers on the expected
// chain id AND the code at the configured address is RentalBooking. A local
// Hardhat chain that was restarted either has no code there, or, because
// addresses are derived from deployer + nonce, a different contract at the very
// same address.
//
// checkAccess() always asks hasAccess() with the gateway's own clock. It takes
// no time argument; anything extra a caller passes is ignored.
const fs = require("fs");
const path = require("path");
const { ethers } = require("ethers");

class GatewayStartupError extends Error {
  constructor(message) {
    super(message);
    this.name = "GatewayStartupError";
  }
}

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

function parseRoomId(roomId) {
  if (typeof roomId === "number" && Number.isSafeInteger(roomId) && roomId >= 0) return BigInt(roomId);
  if (typeof roomId === "bigint" && roomId >= 0n) return roomId;
  if (typeof roomId === "string" && /^[0-9]{1,18}$/.test(roomId)) return BigInt(roomId);
  throw new TypeError(`invalid room id: ${String(roomId)}`);
}

function parseWallet(wallet) {
  if (typeof wallet !== "string" || !ethers.isAddress(wallet)) {
    throw new TypeError(`invalid wallet address: ${String(wallet)}`);
  }
  return ethers.getAddress(wallet);
}

async function connectChain({ provider, address, chainId, projectRoot, now = Date.now, rpcTimeoutMs = 5000 }) {
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

  return {
    address: ethers.getAddress(address),
    chainId,
    gatewaySeconds,
    // Extra arguments (e.g. a client-supplied time) are deliberately ignored.
    async checkAccess(roomId, wallet) {
      const room = parseRoomId(roomId);
      const renter = parseWallet(wallet);
      const checkedAt = gatewaySeconds();
      const allowed = await withTimeout(contract.hasAccess(room, renter, checkedAt), rpcTimeoutMs, "hasAccess");
      return { allowed, checkedAt };
    },
  };
}

module.exports = { connectChain, GatewayStartupError };
