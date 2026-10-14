// Input validation shared by the gateway modules. Everything that reaches the
// contract or the request store goes through these first.
const { ethers } = require("ethers");

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

module.exports = { parseRoomId, parseWallet };
