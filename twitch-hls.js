const { spawn } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");

module.exports = function registerTwitchHls(app) {
  const channel = (process.env.TWITCH_CHANNEL || "r119_abdlull").replace(/^@/, "");
  const sourceUrl = "https://www.twitch.tv/" + channel;
  const outputDir = path.join(os.tmpdir(), "live-twitch-hls");
  const playlistPath = path.join(outputDir, "index.m3u8");
  const statusTextPath = path.join(outputDir, "offline-status.txt");
  fs.mkdirSync(outputDir, { recursive: true });

  let streamlink = null;
  let ffmpeg = null;
  let status = "offline";
  let lastError = null;
  let enabled = false;
  let retryTimer = null;
  let generation = 0;

  function authorized(req) {
    const expected = process.env.STREAM_CONTROL_TOKEN || "";
    const supplied = req.get("x-stream-control-token") || "";
    if (!expected || !supplied) return false;
    const a = Buffer.from(expected);
    const b = Buffer.from(supplied);
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  }

  function nextSegmentNumber() {
    try {
      const files = fs.readdirSync(outputDir);
      const numbers = files.map(name => {
        const match = name.match(/^segment_(\\d+)\\.ts$/);
        return match ? Number(match[1]) : -1;
      });
      return Math.max(0, ...numbers) + 1;
    } catch {
      return 0;
    }
  }

  function hlsArgs(inputArgs, mapArgs, codecArgs) {
    const number = nextSegmentNumber();
    return [
      "-hide_banner", "-loglevel", "warning",
      ...inputArgs, ...mapArgs, ...codecArgs,
      "-f", "hls", "-hls_time", "4", "-hls_list_size", "8",
      "-hls_flags", "delete_segments+append_list+omit_endlist+discont_start",
      "-start_number", String(number),
      "-hls_segment_filename", path.join(outputDir, "segment_%06d.ts"),
      playlistPath
    ];
  }

  function stopChildren() {
    const oldStreamlink = streamlink;
    const oldFfmpeg = ffmpeg;
    streamlink = null;
    ffmpeg = null;
    if (oldStreamlink && !oldStreamlink.killed) oldStreamlink.kill("SIGTERM");
    if (oldFfmpeg && !oldFfmpeg.killed) oldFfmpeg.kill("SIGTERM");
  }

  function scheduleRetry(token) {
    if (!enabled || token !== generation || retryTimer) return;
    retryTimer = setTimeout(() => {
      retryTimer = null;
      checkAndStartLive(token);
    }, 15000);
  }

  function startOfflineScreen(token) {
    if (!enabled || token !== generation) return;
    status = "offline";
    fs.writeFileSync(statusTextPath, "إشارة منقطعة\\nالبث مسكر حالياً\\nنحاول إعادة الاتصال تلقائياً", "utf8");
    const filter =
      "drawtext=fontfile=/usr/share/fonts/truetype/noto/NotoSansArabic-Regular.ttf" +
      ":textfile=" + statusTextPath +
      ":reload=1:fontcolor=white:fontsize=54" +
      ":x=(w-text_w)/2:y=(h-text_h)/2" +
      ":box=1:boxcolor=0x171321@0.9:boxborderw=30:text_shaping=1";
    ffmpeg = spawn("ffmpeg", hlsArgs([
      "-re", "-f", "lavfi", "-i", "color=c=0x090910:s=1280x720:r=25",
      "-re", "-f", "lavfi", "-i", "anullsrc=channel_layout=stereo:sample_rate=44100",
      "-vf", filter
    ], [
      "-map", "0:v:0", "-map", "1:a:0"
    ], [
      "-c:v", "libx264", "-preset", "ultrafast", "-tune", "zerolatency",
      "-pix_fmt", "yuv420p", "-g", "50", "-keyint_min", "50",
      "-c:a", "aac", "-b:a", "96k", "-ar", "44100"
    ]), { stdio: ["ignore", "ignore", "inherit"] });
    const child = ffmpeg;
    child.once("error", error => {
      if (ffmpeg !== child || token !== generation) return;
      lastError = "FFmpeg شاشة الانقطاع: " + error.message;
      scheduleRetry(token);
    });
    child.once("close", () => {
      if (ffmpeg === child && enabled && token === generation) {
        ffmpeg = null;
        scheduleRetry(token);
      }
    });
  }

  function checkAndStartLive(token) {
    if (!enabled || token !== generation || status === "live" || status === "starting") return;
    status = "starting";
    const probe = spawn("streamlink", ["--stream-url", sourceUrl, "best"], {
      stdio: ["ignore", "ignore", "pipe"]
    });
    let probeError = "";
    probe.stderr.on("data", chunk => { probeError = (probeError + chunk.toString()).slice(-2000); });
    probe.once("error", error => {
      if (token !== generation || !enabled) return;
      lastError = "Streamlink: " + error.message;
      status = "offline";
      scheduleRetry(token);
    });
    probe.once("close", code => {
      if (token !== generation || !enabled) return;
      if (code !== 0) {
        lastError = probeError.trim() || "قناة Twitch غير مباشرة حالياً.";
        status = "offline";
        scheduleRetry(token);
        return;
      }
      startLive(token);
    });
  }

  function startLive(token) {
    if (!enabled || token !== generation) return;
    stopChildren();
    status = "starting";
    streamlink = spawn("streamlink", ["--stdout", sourceUrl, "best"], {
      stdio: ["ignore", "pipe", "inherit"]
    });
    const liveStreamlink = streamlink;
    ffmpeg = spawn("ffmpeg", hlsArgs([
      "-i", "pipe:0"
    ], [
      "-map", "0:v:0?", "-map", "0:a:0?"
    ], [
      "-c", "copy"
    ]), { stdio: ["pipe", "ignore", "inherit"] });
    const liveFfmpeg = ffmpeg;
    liveStreamlink.stdout.pipe(liveFfmpeg.stdin);
    liveFfmpeg.stdin.on("error", error => {
      if (error.code !== "EPIPE" && token === generation) lastError = "FFmpeg input: " + error.message;
    });
    liveStreamlink.once("error", error => {
      if (token !== generation || !enabled) return;
      lastError = "Streamlink: " + error.message;
      switchToOffline(token);
    });
    liveFfmpeg.once("error", error => {
      if (token !== generation || !enabled) return;
      lastError = "FFmpeg: " + error.message;
      switchToOffline(token);
    });
    liveStreamlink.once("close", code => {
      if (token !== generation || !enabled || streamlink !== liveStreamlink) return;
      if (code && code !== 0) lastError = "Streamlink انتهى برمز " + code;
      switchToOffline(token);
    });
    liveFfmpeg.once("close", code => {
      if (token !== generation || !enabled || ffmpeg !== liveFfmpeg) return;
      if (code && code !== 0) lastError = "FFmpeg انتهى برمز " + code;
      switchToOffline(token);
    });
    const check = setInterval(() => {
      if (token !== generation || !enabled || ffmpeg !== liveFfmpeg) return clearInterval(check);
      try {
        if (fs.existsSync(playlistPath) && fs.statSync(playlistPath).size > 0) {
          status = "live";
          lastError = null;
          clearInterval(check);
        }
      } catch {}
    }, 1000);
    setTimeout(() => {
      clearInterval(check);
      if (status === "starting" && token === generation && enabled) {
        lastError = "لم يصل بث Twitch خلال 45 ثانية.";
        switchToOffline(token);
      }
    }, 45000);
  }

  function switchToOffline(token) {
    if (!enabled || token !== generation) return;
    stopChildren();
    startOfflineScreen(token);
    scheduleRetry(token);
  }

  function startMonitor() {
    if (enabled) return;
    enabled = true;
    generation++;
    const token = generation;
    lastError = null;
    stopChildren();
    startOfflineScreen(token);
    checkAndStartLive(token);
  }

  function stopMonitor() {
    enabled = false;
    generation++;
    if (retryTimer) clearTimeout(retryTimer);
    retryTimer = null;
    stopChildren();
    status = "offline";
  }

  app.use("/live/twitch", (req, res, next) => {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate");
    if (req.path.endsWith(".m3u8")) res.type("application/vnd.apple.mpegurl");
    else if (req.path.endsWith(".ts")) res.type("video/mp2t");
    next();
  }, require("express").static(outputDir, { fallthrough: true }));

  app.get("/twitch-stream/status", (_req, res) => {
    res.json({
      status,
      channel,
      url: "/live/twitch/index.m3u8",
      error: lastError
    });
  });

  app.post("/twitch-stream/start", (req, res) => {
    if (!authorized(req)) return res.status(401).json({ error: "أدخل رمز التحكم الصحيح. أضف STREAM_CONTROL_TOKEN في إعدادات Render." });
    startMonitor();
    return res.status(202).json({ ok: true, status, url: "/live/twitch/index.m3u8" });
  });

  app.post("/twitch-stream/stop", (req, res) => {
    if (!authorized(req)) return res.status(401).json({ error: "رمز التحكم غير صحيح." });
    stopMonitor();
    return res.json({ ok: true, status });
  });

  // Keep the M3U8 endpoint available after every server restart, including while Twitch is offline.
  startMonitor();
};
