// Pay rent to open the door. Uses the second test account as the renter
// (the first one deployed the contract and is the owner).
// Usage: AMOUNT=0.01 npx hardhat run scripts/rent.js --network localhost
const hre = require("hardhat");
const { address } = require("../deployed.json");

async function main() {
  const amount = process.env.AMOUNT ?? "0.01";
  const [, renter] = await hre.ethers.getSigners();
  const contract = await hre.ethers.getContractAt("SimpleIoT", address, renter);

  try {
    const tx = await contract.rent({ value: hre.ethers.parseEther(amount) });
    await tx.wait();
    console.log(`Paid ${amount} ETH, tx ${tx.hash}`);
  } catch (err) {
    console.log(`Payment of ${amount} ETH rejected: ${err.shortMessage ?? err.message}`);
  }

  const balance = await hre.ethers.provider.getBalance(address);
  console.log(`Contract balance: ${hre.ethers.formatEther(balance)} ETH`);
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
