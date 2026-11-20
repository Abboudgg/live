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
  const wisdomTextPath = path.join(outputDir, "offline-wisdom.txt");
  fs.mkdirSync(outputDir, { recursive: true });

  let streamlink = null;
  let ffmpeg = null;
  let status = "offline";
  let lastError = null;
  let enabled = false;
  let retryTimer = null;
  let wisdomTimer = null;
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
        const match = name.match(/^segment_(\d+)\.ts$/);
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
    if (wisdomTimer) clearInterval(wisdomTimer);
    wisdomTimer = null;
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
    fs.writeFileSync(statusTextPath, "إشارة منقطعة\nالبث مسكر حالياً\nنحاول إعادة الاتصال تلقائياً", "utf8");
    const wisdomLines = [
      "1. السمكة إذا عطشت شربت موية.",
      "2. الباب إذا تسكّر ما عاد هو مفتوح.",
      "3. اللي يمشي يوصل، إلا إذا ضيّع الطريق.",
      "4. الشمس تطلع بالنهار عشان الليل ما يزعل.",
      "5. الموية تبلل إذا لمستها.",
      "6. المروحة تلف لأنها ما تعرف تمشي.",
      "7. اللي يطالع الساعة يعرف الوقت.",
      "8. لا تحط الجوال بالثلاجة إلا لمكالمة باردة.",
      "9. إذا طاح القلم لا تدور عليه فوق السقف.",
      "10. الزرافة طويلة، وهذه معلومة طويلة.",
      "11. لا تثق بالكرسي، ممكن يقعدك.",
      "12. إذا نسيت جوالك اتصل عليه من جوالك.",
      "13. البطريق ناسي كلمة سر الطيران.",
      "14. لا تسبح في الصحراء، ما فيه بحر.",
      "15. إذا دق الجرس لا ترد عليه برسالة.",
      "16. القمر عنده دوام ليلي.",
      "17. لا تأكل الشاحن حتى لو كان سريع.",
      "18. إذا ركبت المصعد ونزلت فأنت ما طلعت.",
      "19. الجزرة تقوي النظر، خصوصاً إذا شفتها.",
      "20. إذا انكسر الصحن صار مكسور."
    ];
    let wisdomIndex = 0;
    const showWisdom = () => {
      fs.writeFileSync(wisdomTextPath, wisdomLines[wisdomIndex], "utf8");
      wisdomIndex = (wisdomIndex + 1) % wisdomLines.length;
    };
    showWisdom();
    wisdomTimer = setInterval(showWisdom, 15000);
    const font = "fontfile=/usr/share/fonts/truetype/noto/NotoSansArabic-Regular.ttf";
    const filters = [
      "drawbox=x=0:y=0:w=320:h=ih:color=0x1261D8@0.78:t=fill",
      "drawbox=x=320:y=0:w=320:h=ih:color=0xD62828@0.76:t=fill",
      "drawbox=x=640:y=0:w=320:h=ih:color=0x168A45@0.76:t=fill",
      "drawbox=x=960:y=0:w=320:h=ih:color=0x7137C8@0.76:t=fill",
      "drawbox=x=20:y=20:w=1240:h=680:color=0x101018@0.38:t=fill",
      "hue=h='mod(floor(t/5)*47,360)':s=1",
      "drawtext=" + font + ":text=CASS:fontcolor=white:fontsize=58:x=(w-text_w)/2:y=22:borderw=3:bordercolor=black",
      "drawtext=" + font + ":textfile=" + wisdomTextPath + ":reload=1:fontcolor=white:fontsize=25:x=(w-text_w)/2:y=(h-text_h)/2+75:box=1:boxcolor=0x101018@0.70:boxborderw=18:text_shaping=1",
      "drawtext=" + font + ":text=حكم عبدالله ومتعب الذهبية:fontcolor=0xFFE066:fontsize=17:x=35:y=h-45:borderw=2:bordercolor=black:text_shaping=1",
      "drawtext=" + font + ":text=إشارة منقطعة:fontcolor=white:fontsize=30:x=(w-text_w)/2:y=(h-text_h)/2:borderw=2:bordercolor=black:text_shaping=1",
      "drawtext=" + font + ":text=البث مسكر حالياً:fontcolor=white:fontsize=30:x=35:y=165:borderw=2:bordercolor=black:text_shaping=1",
      "drawtext=" + font + ":text=نحاول إعادة الاتصال تلقائياً:fontcolor=white:fontsize=23:x=35:y=215:borderw=2:bordercolor=black:text_shaping=1"
    ];
    const filter = filters.join(",");
    ffmpeg = spawn("ffmpeg", hlsArgs([
      "-re", "-f", "lavfi", "-i", "color=c=0x090910:s=1280x720:r=25",
      "-re", "-f", "lavfi", "-i", "anoisesrc=color=white:amplitude=0.22:sample_rate=44100",
      "-re", "-f", "lavfi", "-i", "anoisesrc=color=brown:amplitude=0.8:sample_rate=44100",
      "-vf", filter
    ], [
      "-filter_complex", "[1:a]highpass=f=700,lowpass=f=9000,volume=0.22[rain];[2:a]lowpass=f=160,volume='0.05+0.55*(0.5+0.5*sin(2*PI*t/21))'[thunder];[rain][thunder]amix=inputs=2:duration=longest:normalize=0[aout]",
      "-map", "0:v:0", "-map", "[aout]"
    ], [
      "-c:v", "libx264", "-preset", "ultrafast", "-tune", "zerolatency",
      "-pix_fmt", "yuv420p", "-g", "50", "-keyint_min", "50",
      "-c:a", "aac", "-b:a", "128k", "-ar", "44100"
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

  app.get("/live/twitch/index.m3u8", (req, res, next) => {
    const deadline = Date.now() + 12000;
    const waitForPlaylist = () => {
      if (fs.existsSync(playlistPath) && fs.statSync(playlistPath).size > 0) {
        res.type("application/vnd.apple.mpegurl");
        res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate");
        return res.sendFile(playlistPath);
      }
      if (Date.now() >= deadline) return res.status(503).type("text/plain").send("HLS stream is starting. Retry shortly.");
      setTimeout(waitForPlaylist, 300);
    };
    waitForPlaylist();
  });

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
