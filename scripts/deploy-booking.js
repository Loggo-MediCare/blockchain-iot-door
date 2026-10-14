// Deploy RentalBooking to the local chain, create demo room 101 and save the
// address for the gateway. Usage: npx hardhat run scripts/deploy-booking.js --network localhost
const fs = require("fs");
const path = require("path");
const hre = require("hardhat");

const ROOM_ID = 101;
const PRICE_PER_NIGHT = hre.ethers.parseEther("0.01");

async function main() {
  const booking = await hre.ethers.deployContract("RentalBooking");
  await booking.waitForDeployment();
  const address = await booking.getAddress();
  await (await booking.setRoom(ROOM_ID, PRICE_PER_NIGHT, true)).wait();

  const { chainId } = await hre.ethers.provider.getNetwork();
  const out = { address, chainId: Number(chainId), roomId: ROOM_ID };
  fs.writeFileSync(path.join(__dirname, "..", "deployed-booking.json"), JSON.stringify(out, null, 2));
  console.log(`RentalBooking deployed to ${address} (chainId ${out.chainId}); room ${ROOM_ID} at 0.01 ETH/night`);
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
