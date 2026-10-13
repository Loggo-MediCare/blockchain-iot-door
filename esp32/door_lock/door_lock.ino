// ESP32-CAM "door lock": the red LED on GPIO 33 stands in for the lock.
// Board: AI Thinker ESP32-CAM. The listener on the Mac calls /on when the
// smart contract emits RoomRented.
//
// Every command must be signed, so nobody on the WiFi can open the door
// without going through the blockchain:
//   GET /on?nonce=<n>&sig=<hex HMAC-SHA256(DOOR_SECRET, "on|<n>")>
// - Wrong or missing signature      -> 401 (unauthorized access)
// - nonce not larger than the last  -> 409 (replay attack)
// - more than one command per second -> 429 (flooding)
// The last accepted nonce is kept in flash, so old commands stay invalid
// after a reboot.
#include <WiFi.h>
#include <WebServer.h>
#include <Preferences.h>
#include "mbedtls/md.h"
#include "secrets.h"  // WIFI_SSID, WIFI_PASSWORD, DOOR_SECRET (see secrets.h.example)

const int LED_PIN = 33;         // active LOW: LOW = on, HIGH = off
const unsigned long UNLOCK_MS = 5000;
const unsigned long MIN_INTERVAL_MS = 1000;

WebServer server(80);
Preferences prefs;
unsigned long unlockedAt = 0;
bool unlocked = false;
unsigned long lastRequestAt = 0;
bool anyRequestYet = false;
uint64_t lastNonce = 0;

void setLed(bool on) {
  digitalWrite(LED_PIN, on ? LOW : HIGH);
}

String hmacHex(const String& message) {
  uint8_t mac[32];
  const mbedtls_md_info_t* info = mbedtls_md_info_from_type(MBEDTLS_MD_SHA256);
  mbedtls_md_hmac(info, (const uint8_t*)DOOR_SECRET, strlen(DOOR_SECRET),
                  (const uint8_t*)message.c_str(), message.length(), mac);
  char hex[65];
  for (int i = 0; i < 32; i++) sprintf(hex + i * 2, "%02x", mac[i]);
  return String(hex);
}

// Compares every character so the time taken does not leak where they differ.
bool constantTimeEquals(const String& a, const String& b) {
  if (a.length() != b.length()) return false;
  uint8_t diff = 0;
  for (size_t i = 0; i < a.length(); i++) diff |= a[i] ^ b[i];
  return diff == 0;
}

// Returns true if the request is allowed; otherwise sends the error reply.
bool authorize(const char* action) {
  unsigned long now = millis();
  if (anyRequestYet && now - lastRequestAt < MIN_INTERVAL_MS) {
    server.send(429, "text/plain", "too many requests");
    return false;
  }
  anyRequestYet = true;
  lastRequestAt = now;

  if (!server.hasArg("nonce") || !server.hasArg("sig")) {
    server.send(401, "text/plain", "missing signature");
    return false;
  }
  String nonceText = server.arg("nonce");
  String expected = hmacHex(String(action) + "|" + nonceText);
  String sig = server.arg("sig");
  sig.toLowerCase();
  if (!constantTimeEquals(expected, sig)) {
    server.send(401, "text/plain", "bad signature");
    Serial.println("Rejected: bad signature");
    return false;
  }

  uint64_t nonce = strtoull(nonceText.c_str(), nullptr, 10);
  if (nonce <= lastNonce) {
    server.send(409, "text/plain", "replayed command");
    Serial.println("Rejected: replayed nonce");
    return false;
  }
  lastNonce = nonce;
  prefs.putULong64("lastNonce", lastNonce);
  return true;
}

void handleOn() {
  if (!authorize("on")) return;
  setLed(true);
  unlocked = true;
  unlockedAt = millis();
  server.send(200, "text/plain", "door unlocked");
  Serial.println("Door unlocked");
}

void handleOff() {
  if (!authorize("off")) return;
  setLed(false);
  unlocked = false;
  server.send(200, "text/plain", "door locked");
  Serial.println("Door locked");
}

void setup() {
  Serial.begin(115200);
  pinMode(LED_PIN, OUTPUT);
  setLed(false);

  prefs.begin("door", false);
  lastNonce = prefs.getULong64("lastNonce", 0);

  WiFi.begin(WIFI_SSID, WIFI_PASSWORD);
  Serial.print("Connecting to WiFi");
  while (WiFi.status() != WL_CONNECTED) {
    delay(500);
    Serial.print(".");
  }
  Serial.print("\nESP32 IP: ");
  Serial.println(WiFi.localIP());

  server.on("/on", handleOn);
  server.on("/off", handleOff);
  server.begin();
}

void loop() {
  server.handleClient();
  // Lock again automatically, like a real door.
  if (unlocked && millis() - unlockedAt > UNLOCK_MS) {
    setLed(false);
    unlocked = false;
    Serial.println("Door auto-locked");
  }
}
