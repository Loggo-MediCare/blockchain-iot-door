// B1 smoke check: connect the gateway to the running node the same way the
// real gateway will, then ask hasAccess() for one or more wallets.
// Usage: node scripts/gateway-check.js <roomId> <wallet> [wallet...]
const path = require("path");
const { ethers } = require("ethers");
const { connectChain } = require("../gateway/chain");

const RPC_URL = process.env.RPC_URL ?? "http://127.0.0.1:8545";

async function main() {
  const [roomId, ...wallets] = process.argv.slice(2);
  const { address, chainId } = require("../deployed-booking.json");
  const provider = new ethers.JsonRpcProvider(RPC_URL, chainId, { staticNetwork: ethers.Network.from(chainId) });
  try {
    const chain = await connectChain({ provider, address, chainId, projectRoot: path.join(__dirname, "..") });
    console.log(`gateway connected: RentalBooking at ${chain.address}, chain ${chain.chainId}`);
    for (const wallet of wallets) {
      const { allowed, checkedAt } = await chain.checkAccess(roomId, wallet);
      console.log(`room ${roomId} ${wallet}: ${allowed ? "ALLOW" : "DENY"} (gateway time ${new Date(checkedAt * 1000).toISOString()})`);
    }
  } catch (err) {
    console.log(`gateway refused: ${err.message}`);
    process.exitCode = 1;
  } finally {
    provider.destroy();
  }
}

main();
