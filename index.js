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

const mediaDirectory = path.join(os.tmpdir(), "live-control-media");
fs.mkdirSync(mediaDirectory, { recursive: true });
const standbyVideoPath = path.join(mediaDirectory, "automatic-standby-video");
let standbyVideoUrl = "";
let manualStandbyUrl = "";
let manualStandbyEnabled = false;
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
let restreamWorkerState = "stopped";
let restreamStopRequested = false;
let restreamRestartTimer = null;
let restreamStableTimer = null;
let restreamRestartAttempts = 0;

function scheduleRestreamRestart(reason) {
  if (restreamStopRequested || !restreamConfigured() || restreamRestartTimer) return;
  restreamRestartAttempts++;
  const delay = Math.min(30000, 3000 * (2 ** Math.min(restreamRestartAttempts - 1, 4)));
  restreamWorkerState = "restarting";
  console.warn(`RTMP worker will restart in ${Math.round(delay / 1000)}s (attempt ${restreamRestartAttempts}): ${reason}`);
  restreamRestartTimer = setTimeout(() => {
    restreamRestartTimer = null;
    startRestreamWorker();
  }, delay);
}

function startRestreamWorker() {
  const hasRestream = Boolean(
    process.env.RESTREAM_RTMP_URL?.trim() && process.env.RESTREAM_STREAM_KEY?.trim()
  );
  const hasDirectDestination = Boolean(process.env.KICK_RTMP_URL || process.env.TIKTOK_RTMP_URL);
  const configured = hasRestream || hasDirectDestination;
  if (!configured || restreamWorker || restreamStopRequested) return;
  if (restreamRestartTimer) {
    clearTimeout(restreamRestartTimer);
    restreamRestartTimer = null;
  }
  console.log("RTMP destinations configured; starting Twitch restream worker.");
  restreamWorkerState = "starting";
  const worker = spawn(process.execPath, [path.join(__dirname, "worker.js")], {
    env: process.env,
    stdio: ["ignore", "inherit", "inherit", "ipc"]
  });
  restreamWorker = worker;
  worker.once("spawn", () => {
    if (restreamWorker !== worker) return;
    restreamWorkerState = "running";
    if (standbyVideoUrl) worker.send({ type: "standby-url", url: standbyVideoUrl });
    if (manualStandbyEnabled && manualStandbyUrl) worker.send({ type: "overlay-start", filePath: manualStandbyUrl });
    if (restreamStableTimer) clearTimeout(restreamStableTimer);
    restreamStableTimer = setTimeout(() => {
      restreamRestartAttempts = 0;
      restreamStableTimer = null;
    }, 60000);
  });
  worker.on("error", error => {
    console.error("Could not start Twitch restream worker:", error.message);
    if (restreamWorker === worker) restreamWorker = null;
    if (restreamStableTimer) {
      clearTimeout(restreamStableTimer);
      restreamStableTimer = null;
    }
    scheduleRestreamRestart(error.message);
  });
  worker.once("close", code => {
    console.error("Twitch restream worker stopped with code:", code);
    if (restreamWorker === worker) restreamWorker = null;
    if (restreamStableTimer) {
      clearTimeout(restreamStableTimer);
      restreamStableTimer = null;
    }
    if (restreamStopRequested) {
      restreamWorkerState = "stopped";
      return;
    }
    scheduleRestreamRestart("worker exited with code " + code);
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


function validMp4Url(value) {
  try {
    const url = new URL(String(value || "").trim());
    return url.protocol === "https:" && /\.mp4(?:$|[?#])/i.test(url.href);
  } catch { return false; }
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

// Public, unguessable UUID media URLs for external MP4 players.
app.get("/media/file/:name", (req, res) => {
  const name = String(req.params.name || "");
  if (!name || path.basename(name) !== name || !/^[0-9a-f-]{36}\.(mp4|mov|m4v|webm|mkv)$/i.test(name)) {
    return res.status(400).send("Invalid media name");
  }
  const filePath = path.join(mediaDirectory, name);
  if (!fs.existsSync(filePath)) return res.status(404).send("Media not found");
  res.setHeader("Cache-Control", "public, max-age=3600");
  return res.sendFile(filePath);
});

app.get("/media/loop/:name", (req, res) => {
  const name = String(req.params.name || "");
  if (!name || path.basename(name) !== name || !/^[0-9a-f-]{36}\.(mp4|mov|m4v|webm|mkv)$/i.test(name)) {
    return res.status(400).send("Invalid media name");
  }
  const filePath = path.join(mediaDirectory, name);
  if (!fs.existsSync(filePath)) return res.status(404).send("Media not found");
  const source = "/media/file/" + encodeURIComponent(name);
  res.type("html").send(`<!doctype html><html lang="ar" dir="rtl"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>LIVE LOOP</title><style>body{margin:0;background:#080b12;color:#fff;font:16px system-ui;display:grid;place-items:center;min-height:100vh}main{width:min(100%,1100px);padding:16px;box-sizing:border-box}video{width:100%;max-height:82vh;background:#000;border-radius:14px}p{text-align:center;color:#aeb8c8}</style><main><video controls autoplay loop playsinline src="${source}"></video><p>LIVE · تشغيل متكرر LOOP</p></main></html>`);
});

app.get("/media/list", (req, res) => {
  if (!restreamControlAuthorized(req)) return res.status(401).json({ error: "رمز التحكم غير صحيح." });
  return res.json({ files: mediaFiles(), active: activeMediaFile });
});

app.get("/media/url", (req, res) => {
  if (!restreamControlAuthorized(req)) return res.status(401).json({ error: "رمز التحكم غير صحيح." });
  return res.json({ configured: Boolean(manualStandbyUrl), url: manualStandbyUrl, active: Boolean(manualStandbyUrl && restreamWorker?.connected) });
});

app.post("/media/url", express.json({ limit: "8kb" }), (req, res) => {
  if (!restreamControlAuthorized(req)) return res.status(401).json({ error: "رمز التحكم غير صحيح." });
  const url = String(req.body?.url || "").trim();
  if (!validMp4Url(url)) return res.status(400).json({ error: "أدخل رابط MP4 مباشر يبدأ بـ HTTPS وينتهي بـ .mp4." });
  manualStandbyUrl = url;
  return res.json({ ok: true, configured: true, url });
});

app.get("/standby-video/url", (req, res) => {
  if (!restreamControlAuthorized(req)) return res.status(401).json({ error: "رمز التحكم غير صحيح." });
  return res.json({ configured: Boolean(standbyVideoUrl), url: standbyVideoUrl });
});

app.post("/standby-video/url", express.json({ limit: "8kb" }), (req, res) => {
  if (!restreamControlAuthorized(req)) return res.status(401).json({ error: "رمز التحكم غير صحيح." });
  const url = String(req.body?.url || "").trim();
  if (!validMp4Url(url)) return res.status(400).json({ error: "أدخل رابط MP4 مباشر يبدأ بـ HTTPS وينتهي بـ .mp4." });
  standbyVideoUrl = url;
  if (restreamWorker?.connected) restreamWorker.send({ type: "standby-url", url });
  return res.json({ ok: true, configured: true, url });
});

app.get("/standby/manual", (req, res) => {
  if (!restreamControlAuthorized(req)) return res.status(401).json({ error: "رمز التحكم غير صحيح." });
  return res.json({ enabled: manualStandbyEnabled, url: manualStandbyUrl });
});

app.post("/standby/manual", express.json({ limit: "8kb" }), (req, res) => {
  if (!restreamControlAuthorized(req)) return res.status(401).json({ error: "رمز التحكم غير صحيح." });
  const enabled = Boolean(req.body?.enabled);
  if (!restreamWorker?.connected) return res.status(503).json({ error: "محرك RTMP غير متصل. شغّل البث أولاً." });
  if (enabled) {
    const url = String(req.body?.url || manualStandbyUrl || "").trim();
    if (!validMp4Url(url)) return res.status(400).json({ error: "أدخل رابط MP4 مباشر وصحيح أولاً." });
    manualStandbyUrl = url;
  } else {
    manualStandbyEnabled = false;
  }
  if (enabled) manualStandbyEnabled = true;
  restreamWorker.send(enabled ? { type: "overlay-start", filePath: manualStandbyUrl } : { type: "overlay-stop" });
  return res.json({ ok: true, enabled, status: enabled ? "manual_standby" : "returning_to_live" });
});

app.get("/standby-video", (req, res) => {
  if (!restreamControlAuthorized(req)) return res.status(401).json({ error: "رمز التحكم غير صحيح." });
  if (standbyVideoUrl) return res.json({ configured: true, url: standbyVideoUrl, source: "url" });
  if (!fs.existsSync(standbyVideoPath)) return res.json({ configured: false });
  const stat = fs.statSync(standbyVideoPath);
  return res.json({ configured: true, size: stat.size, updatedAt: stat.mtimeMs });
});

app.post("/standby-video/upload", express.raw({ type: "application/octet-stream", limit: MAX_MEDIA_BYTES }), (req, res) => {
  if (!restreamControlAuthorized(req)) return res.status(401).json({ error: "رمز التحكم غير صحيح." });
  const originalName = decodeURIComponent(String(req.get("x-file-name") || "standby.mp4")).replace(/\\/g, "/").split("/").pop();
  const extension = path.extname(originalName).toLowerCase();
  if (!allowedVideoExtensions.has(extension)) return res.status(400).json({ error: "صيغة الفيديو غير مدعومة." });
  if (!Buffer.isBuffer(req.body) || req.body.length === 0) return res.status(400).json({ error: "ملف الفيديو فارغ." });
  if (req.body.length > MAX_MEDIA_BYTES) return res.status(413).json({ error: "الحد الأقصى لحجم الفيديو 200 ميجابايت." });
  fs.writeFileSync(standbyVideoPath, req.body);
  standbyVideoUrl = "";
  return res.status(201).json({ ok: true, configured: true, size: req.body.length });
});

app.delete("/standby-video", (req, res) => {
  if (!restreamControlAuthorized(req)) return res.status(401).json({ error: "رمز التحكم غير صحيح." });
  if (fs.existsSync(standbyVideoPath)) fs.unlinkSync(standbyVideoPath);
  standbyVideoUrl = "";
  if (restreamWorker?.connected) restreamWorker.send({ type: "standby-url", url: "" });
  return res.json({ ok: true, configured: false });
});

let activeMediaFile = null;

app.post("/media/upload", express.raw({ type: "application/octet-stream", limit: MAX_MEDIA_BYTES }), (req, res) => {
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

app.post("/media/play", express.json({ limit: "1mb" }), (req, res) => {
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
    status: restreamWorkerState,
    configured: restreamConfigured(),
    pid: restreamWorker?.pid || null,
    restartAttempts: restreamRestartAttempts,
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
  restreamStopRequested = false;
  if (restreamWorker) return res.json({ ok: true, status: restreamWorkerState });
  startRestreamWorker();
  if (!restreamWorker) return res.status(500).json({ error: "تعذر تشغيل محرك إعادة البث. راجع سجلات Render." });
  return res.status(202).json({ ok: true, status: "starting" });
});

app.post("/restream/stop", (req, res) => {
  if (!restreamControlAuthorized(req)) {
    return res.status(401).json({ error: "رمز التحكم غير صحيح." });
  }
  restreamStopRequested = true;
  if (restreamRestartTimer) {
    clearTimeout(restreamRestartTimer);
    restreamRestartTimer = null;
  }
  if (!restreamWorker) {
    restreamWorkerState = "stopped";
    return res.json({ ok: true, status: "stopped" });
  }
  restreamWorkerState = "stopping";
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
