const express = require("express");
const path = require("path");

const app = express();
const PORT = process.env.PORT || 3000;
const chatClients = new Set();

app.disable("x-powered-by");
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
    kick: "pending_official_webhook"
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
