const { spawn } = require("child_process");
const { Readable } = require("stream");
const { pipeline } = require("stream/promises");
const fs = require("fs");
const path = require("path");

const twitchChannel = (process.env.TWITCH_CHANNEL || "r119_abdlull").replace(/^@/, "");
const twitchUrl = `https://www.twitch.tv/${twitchChannel}`;
const standbyVideoPath = path.join(require("os").tmpdir(), "live-control-media", "automatic-standby-video");
const standbyAudioPath = path.join(require("os").tmpdir(), "live-control-media", "waiting.mp3");
let standbyVideoUrl = "";
const restreamServer = (process.env.RESTREAM_RTMP_URL || "").trim();
const restreamKey = (process.env.RESTREAM_STREAM_KEY || "").trim();
const destinations = [];
const publisherPort = 20000 + (process.pid % 20000);
const publisherInput = `udp://127.0.0.1:${publisherPort}?fifo_size=65536&overrun_nonfatal=1`;
const producerOutput = `udp://127.0.0.1:${publisherPort}?pkt_size=1316`;


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

async function ensureStandbyAudio() {
  await fs.promises.mkdir(path.dirname(standbyAudioPath), { recursive: true });
  try {
    const cached = await fs.promises.stat(standbyAudioPath);
    if (cached.isFile() && cached.size > 0) {
      console.log("ملف موسيقى الانتظار موجود محليًا؛ سيتم استخدام النسخة المحفوظة.");
      return standbyAudioPath;
    }
  } catch {}

  const audioUrl = "https://basepic.com/9fDxWd82/Video-23-11-2026-07.25.mp3";
  const temporaryPath = standbyAudioPath + ".download";
  console.log("جارٍ تنزيل موسيقى الانتظار إلى ملف محلي...");
  const response = await fetch(audioUrl, {
    signal: AbortSignal.timeout(60000),
    headers: { "user-agent": "live-control-room/1.1" }
  });
  if (!response.ok || !response.body) {
    throw new Error("تعذّر تنزيل ملف الموسيقى؛ HTTP " + response.status);
  }

  try {
    await pipeline(
      Readable.fromWeb(response.body),
      fs.createWriteStream(temporaryPath)
    );
    const downloaded = await fs.promises.stat(temporaryPath);
    if (!downloaded.isFile() || downloaded.size === 0) {
      throw new Error("ملف الموسيقى الذي تم تنزيله فارغ.");
    }
    await fs.promises.rename(temporaryPath, standbyAudioPath);
    console.log("تم تنزيل موسيقى الانتظار وحفظها محليًا بنجاح.");
    return standbyAudioPath;
  } catch (error) {
    await fs.promises.rm(temporaryPath, { force: true }).catch(() => {});
    throw error;
  }
}
let stopping = false;
let publishTestRequested = false;
let manualStandbyRequested = false;
let resumeLiveRequested = false;
let manualStandbyMode = false;
let activeChildren = [];
let manualOverlayFile = null;
let overlayRevision = 0;

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
    overlayRevision++;
    console.log("تم طلب العودة إلى بث Twitch.");
  }
  if (message?.type === "overlay-start" && typeof message.filePath === "string") {
    manualStandbyMode = false;
    manualStandbyRequested = false;
    manualOverlayFile = message.filePath;
    overlayRevision++;
    console.log("تم طلب تشغيل الفيديو اليدوي:", path.basename(message.filePath));
  } else if (message?.type === "standby-url" && typeof message.url === "string") {
    standbyVideoUrl = message.url;
    console.log("تم تحديث رابط فيديو الانتظار التلقائي.");
  } else if (message?.type === "overlay-stop") {
    manualOverlayFile = null;
    overlayRevision++;
    console.log("تم طلب إيقاف الفيديو اليدوي.");
  }
});

