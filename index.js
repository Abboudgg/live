const express = require("express");
const path = require("path");
const crypto = require("crypto");

const app = express();
const PORT = process.env.PORT || 3000;
const chatClients = new Set();
let kickStatus = "pending_setup";
let kickPublicKeyPromise = null;
const seenKickEvents = new Map();

app.disable("x-powered-by");

async function getKickPublicKey() {
  if (!kickPublicKeyPromise) {
    kickPublicKeyPromise = fetch("https://api.kick.com/public/v1/public-key")
      .then(async response => {
        if (!response.ok) throw new Error("Kick public key request failed: " + response.status);
        const data = await response.json();
        const key = data.public_key || data.data?.public_key || data.key || data.data?.key;
        if (!key || typeof key !== "string") throw new Error("Unexpected Kick public key response");
        return key;
      })
      .catch(error => {
        kickPublicKeyPromise = null;
        throw error;
      });
  }
  return kickPublicKeyPromise;
}

async function verifyKickWebhook(req, rawBody) {
  const messageId = req.get("Kick-Event-Message-Id");
  const timestamp = req.get("Kick-Event-Message-Timestamp");
  const signature = req.get("Kick-Event-Signature");
  if (!messageId || !timestamp || !signature) return false;

  const eventTime = Date.parse(timestamp);
  if (!Number.isFinite(eventTime) || Math.abs(Date.now() - eventTime) > 5 * 60 * 1000) return false;

  const publicKey = await getKickPublicKey();
  const signedPayload = Buffer.from(messageId + "." + timestamp + "." + rawBody.toString("utf8"));
  return crypto.verify(
    "RSA-SHA256",
    signedPayload,
    publicKey,
    Buffer.from(signature, "base64")
  );
}

app.post("/kick/webhook", express.raw({ type: "application/json", limit: "1mb" }), async (req, res) => {
  try {
    if (!Buffer.isBuffer(req.body)) return res.status(400).send("Expected JSON body");
    const valid = await verifyKickWebhook(req, req.body);
    if (!valid) return res.status(401).send("Invalid Kick webhook signature");

    const messageId = req.get("Kick-Event-Message-Id");
    if (seenKickEvents.has(messageId)) return res.status(200).send("Duplicate");
    seenKickEvents.set(messageId, Date.now());
    for (const [id, time] of seenKickEvents) {
      if (Date.now() - time > 10 * 60 * 1000) seenKickEvents.delete(id);
    }

    const eventType = req.get("Kick-Event-Type");
    const payload = JSON.parse(req.body.toString("utf8"));

    if (eventType === "webhook_callback_verification") {
      return res.status(200).type("text/plain").send(String(payload.challenge || ""));
    }

    if (eventType === "chat.message.sent") {
      const sender = payload.sender || {};
      publishChat({
        platform: "kick",
        username: sender.username || sender.slug || "Kick",
        message: payload.content || "",
        timestamp: Date.now()
      });
      kickStatus = "connected";
    }

    return res.status(200).send("OK");
  } catch (error) {
    console.error("Kick webhook error:", error?.message || error);
    return res.status(500).send("Webhook processing failed");
  }
});

app.use(express.static(path.join(__dirname, "public")));

function publishChat(message) {
  const payload = `event: chat\ndata: ${JSON.stringify(message)}\n\n`;
  for (const client of chatClients) {
    try { client.write(payload); } catch { chatClients.delete(client); }
  }
}

app.get("/health", (_req, res) => {
  res.json({ ok: true, service: "live-multi-chat" });
});

app.get("/config", (_req, res) => {
  res.json({
    twitchChannel: process.env.TWITCH_CHANNEL || "r119_abdlull",
    kickUsername: process.env.KICK_USERNAME || "cass-sa",
    tiktokUsername: process.env.TIKTOK_USERNAME || "cass_ksa_"
  });
});

app.get("/chat-status", (_req, res) => {
  res.json({
    tiktok: tiktokStatus,
    kick: kickStatus
  });
});

app.get("/events", (req, res) => {
  res.set({
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache, no-transform",
    "Connection": "keep-alive",
    "X-Accel-Buffering": "no"
  });
  res.flushHeaders?.();
  res.write("event: ready\ndata: {}\n\n");
  chatClients.add(res);
  req.on("close", () => chatClients.delete(res));
});

let tiktokStatus = "starting";
let tiktokStarted = false;

async function startTikTokChat() {
  if (tiktokStarted) return;
  tiktokStarted = true;
  const username = (process.env.TIKTOK_USERNAME || "cass_ksa_").replace(/^@/, "");

  while (true) {
    let connection;
    try {
      tiktokStatus = "connecting";
      const { TikTokLiveConnection, WebcastEvent } = await import("tiktok-live-connector");
      connection = new TikTokLiveConnection(username, {});

      connection.on(WebcastEvent.CHAT, data => {
        publishChat({
          platform: "tiktok",
          username: data.user?.uniqueId || data.user?.nickname || "TikTok",
          message: data.comment || "",
          timestamp: Date.now()
        });
      });

      connection.on("disconnected", () => {
        tiktokStatus = "disconnected";
      });

      await connection.connect();
      tiktokStatus = "connected";
      console.log(`TikTok chat connected for @${username}`);

      await new Promise(resolve => {
        connection.on("disconnected", resolve);
        connection.on("error", resolve);
      });
    } catch (error) {
      tiktokStatus = "offline_or_unavailable";
      console.warn("TikTok chat connection unavailable:", error?.message || error);
    }

    try { await connection?.disconnect(); } catch {}
    await new Promise(resolve => setTimeout(resolve, 30000));
  }
}

app.listen(PORT, "0.0.0.0", () => {
  console.log(`Web dashboard listening on port ${PORT}`);
  startTikTokChat().catch(error => console.error("TikTok chat startup error:", error));
});
