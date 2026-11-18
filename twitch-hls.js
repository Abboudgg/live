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
  let streamlink = null;
  let ffmpeg = null;
  let status = "offline";
  let lastError = null;

  function authorized(req) {
    const expected = process.env.STREAM_CONTROL_TOKEN || "";
    const supplied = req.get("x-stream-control-token") || "";
    if (!expected || !supplied) return false;
    const a = Buffer.from(expected);
    const b = Buffer.from(supplied);
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  }

  function stopStream() {
    if (streamlink && !streamlink.killed) streamlink.kill("SIGTERM");
    if (ffmpeg && !ffmpeg.killed) ffmpeg.kill("SIGTERM");
    streamlink = null;
    ffmpeg = null;
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
      url: status === "live" || status === "starting" ? "/live/twitch/index.m3u8" : null,
      error: lastError
    });
  });

  app.post("/twitch-stream/start", (req, res) => {
    if (!authorized(req)) return res.status(401).json({ error: "أدخل رمز التحكم الصحيح. أضف STREAM_CONTROL_TOKEN في إعدادات Render." });
    if (status === "starting" || status === "live") {
      return res.json({ ok: true, status, url: "/live/twitch/index.m3u8" });
    }

    try {
      fs.rmSync(outputDir, { recursive: true, force: true });
      fs.mkdirSync(outputDir, { recursive: true });
      lastError = null;
      status = "starting";

      streamlink = spawn("streamlink", ["--stdout", sourceUrl, "best"], {
        stdio: ["ignore", "pipe", "inherit"]
      });
      ffmpeg = spawn("ffmpeg", [
        "-hide_banner", "-loglevel", "warning",
        "-i", "pipe:0",
        "-map", "0:v:0?", "-map", "0:a:0?",
        "-c", "copy",
        "-f", "hls",
        "-hls_time", "4",
        "-hls_list_size", "8",
        "-hls_flags", "delete_segments+append_list+omit_endlist",
        "-hls_segment_filename", path.join(outputDir, "segment_%06d.ts"),
        playlistPath
      ], { stdio: ["pipe", "ignore", "inherit"] });

      streamlink.stdout.pipe(ffmpeg.stdin);
      streamlink.on("error", error => {
        lastError = "Streamlink: " + error.message;
        stopStream();
      });
      ffmpeg.on("error", error => {
        lastError = "FFmpeg: " + error.message;
        stopStream();
      });
      streamlink.on("close", code => {
        if (status !== "offline") {
          if (code && code !== 0) lastError = "Streamlink انتهى برمز " + code;
          stopStream();
        }
      });
      ffmpeg.on("close", code => {
        if (status !== "offline") {
          if (code && code !== 0) lastError = "FFmpeg انتهى برمز " + code;
          stopStream();
        }
      });

      const checkPlaylist = setInterval(() => {
        if (status === "offline") return clearInterval(checkPlaylist);
        try {
          if (fs.existsSync(playlistPath) && fs.statSync(playlistPath).size > 0) {
            status = "live";
            clearInterval(checkPlaylist);
          }
        } catch {}
      }, 1000);
      setTimeout(() => clearInterval(checkPlaylist), 30000);

      return res.status(202).json({ ok: true, status, url: "/live/twitch/index.m3u8" });
    } catch (error) {
      lastError = error.message;
      stopStream();
      return res.status(500).json({ error: lastError });
    }
  });

  app.post("/twitch-stream/stop", (req, res) => {
    if (!authorized(req)) return res.status(401).json({ error: "رمز التحكم غير صحيح." });
    stopStream();
    return res.json({ ok: true, status });
  });
};
