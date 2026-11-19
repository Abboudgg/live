const express = require("express");
const path = require("path");
const { spawn } = require("child_process");
const crypto = require("crypto");
const fs = require("fs");
const os = require("os");

const app = express();
const PORT = process.env.PORT || 3000;
const chatClients = new Set();
let kickStatus = "pending_setup";
let kickBroadcasterUserId = null;
const kickStats = { isLive: null, viewers: null, followers: null, updatedAt: null };
const tiktokStats = { isLive: null, viewers: null, followers: null, updatedAt: null };
let kickStatsTimer = null;
let kickPublicKeyPromise = null;
const seenKickEvents = new Map();

app.disable("x-powered-by");
app.use(express.json({ limit: "1mb" }));

const mediaDirectory = path.join(os.tmpdir(), "live-control-media");
fs.mkdirSync(mediaDirectory, { recursive: true });
const allowedVideoExtensions = new Set([".mp4", ".mov", ".m4v", ".webm", ".mkv"]);
const MAX_MEDIA_BYTES = 200 * 1024 * 1024;

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


// Kick OAuth 2.1 + PKCE. Credentials are supplied only through Render environment variables.
const kickOAuthStates = new Map();
let kickUserAccessToken = null;

app.get("/kick/connect", (req, res) => {
  const clientId = process.env.KICK_CLIENT_ID;
  if (!clientId) return res.status(503).send("Kick Client ID is not configured.");
  const state = crypto.randomBytes(32).toString("hex");
  const verifier = crypto.randomBytes(32).toString("base64url");
  const challenge = crypto.createHash("sha256").update(verifier).digest("base64url");
  kickOAuthStates.set(state, { verifier, createdAt: Date.now() });
  for (const [key, value] of kickOAuthStates) {
    if (Date.now() - value.createdAt > 10 * 60 * 1000) kickOAuthStates.delete(key);
  }
  const redirectUri = "https://live-jzc6.onrender.com/kick/callback";
  const params = new URLSearchParams({
    response_type: "code",
    client_id: clientId,
    redirect_uri: redirectUri,
    scope: "user:read channel:read events:subscribe",
    code_challenge: challenge,
    code_challenge_method: "S256",
    state
  });
  res.redirect("https://id.kick.com/oauth/authorize?" + params.toString());
});

