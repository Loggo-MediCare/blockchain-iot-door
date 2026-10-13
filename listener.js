// Gateway between the blockchain and the ESP32-CAM (the book's Figure 22.12:
// the device keeps no ledger and relies on another node over RPC).
// Every command to the door is signed with HMAC-SHA256 and carries an
// ever-increasing nonce, so it cannot be forged or replayed.
// Usage: ESP32_IP=192.168.1.50 DOOR_SECRET=<hex> node listener.js
const crypto = require("crypto");
const { ethers } = require("ethers");
const { address } = require("./deployed.json");
const { abi } = require("./artifacts/contracts/SimpleIoT.sol/SimpleIoT.json");

const RPC_URL = process.env.RPC_URL ?? "http://127.0.0.1:8545";
const ESP32_IP = process.env.ESP32_IP;
const DOOR_SECRET = process.env.DOOR_SECRET;

let lastNonce = 0;

function signedUrl(action) {
  // Date.now() keeps nonces increasing across listener restarts.
  lastNonce = Math.max(Date.now(), lastNonce + 1);
  const sig = crypto.createHmac("sha256", DOOR_SECRET).update(`${action}|${lastNonce}`).digest("hex");
  return `http://${ESP32_IP}/${action}?nonce=${lastNonce}&sig=${sig}`;
}

async function sendCommand(action, attempts = 3) {
  for (let i = 1; i <= attempts; i++) {
    try {
      const res = await fetch(signedUrl(action), { signal: AbortSignal.timeout(3000) });
      const body = await res.text();
      if (res.status === 429 && i < attempts) {
        await new Promise((r) => setTimeout(r, 1100));
        continue;
      }
      return `${res.status}: ${body}`;
    } catch (err) {
      if (i === attempts) return `unreachable (${err.message})`;
    }
  }
}

async function unlockDoor() {
  if (!ESP32_IP) {
    console.log("LED On (no ESP32_IP set, simulated)");
    return;
  }
  console.log(`LED On -> ESP32 replied ${await sendCommand("on")}`);
}

async function main() {
  if (ESP32_IP && !DOOR_SECRET) {
    console.error("DOOR_SECRET is required when ESP32_IP is set");
    process.exit(1);
  }
  const provider = new ethers.JsonRpcProvider(RPC_URL);
  const contract = new ethers.Contract(address, abi, provider);

  console.log(`Listening for RoomRented on ${address} via ${RPC_URL}`);
  contract.on("RoomRented", (renter, amount, event) => {
    console.log(`RoomRented by ${renter}, paid ${ethers.formatEther(amount)} ETH (block ${event.log.blockNumber})`);
    unlockDoor();
  });
}

main();
