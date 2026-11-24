const { spawn } = require("child_process");
const fs = require("fs");
const path = require("path");

const twitchChannel = (process.env.TWITCH_CHANNEL || "r119_abdlull").replace(/^@/, "");
const twitchUrl = `https://www.twitch.tv/${twitchChannel}`;
const standbyMessagePath = path.join(require("os").tmpdir(), "live-control-media", "standby-message.txt");
const restreamServer = (process.env.RESTREAM_RTMP_URL || "").trim();
const restreamKey = (process.env.RESTREAM_STREAM_KEY || "").trim();
const destinations = [];
const publisherPort = 20000 + (process.pid % 20000);
const publisherInput = `udp://127.0.0.1:${publisherPort}?fifo_size=131072&overrun_nonfatal=1&buffer_size=1048576`;
const producerOutput = `udp://127.0.0.1:${publisherPort}?pkt_size=1316&buffer_size=1048576`;

const liveVideoFilter = "scale=1280:720:force_original_aspect_ratio=decrease,pad=1280:720:(ow-iw)/2:(oh-ih)/2,fps=30,format=yuv420p";
const liveVideoArgs = ["-c:v", "libx264", "-preset", "ultrafast", "-tune", "zerolatency", "-profile:v", "main", "-pix_fmt", "yuv420p", "-b:v", "2500k", "-maxrate", "2500k", "-bufsize", "5000k", "-g", "60", "-keyint_min", "60"];
const standbyVideoArgs = ["-c:v", "libx264", "-preset", "ultrafast", "-tune", "zerolatency", "-pix_fmt", "yuv420p", "-b:v", "400k", "-maxrate", "400k", "-bufsize", "800k", "-g", "30", "-keyint_min", "30"];
const audioArgs = ["-c:a", "aac", "-b:a", "96k", "-ar", "48000"];
const standbyAudioUrl = "https://backup.qurango.net/radio/yasser_aldosari";
const backgroundMusicUrl = "https://raw.githubusercontent.com/Abboudgg/live/main/waiting.mp3";
const transportArgs = ["-mpegts_flags", "+resend_headers", "-muxdelay", "0", "-muxpreload", "0", "-f", "mpegts", producerOutput];


if (restreamServer && restreamKey) {
  const server = restreamServer.replace(/\/+$/, "");
  const key = restreamKey.replace(/^\/+/, "");
  destinations.push(["Restream", server + "/" + key]);
} else {
  console.error("خدمة Restream مطلوبة. تحقّق من إعداد عنوان الخادم ومفتاح البث في Render.");
  process.exit(1);
}

const configuredDestinations = destinations.filter(([, url]) => Boolean(url));
destinations.length = 0;
destinations.push(...configuredDestinations);