app.get("/kick/callback", async (req, res) => {
  try {
    if (req.query.error) return res.status(400).send("Kick authorization was not approved. You can close this page.");
    const { code, state } = req.query;
    const saved = kickOAuthStates.get(String(state || ""));
    if (!code || !saved || Date.now() - saved.createdAt > 10 * 60 * 1000) {
      return res.status(400).send("Invalid or expired Kick authorization state. Please try again.");
    }
    kickOAuthStates.delete(String(state));
    const clientId = process.env.KICK_CLIENT_ID;
    const clientSecret = process.env.KICK_CLIENT_SECRET;
    if (!clientId || !clientSecret) return res.status(503).send("Kick credentials are not configured on the server.");
    const redirectUri = "https://live-jzc6.onrender.com/kick/callback";
    const tokenResponse = await fetch("https://id.kick.com/oauth/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        client_id: clientId,
        client_secret: clientSecret,
        redirect_uri: redirectUri,
        code: String(code),
        code_verifier: saved.verifier
      })
    });
    const tokenData = await tokenResponse.json();
    if (!tokenResponse.ok || !tokenData.access_token) {
      console.error("Kick token exchange failed:", tokenData.error || tokenResponse.status);
      return res.status(502).send("Kick token exchange failed. Check server configuration and try again.");
    }
    kickUserAccessToken = tokenData.access_token;

    const userResponse = await fetch("https://api.kick.com/public/v1/users", {
      headers: { Authorization: "Bearer " + kickUserAccessToken }
    });
    const userData = await userResponse.json();
    const currentUser = userData.data?.[0] || userData.data || {};
    const broadcasterUserId = Number(currentUser.user_id || currentUser.id);
    if (!userResponse.ok || !Number.isFinite(broadcasterUserId) || broadcasterUserId <= 0) {
      kickStatus = "authorized_subscription_pending";
      return res.status(200).send("Kick authorization succeeded, but the channel ID could not be read. Check server logs.");
    }

    kickBroadcasterUserId = broadcasterUserId;
    refreshKickStats().catch(() => {});
    if (!kickStatsTimer) kickStatsTimer = setInterval(() => refreshKickStats().catch(() => {}), 60000);

    const subscriptionResponse = await fetch("https://api.kick.com/public/v1/events/subscriptions", {
      method: "POST",
      headers: {
        Authorization: "Bearer " + kickUserAccessToken,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        broadcaster_user_id: broadcasterUserId,
        method: "webhook",
        events: [{ name: "chat.message.sent", version: 1 }]
      })
    });
    const subscriptionData = await subscriptionResponse.json().catch(() => ({}));
    if (!subscriptionResponse.ok) {
      const kickErrorDetails = subscriptionData.message || subscriptionData.error || JSON.stringify(subscriptionData).slice(0, 1000) || "No response details";
      console.error("Kick event subscription failed:", JSON.stringify({ status: subscriptionResponse.status, statusText: subscriptionResponse.statusText, details: kickErrorDetails }));
      kickStatus = "authorized_subscription_pending";
      return res.status(200).send("Kick connected, but chat event subscription failed. Check webhook settings and server logs.");
    }
    kickStatus = "subscription_created_waiting_for_message";
    return res.status(200).send("Kick authorization complete. Chat webhook subscription request sent. You can close this page.");
  } catch (error) {
    console.error("Kick OAuth callback error:", error?.message || error);
    return res.status(500).send("Kick connection failed. Please try again.");
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
  res.json({ tiktok: tiktokStatus, kick: kickStatus });
});

app.get("/platform-stats", (_req, res) => {
  res.json({
    kick: { ...kickStats, status: kickStatus, followersAvailable: false },
    tiktok: { ...tiktokStats, status: tiktokStatus, followersAvailable: Number.isFinite(tiktokStats.followers) }
  });
});

async function refreshKickStats() {
  if (!kickUserAccessToken || !kickBroadcasterUserId) return;
  const url = "https://api.kick.com/public/v1/users/livestreams?user_id=" + encodeURIComponent(kickBroadcasterUserId);
  const response = await fetch(url, { headers: { Authorization: "Bearer " + kickUserAccessToken } });
  if (!response.ok) throw new Error("Kick livestream stats request failed: " + response.status);
  const payload = await response.json();
  const streams = Array.isArray(payload) ? payload : Array.isArray(payload.data) ? payload.data : [];
  const stream = streams[0] || null;
  kickStats.isLive = Boolean(stream);
  kickStats.viewers = stream && Number.isFinite(Number(stream.viewer_count)) ? Number(stream.viewer_count) : 0;
  kickStats.updatedAt = Date.now();
}

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

      connection.on(WebcastEvent.ROOM_USER, data => {
        const count = data.total ?? data.viewerCount ?? data.totalUser;
        if (count !== undefined && Number.isFinite(Number(count))) tiktokStats.viewers = Number(count);
        tiktokStats.isLive = true;
        tiktokStats.updatedAt = Date.now();
      });

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
        tiktokStats.isLive = false;
        tiktokStats.viewers = null;
        tiktokStats.updatedAt = Date.now();
      });

      await connection.connect();
      tiktokStatus = "connected";
      tiktokStats.isLive = true;
      try {
        const roomInfo = await connection.fetchRoomInfo();
        const owner = roomInfo?.owner || roomInfo?.data?.owner;
        const followers = owner?.followInfo?.followerCount ?? owner?.follow_info?.follower_count;
        if (followers !== undefined && Number.isFinite(Number(followers))) tiktokStats.followers = Number(followers);
      } catch {}
      tiktokStats.updatedAt = Date.now();
      console.log(`TikTok chat connected for @${username}`);

      await new Promise(resolve => {
        connection.on("disconnected", resolve);
        connection.on("error", resolve);
      });
    } catch (error) {
      tiktokStatus = "offline_or_unavailable";
      tiktokStats.isLive = false;
      tiktokStats.viewers = null;
      tiktokStats.updatedAt = Date.now();
      console.warn("TikTok chat connection unavailable:", error?.message || error);
    }

    try { await connection?.disconnect(); } catch {}
    await new Promise(resolve => setTimeout(resolve, 30000));
  }
}

