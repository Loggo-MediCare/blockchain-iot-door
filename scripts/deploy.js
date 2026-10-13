// Deploy SimpleIoT to the local chain and save its address for the other scripts.
const fs = require("fs");
const path = require("path");
const hre = require("hardhat");

async function main() {
  const contract = await hre.ethers.deployContract("SimpleIoT");
  await contract.waitForDeployment();
  const address = await contract.getAddress();

  fs.writeFileSync(path.join(__dirname, "..", "deployed.json"), JSON.stringify({ address }, null, 2));
  console.log(`SimpleIoT deployed to ${address}`);
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