if (destinations.length === 0) {
  console.error("إعدادات Restream غير مكتملة أو غير صحيحة.");
  process.exit(1);
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

let stopping = false;
let publishTestRequested = false;
let manualStandbyRequested = false;
let resumeLiveRequested = false;
let manualStandbyMode = false;
let activeChildren = [];
let manualOverlayFile = null;

process.on("message", message => {
  if (message?.type === "publish-test") {
    publishTestRequested = true;
    console.log("وصل طلب اختبار النشر المؤقت.");
  }
  if (message?.type === "manual-standby") {
    manualStandbyMode = true;
    manualStandbyRequested = true;
    resumeLiveRequested = false;
    console.log("تم طلب شاشة الانتظار اليدوية.");
  }
  if (message?.type === "resume-live") {
    manualStandbyMode = false;
    manualStandbyRequested = false;
    resumeLiveRequested = true;
    manualOverlayFile = null;
    console.log("تم طلب العودة إلى بث Twitch.");
  }
  if (message?.type === "overlay-start" && typeof message.filePath === "string") {
    manualStandbyMode = false;
    manualStandbyRequested = false;
    manualOverlayFile = message.filePath;
    console.log("تم طلب تشغيل الفيديو اليدوي:", path.basename(message.filePath));
  } else if (message?.type === "overlay-stop") {
    manualOverlayFile = null;
    console.log("تم طلب إيقاف الفيديو اليدوي.");
  }
});

let persistentPublisher = null;
let publisherRestartTimer = null;
let publisherRestartAttempts = 0;

function stopChildren() {
  for (const child of activeChildren) {
    if (child && !child.killed) child.kill("SIGTERM");
  }
  activeChildren = [];
}

function startPersistentPublisher() {
  const args = [
    "-hide_banner", "-loglevel", "info",
    "-fflags", "+genpts+discardcorrupt", "-use_wallclock_as_timestamps", "1",
    "-i", publisherInput,
    "-map", "0:v:0", "-map", "0:a:0?",
    "-c", "copy", "-flvflags", "no_duration_filesize",
    "-f", "flv", destinations[0][1]
  ];
  console.log("تشغيل اتصال Restream المستمر؛ تبديل المصادر سيكون داخل الاتصال نفسه.");
  const child = spawnFfmpeg(args, ["ignore", "inherit", "pipe"]);
  persistentPublisher = child;
  const startedAt = Date.now();
  const scheduleRestart = reason => {
    if (persistentPublisher !== child) return;
    persistentPublisher = null;
    if (Date.now() - startedAt >= 60000) publisherRestartAttempts = 0;
    publisherRestartAttempts++;
    const delay = Math.min(60000, 5000 * (2 ** Math.min(publisherRestartAttempts - 1, 4)));
    console.error("اتصال Restream توقف (" + reason + ")؛ إعادة المحاولة خلال " + Math.round(delay / 1000) + " ثانية (محاولة " + publisherRestartAttempts + ").");
    if (!stopping && !publisherRestartTimer) {
      publisherRestartTimer = setTimeout(() => {
        publisherRestartTimer = null;
        if (!stopping) startPersistentPublisher();
      }, delay);
    }
  };
  child.once("error", error => scheduleRestart("خطأ: " + error.message));
  child.once("close", code => scheduleRestart("رمز الخروج " + code));
  return child;
}

function spawnFfmpeg(args, stdio) {
  const child = spawn("ffmpeg", args, { stdio });
  child.stderr.on("data", chunk => {
    let output = chunk.toString();
    for (const [, destination] of destinations) {
      output = output.split(destination).join("[REDACTED_RESTREAM_URL]");
    }
    if (restreamKey) output = output.split(restreamKey).join("[REDACTED]");
    process.stderr.write(output);
  });
  return child;
}

async function runAttempt() {
  console.log("بدء سحب البث من Twitch:", twitchUrl);
  console.log("وجهات البث المفعّلة:", destinations.map(([name]) => name).join(", "));

  const streamlink = spawn("streamlink", ["--twitch-low-latency", "--stdout", twitchUrl, "720p"], {
    stdio: ["ignore", "pipe", "pipe"]
  });

  const ffmpegArgs = [
    "-hide_banner",
    "-loglevel", "info",
    "-progress", "pipe:2", "-stats_period", "10",
    "-fflags", "+genpts",
    "-i", "pipe:0",
    "-stream_loop", "-1",
    "-reconnect", "1", "-reconnect_streamed", "1", "-reconnect_delay_max", "10",
    "-i", backgroundMusicUrl,
    "-filter_complex", "[0:a:0]aresample=48000[mainaudio];[1:a:0]volume=0.20,aresample=48000[music];[mainaudio][music]amix=inputs=2:duration=first:dropout_transition=2[aout]",
    "-map", "0:v:0",
    "-map", "[aout]",
    // Keep Twitch's original H.264 video; mix background music at 20% and encode audio only.
    "-c:v", "copy",
    "-c:a", "aac", "-b:a", "96k", "-ar", "48000",
    "-max_muxing_queue_size", "1024",
    ...transportArgs
  ];

  const ffmpeg = spawnFfmpeg(ffmpegArgs, ["pipe", "inherit", "pipe"]);

  activeChildren = [streamlink, ffmpeg];
  streamlink.stdout.pipe(ffmpeg.stdin);
  console.log("تم تفعيل سحب Twitch بزمن استجابة منخفض، دون تأخير مضاف من العامل.");
  let lastProgressAt = Date.now();
  ffmpeg.stderr.on("data", chunk => {
    if (chunk.toString().includes("out_time_ms=")) lastProgressAt = Date.now();
  });

  let streamlinkError = "";
  streamlink.stderr.on("data", chunk => {
    const line = chunk.toString();
    process.stderr.write(line);
    streamlinkError = (streamlinkError + line).slice(-12000);
  });

  ffmpeg.stdin.on("error", error => {
    if (error.code !== "EPIPE") console.error("خطأ في تمرير البيانات إلى FFmpeg:", error.message);
  });

  return await new Promise(resolve => {
    let settled = false;
    let overlayCheck;
    let watchdog;
    const finish = result => {
      if (settled) return;
      settled = true;
      if (overlayCheck) clearInterval(overlayCheck);
      if (watchdog) clearInterval(watchdog);
      stopChildren();
      resolve({ ...result, streamlinkError });
    };

    watchdog = setInterval(() => {
      if (!settled && Date.now() - lastProgressAt > 45000) {
        console.error("توقف تقدم FFmpeg لمدة 45 ثانية؛ سيتم إعادة تشغيل مصدر البث.");
        finish({ source: "watchdog", code: 1 });
      }
    }, 10000);

    overlayCheck = setInterval(() => {
      if (manualOverlayFile && !settled) {
        console.log("التحويل من Twitch إلى الفيديو اليدوي.");
        finish({ source: "overlay", code: 0 });
      }
      if (manualStandbyRequested && !settled) {
        manualStandbyRequested = false;
        console.log("إيقاف بث Twitch للانتقال إلى شاشة الانتظار اليدوية.");
        finish({ source: "manual-standby", code: 0 });
      }
      if (publishTestRequested && !settled) {
        console.log("إيقاف المصدر الحالي لبدء اختبار النشر المؤقت.");
        finish({ source: "publish-test", code: 0 });
      }
    }, 250);

    streamlink.on("error", error => {
      console.error("تعذّر تشغيل Streamlink:", error.message);
      finish({ source: "streamlink", code: 1 });
    });

    ffmpeg.on("error", error => {
      console.error("تعذّر تشغيل FFmpeg:", error.message);
      finish({ source: "ffmpeg", code: 1 });
    });

    streamlink.on("close", code => {
      console.log("انتهى Streamlink برمز:", code);
      finish({ source: "streamlink", code });
    });

    ffmpeg.on("close", code => {
      console.error("انتهى FFmpeg برمز:", code);
      finish({ source: "ffmpeg", code });
    });
  });
}


async function checkTwitchAvailable() {
  return await new Promise(resolve => {
    const probe = spawn("streamlink", ["--twitch-low-latency", "--stream-url", twitchUrl, "720p"], {
      stdio: ["ignore", "pipe", "ignore"]
    });
    let output = "";
    let settled = false;
    const finish = available => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (!probe.killed) probe.kill("SIGTERM");
      resolve(available);
    };
    const timer = setTimeout(() => finish(false), 12000);
    probe.stdout.on("data", chunk => {
      output = (output + chunk.toString()).slice(-4000);
    });
    probe.on("error", () => finish(false));
    probe.on("close", code => finish(code === 0 && output.trim().length > 0));
  });
}