require("./twitch-hls")(app);

let restreamWorker = null;
function startRestreamWorker() {
  const hasRestream = Boolean(
    process.env.RESTREAM_RTMP_URL?.trim() && process.env.RESTREAM_STREAM_KEY?.trim()
  );
  const hasDirectDestination = Boolean(process.env.KICK_RTMP_URL || process.env.TIKTOK_RTMP_URL);
  const configured = hasRestream || hasDirectDestination;
  if (!configured || restreamWorker) return;
  console.log("RTMP destinations configured; starting Twitch restream worker.");
  restreamWorker = spawn(process.execPath, [path.join(__dirname, "worker.js")], {
    env: process.env,
    stdio: "inherit"
  });
  restreamWorker.on("error", error => {
    console.error("Could not start Twitch restream worker:", error.message);
    restreamWorker = null;
  });
  restreamWorker.on("close", code => {
    console.error("Twitch restream worker stopped with code:", code);
    restreamWorker = null;
  });
}
function restreamControlAuthorized(req) {
  const expected = process.env.STREAM_CONTROL_TOKEN || "";
  const supplied = req.get("x-stream-control-token") || "";
  if (!expected || !supplied) return false;
  const a = Buffer.from(expected);
  const b = Buffer.from(supplied);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function restreamConfigured() {
  return Boolean(
    (process.env.RESTREAM_RTMP_URL?.trim() && process.env.RESTREAM_STREAM_KEY?.trim()) ||
    process.env.KICK_RTMP_URL || process.env.TIKTOK_RTMP_URL
  );
}


function mediaFiles() {
  return fs.readdirSync(mediaDirectory)
    .filter(name => allowedVideoExtensions.has(path.extname(name).toLowerCase()))
    .map(name => {
      const stat = fs.statSync(path.join(mediaDirectory, name));
      return { name, size: stat.size, updatedAt: stat.mtimeMs };
    })
    .sort((a, b) => b.updatedAt - a.updatedAt);
}

app.get("/media/list", (req, res) => {
  if (!restreamControlAuthorized(req)) return res.status(401).json({ error: "رمز التحكم غير صحيح." });
  return res.json({ files: mediaFiles(), active: activeMediaFile });
});

let activeMediaFile = null;

app.post("/media/upload", (req, res) => {
  if (!restreamControlAuthorized(req)) return res.status(401).json({ error: "رمز التحكم غير صحيح." });
  const originalName = decodeURIComponent(String(req.get("x-file-name") || "video.mp4")).replace(/\\/g, "/").split("/").pop();
  const extension = path.extname(originalName).toLowerCase();
  if (!allowedVideoExtensions.has(extension)) return res.status(400).json({ error: "صيغة الفيديو غير مدعومة. استخدم MP4 أو MOV أو WEBM أو MKV." });
  if (!Buffer.isBuffer(req.body) || req.body.length === 0) return res.status(400).json({ error: "ملف الفيديو فارغ." });
  if (req.body.length > MAX_MEDIA_BYTES) return res.status(413).json({ error: "الحد الأقصى لحجم الفيديو 200 ميجابايت." });
  const filename = crypto.randomUUID() + extension;
  fs.writeFileSync(path.join(mediaDirectory, filename), req.body, { flag: "wx" });
  return res.status(201).json({ ok: true, file: { name: filename, size: req.body.length } });
});

app.post("/media/play", (req, res) => {
  if (!restreamControlAuthorized(req)) return res.status(401).json({ error: "رمز التحكم غير صحيح." });
  if (!restreamWorker || !restreamWorker.connected) return res.status(503).json({ error: "محرك RTMP غير متصل. شغّل إعادة البث أولاً." });
  const name = String(req.body?.name || "");
  if (!name || path.basename(name) !== name || !allowedVideoExtensions.has(path.extname(name).toLowerCase())) {
    return res.status(400).json({ error: "اختر فيديو صالحًا من المرفقات." });
  }
  const filePath = path.join(mediaDirectory, name);
  if (!fs.existsSync(filePath)) return res.status(404).json({ error: "الفيديو غير موجود. ربما حُذف بعد إعادة تشغيل Render." });
  activeMediaFile = name;
  restreamWorker.send({ type: "overlay-start", filePath });
  return res.status(202).json({ ok: true, status: "playing_loop", name });
});

app.post("/media/stop", (req, res) => {
  if (!restreamControlAuthorized(req)) return res.status(401).json({ error: "رمز التحكم غير صحيح." });
  activeMediaFile = null;
  if (restreamWorker?.connected) restreamWorker.send({ type: "overlay-stop" });
  return res.json({ ok: true, status: "returning_to_live" });
});

app.delete("/media/:name", (req, res) => {
  if (!restreamControlAuthorized(req)) return res.status(401).json({ error: "رمز التحكم غير صحيح." });
  const name = String(req.params.name || "");
  if (!name || path.basename(name) !== name) return res.status(400).json({ error: "اسم ملف غير صالح." });
  if (activeMediaFile === name) return res.status(409).json({ error: "أوقف الفيديو قبل حذفه." });
  const filePath = path.join(mediaDirectory, name);
  if (!fs.existsSync(filePath)) return res.status(404).json({ error: "الملف غير موجود." });
  fs.unlinkSync(filePath);
  return res.json({ ok: true });
});

app.get("/restream/status", (_req, res) => {
  res.json({
    status: restreamWorker ? "running" : "stopped",
    configured: restreamConfigured(),
    pid: restreamWorker?.pid || null,
    destination: process.env.RESTREAM_RTMP_URL ? "Restream" : "direct"
  });
});

app.post("/restream/start", (req, res) => {
  if (!restreamControlAuthorized(req)) {
    return res.status(401).json({ error: "رمز التحكم غير صحيح." });
  }
  if (!restreamConfigured()) {
    return res.status(503).json({ error: "إعدادات وجهة RTMP غير مكتملة في Render." });
  }
  if (restreamWorker) return res.json({ ok: true, status: "running" });
  startRestreamWorker();
  if (!restreamWorker) return res.status(500).json({ error: "تعذر تشغيل محرك إعادة البث. راجع سجلات Render." });
  return res.status(202).json({ ok: true, status: "starting" });
});

app.post("/restream/stop", (req, res) => {
  if (!restreamControlAuthorized(req)) {
    return res.status(401).json({ error: "رمز التحكم غير صحيح." });
  }
  if (!restreamWorker) return res.json({ ok: true, status: "stopped" });
  restreamWorker.kill("SIGTERM");
  return res.status(202).json({ ok: true, status: "stopping" });
});

process.on("SIGTERM", () => restreamWorker?.kill("SIGTERM"));
process.on("SIGINT", () => restreamWorker?.kill("SIGINT"));

app.listen(PORT, "0.0.0.0", () => {
  console.log(`Web dashboard listening on port ${PORT}`);
  startTikTokChat().catch(error => console.error("TikTok chat startup error:", error));
  startRestreamWorker();
});