let persistentPublisher = null;

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
  child.once("error", error => {
    console.error("تعذّر تشغيل اتصال Restream المستمر:", error.message);
    if (!stopping) shutdown();
  });
  child.once("close", code => {
    console.error("انتهى اتصال Restream المستمر برمز:", code);
    if (!stopping) shutdown();
  });
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

  const streamlink = spawn("streamlink", ["--stdout", twitchUrl, "best"], {
    stdio: ["ignore", "pipe", "pipe"]
  });

  const ffmpegArgs = [
    "-hide_banner",
    "-loglevel", "info",
    "-fflags", "+genpts",
    "-i", "pipe:0",
    "-f", "lavfi", "-i", "anullsrc=channel_layout=stereo:sample_rate=48000",
    "-map", "0:v:0?",
    "-map", "0:a:0?",
    "-map", "1:a:0",
    "-vf", "scale=1280:720:force_original_aspect_ratio=decrease,pad=1280:720:(ow-iw)/2:(oh-ih)/2,fps=30,format=yuv420p",
    "-c:v", "libx264", "-preset", "ultrafast", "-tune", "zerolatency", "-profile:v", "main",
    "-b:v", "1800k", "-maxrate", "1800k", "-bufsize", "3600k",
    "-g", "60", "-keyint_min", "60",
    "-c:a", "aac", "-b:a", "96k", "-ar", "48000",
    "-max_muxing_queue_size", "1024",
    "-mpegts_flags", "+resend_headers", "-muxdelay", "0", "-muxpreload", "0",
    "-f", "mpegts", producerOutput
  ];

  const ffmpeg = spawnFfmpeg(ffmpegArgs, ["pipe", "inherit", "pipe"]);

  activeChildren = [streamlink, ffmpeg];
  streamlink.stdout.pipe(ffmpeg.stdin);

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
    const finish = result => {
      if (settled) return;
      settled = true;
      if (overlayCheck) clearInterval(overlayCheck);
      stopChildren();
      resolve({ ...result, streamlinkError });
    };

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
    const probe = spawn("streamlink", ["--stream-url", twitchUrl, "best"], {
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
  const writeStatus = message => {
    try { fs.writeFileSync(textFile, message, "utf8"); }
    catch (error) { console.error("تعذّر تحديث نص حالة البث:", error.message); }
  };
  writeStatus(statusMessage);

  const statusFilter =
    "drawtext=fontfile=/usr/share/fonts/truetype/noto/NotoSansArabic-Regular.ttf" +
    ":textfile=" + textFile +
    ":reload=30:fontcolor=white:fontsize=52" +
    ":x=(w-text_w)/2:y=(h-text_h)/2" +
    ":box=1:boxcolor=0x5b1028@0.86:boxborderw=24:text_shaping=1";

  let nextProbeAt = 0;
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

    try {
      await ensureStandbyAudio();
    } catch (error) {
      console.error("تعذّر تجهيز موسيقى شاشة الانتظار:", error.message);
      await sleep(15000);
      continue;
    }

    const args = [
      "-hide_banner", "-loglevel", "info",
      "-re", "-f", "lavfi", "-i", "color=c=0x5b1028:s=1280x720:r=30",
      "-stream_loop", "-1", "-re", "-i", standbyAudioPath,
      "-map", "0:v:0", "-map", "1:a:0",
      "-vf", statusFilter,
      "-af", "volume=0.20"
    ];
    args.push(
      "-c:v", "libx264", "-preset", "ultrafast", "-tune", "zerolatency",
      "-b:v", "1500k", "-maxrate", "1500k", "-bufsize", "3000k",
      "-g", "60", "-keyint_min", "60",
      "-c:a", "aac", "-b:a", "96k", "-ar", "48000",
      "-mpegts_flags", "+resend_headers", "-muxdelay", "0", "-muxpreload", "0",
      "-f", "mpegts", producerOutput
    );

    console.log("بدء شاشة انتظار ثابتة مع موسيقى خلفية بمستوى 20%.");
    const standby = spawnFfmpeg(args, ["ignore", "inherit", "pipe"]);
    activeChildren = [standby];

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
      if (!manual && Date.now() >= nextProbeAt) {
        if (await checkTwitchAvailable()) {
          console.log("عادت إشارة Twitch؛ جارٍ التحويل من شاشة الانتظار إلى البث المباشر.");
          switchToLive = true;
          break;
        }
        writeStatus("إشارة البث ما زالت منقطعة\\nنواصل محاولة إعادة الاتصال تلقائيًا\\nتابعونا، وإذا رجعت الإشارة سيعود البث");
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
      "-vf", "scale=1280:720:force_original_aspect_ratio=decrease,pad=1280:720:(ow-iw)/2:(oh-ih)/2,fps=30,format=yuv420p",
      "-c:v", "libx264", "-preset", "ultrafast", "-tune", "zerolatency",
      "-pix_fmt", "yuv420p", "-b:v", "1800k", "-maxrate", "1800k", "-bufsize", "3600k",
      "-g", "60", "-keyint_min", "60",
      "-c:a", "aac", "-b:a", "96k", "-ar", "48000",
      "-max_muxing_queue_size", "1024",
      "-mpegts_flags", "+resend_headers", "-muxdelay", "0", "-muxpreload", "0",
      "-f", "mpegts", producerOutput
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
  if (persistentPublisher && !persistentPublisher.killed) persistentPublisher.kill("SIGTERM");
}

process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);

main().catch(error => {
  console.error("خطأ في عامل إعادة البث:", error?.message || error);
  shutdown();
  process.exitCode = 1;
});