async function runStandbyUntilLive(statusMessage = "انقطعت إشارة البث\\nنحاول إعادة الاتصال تلقائيًا\\nإذا رجعت الإشارة سيعود البث مباشرة", manual = false) {
  console.log("عرض شاشة انتظار ثابتة مع موسيقى خلفية حتى عودة Twitch.");
  const textFile = path.join(__dirname, "waiting.txt");
  let currentStatusMessage = statusMessage;
  const writeStatus = message => {
    try {
      let customMessage = "";
      try { customMessage = fs.readFileSync(standbyMessagePath, "utf8").trim(); } catch {}
      fs.writeFileSync(textFile, customMessage || message, "utf8");
    } catch (error) {
      console.error("تعذّر تحديث نص حالة البث:", error.message);
    }
  };
  writeStatus(currentStatusMessage);

  const statusFilter =
    "drawtext=fontfile=/usr/share/fonts/truetype/noto/NotoSansArabic-Regular.ttf" +
    ":textfile=" + textFile +
    ":reload=30:fontcolor=white:fontsize=52" +
    ":x=(w-text_w)/2:y=(h-text_h)/2" +
    ":box=1:boxcolor=0x5b1028@0.86:boxborderw=24:text_shaping=1";

  let nextProbeAt = 0;
  let nextMessageRefreshAt = 0;
  while (!stopping) {
    if (manual && resumeLiveRequested) {
      resumeLiveRequested = false;
      console.log("تم استلام أمر العودة إلى Twitch.");
      break;
    }
    if (publishTestRequested) {
      publishTestRequested = false;
      await runPublishTest();
      continue;
    }
    if (manualOverlayFile) {
      console.log("تم طلب الفيديو اليدوي أثناء شاشة الحالة؛ جارٍ التحويل إليه.");
      break;
    }

    const args = [
      "-hide_banner", "-loglevel", "info",
      "-progress", "pipe:2", "-stats_period", "10",
      "-re", "-f", "lavfi", "-i", "color=c=0x5b1028:s=640x360:r=15",
      "-fflags", "+discardcorrupt",
      "-reconnect", "1", "-reconnect_streamed", "1", "-reconnect_delay_max", "10",
      "-i", standbyAudioUrl,
      "-map", "0:v:0", "-map", "1:a:0",
      "-vf", "fps=15,format=yuv420p," + statusFilter,
      "-af", "aresample=async=1000:first_pts=0,volume=0.20"
    ];
    args.push(
      ...standbyVideoArgs,
      ...audioArgs,
      ...transportArgs
    );

    console.log("بدء شاشة انتظار ثابتة مع بث إذاعة ياسر الدوسري بمستوى 20%.");
    const standby = spawnFfmpeg(args, ["ignore", "inherit", "pipe"]);
    activeChildren = [standby];
    let lastStandbyProgressAt = Date.now();
    standby.stderr.on("data", chunk => {
      if (chunk.toString().includes("out_time_ms=")) lastStandbyProgressAt = Date.now();
    });

    const ended = new Promise(resolve => {
      standby.once("error", error => {
        console.error("خطأ FFmpeg أثناء إرسال شاشة الانتظار:", error.message);
        resolve("ended");
      });
      standby.once("close", code => {
        console.warn("انتهى إرسال شاشة الانتظار برمز:", code);
        resolve("ended");
      });
    });

    let switchToLive = false;
    while (!stopping && !switchToLive) {
      if (manualOverlayFile || publishTestRequested || manualStandbyRequested || (manual && resumeLiveRequested)) break;
      const next = await Promise.race([
        sleep(250).then(() => "check"),
        ended
      ]);
      if (next === "ended") {
        console.warn("انقطع إرسال شاشة الانتظار؛ ستتم إعادة تشغيله.");
        break;
      }
      if (Date.now() - lastStandbyProgressAt > 45000) {
        console.warn("توقف تقدم شاشة الانتظار لمدة 45 ثانية؛ ستتم إعادة تشغيلها.");
        if (!standby.killed) standby.kill("SIGTERM");
        break;
      }
      if (Date.now() >= nextMessageRefreshAt) {
        writeStatus(currentStatusMessage);
        nextMessageRefreshAt = Date.now() + 1000;
      }
      if (!manual && Date.now() >= nextProbeAt) {
        if (await checkTwitchAvailable()) {
          console.log("عادت إشارة Twitch؛ جارٍ التحويل من شاشة الانتظار إلى البث المباشر.");
          switchToLive = true;
          break;
        }
        currentStatusMessage = "إشارة البث ما زالت منقطعة\\nنواصل محاولة إعادة الاتصال تلقائيًا\\nتابعونا، وإذا رجعت الإشارة سيعود البث";
        writeStatus(currentStatusMessage);
        console.log("إشارة Twitch غير متاحة؛ نستمر في عرض شاشة الانتظار.");
        nextProbeAt = Date.now() + 15000;
      }
    }

    if (!standby.killed) standby.kill("SIGTERM");
    await Promise.race([ended, sleep(3000)]);
    if (activeChildren[0] === standby) activeChildren = [];

    if (switchToLive || manualOverlayFile || publishTestRequested || manualStandbyRequested || stopping || (manual && resumeLiveRequested)) break;
    console.warn("ستتم إعادة محاولة إرسال شاشة الانتظار بعد 5 ثوانٍ.");
    await sleep(5000);
  }
}

async function runManualOverlayUntilStopped() {
  while (!stopping && manualOverlayFile && !publishTestRequested && !manualStandbyMode) {
    const filePath = manualOverlayFile;
    if (!/^https:\/\//i.test(filePath) && !fs.existsSync(filePath)) {
      console.error("مصدر الفيديو اليدوي غير متاح:", filePath);
      manualOverlayFile = null;
      break;
    }
    console.log("تشغيل الفيديو اليدوي بشكل متكرر:", /^https:\/\//i.test(filePath) ? "MP4 URL" : path.basename(filePath));
    const args = [
      "-hide_banner", "-loglevel", "info",
      "-stream_loop", "-1", "-re", "-i", filePath,
      "-f", "lavfi", "-i", "anullsrc=channel_layout=stereo:sample_rate=48000",
      "-map", "0:v:0", "-map", "0:a:0?", "-map", "1:a:0",
      "-vf", liveVideoFilter,
      ...liveVideoArgs,
      ...audioArgs,
      "-max_muxing_queue_size", "1024",
      ...transportArgs
    ];
    const overlay = spawnFfmpeg(args, ["ignore", "inherit", "pipe"]);
    activeChildren = [overlay];
    await new Promise(resolve => {
      let finished = false;
      const finish = () => {
        if (finished) return;
        finished = true;
        clearInterval(check);
        resolve();
      };
      overlay.once("error", error => {
        console.error("خطأ FFmpeg في الفيديو اليدوي:", error.message);
        finish();
      });
      overlay.once("close", code => {
        console.log("Manual video انتهى FFmpeg برمز:", code);
        finish();
      });
      const check = setInterval(() => {
        if (stopping || publishTestRequested || manualStandbyMode || !manualOverlayFile || manualOverlayFile !== filePath) {
          if (!overlay.killed) overlay.kill("SIGTERM");
          finish();
        }
      }, 250);
    });
    activeChildren = [];
    if (manualOverlayFile === filePath && !stopping) {
      console.warn("توقف مُرمّز الفيديو اليدوي بشكل غير متوقع؛ ستتم إعادة المحاولة بعد 5 ثوانٍ.");
      await sleep(5000);
    }
  }
  console.log("انتهى وضع الفيديو اليدوي؛ العودة إلى بث Twitch المباشر.");
}

async function main() {
  startPersistentPublisher();
  await sleep(500);
  while (!stopping) {
    if (manualStandbyMode) {
      manualStandbyRequested = false;
      await runStandbyUntilLive("شاشة الانتظار\nاضغط ابدأ البث للعودة إلى Twitch", true);
      if (resumeLiveRequested) resumeLiveRequested = false;
      continue;
    }
    if (manualOverlayFile) {
      await runManualOverlayUntilStopped();
      continue;
    }

    const result = await runAttempt();
    if (stopping) break;

    if (manualStandbyMode || result.source === "manual-standby") {
      manualStandbyRequested = false;
      await runStandbyUntilLive("شاشة الانتظار\nاضغط ابدأ البث للعودة إلى Twitch", true);
      if (resumeLiveRequested) resumeLiveRequested = false;
      continue;
    }

    if (manualOverlayFile || result.source === "overlay") {
      await runManualOverlayUntilStopped();
      continue;
    }

    const message = result.streamlinkError.toLowerCase();
    const twitchOffline =
      result.source === "streamlink" &&
      (
        message.includes("no playable streams found") ||
        message.includes("is offline") ||
        message.includes("stream is offline") ||
        message.includes("no streams found")
      );

    let statusMessage;
    if (twitchOffline) {
      console.log("قناة Twitch غير متصلة حاليًا.");
      statusMessage = "قناة البث غير مباشرة حاليًا\nننتظر عودتها ونحاول الاتصال تلقائيًا\nإذا رجعت الإشارة سيعود البث مباشرة";
    } else if (result.source === "ffmpeg") {
      console.warn("انقطع اتصال RTMP/FFmpeg بشكل غير متوقع.");
      statusMessage = "انقطع الاتصال بخادم البث\nنحاول إعادة الاتصال تلقائيًا\nإذا استقر الاتصال سيعود البث مباشرة";
    } else {
      console.warn("انقطع الاتصال ببث Twitch بشكل غير متوقع.");
      statusMessage = "انقطعت إشارة Twitch\nنحاول إعادة الاتصال تلقائيًا\nإذا رجعت الإشارة سيعود البث مباشرة";
    }

    await runStandbyUntilLive(statusMessage);
  }
}

async function runPublishTest() {
  console.log("بدء اختبار نشر ثابت إلى Restream لمدة 15 ثانية.");
  const args = [
    "-hide_banner", "-loglevel", "info",
    "-re", "-f", "lavfi", "-i", "testsrc2=size=1280x720:rate=30",
    "-re", "-f", "lavfi", "-i", "anullsrc=channel_layout=stereo:sample_rate=48000",
    "-t", "15",
    "-c:v", "libx264", "-preset", "ultrafast", "-tune", "zerolatency",
    "-pix_fmt", "yuv420p", "-b:v", "1200k", "-maxrate", "1200k", "-bufsize", "2400k",
    "-g", "60", "-keyint_min", "60",
    "-c:a", "aac", "-b:a", "96k", "-ar", "48000",
    "-mpegts_flags", "+resend_headers", "-muxdelay", "0", "-muxpreload", "0",
    "-f", "mpegts", producerOutput
  ];
  const test = spawnFfmpeg(args, ["ignore", "inherit", "pipe"]);
  activeChildren = [test];
  await new Promise(resolve => {
    test.once("error", error => { console.error("تعذّر تشغيل اختبار النشر:", error.message); resolve(); });
    test.once("close", code => { console.log("انتهى اختبار النشر برمز:", code); resolve(); });
  });
  if (activeChildren[0] === test) activeChildren = [];
  console.log("انتهى الاختبار؛ ستتم العودة إلى مصدر Twitch تلقائيًا.");
}

function shutdown() {
  if (stopping) return;
  stopping = true;
  stopChildren();
  if (publisherRestartTimer) clearTimeout(publisherRestartTimer);
  publisherRestartTimer = null;
  if (persistentPublisher && !persistentPublisher.killed) persistentPublisher.kill("SIGTERM");
}

process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);

main().catch(error => {
  console.error("خطأ في عامل إعادة البث:", error?.message || error);
  shutdown();
  process.exitCode = 1;
});
