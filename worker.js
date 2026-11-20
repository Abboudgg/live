const { spawn } = require("child_process");
const fs = require("fs");
const path = require("path");

const twitchChannel = (process.env.TWITCH_CHANNEL || "r119_abdlull").replace(/^@/, "");
const twitchUrl = `https://www.twitch.tv/${twitchChannel}`;
const standbyVideoPath = path.join(require("os").tmpdir(), "live-control-media", "automatic-standby-video");
const restreamServer = (process.env.RESTREAM_RTMP_URL || "").trim();
const restreamKey = (process.env.RESTREAM_STREAM_KEY || "").trim();
const destinations = [];

if (restreamServer && restreamKey) {
  const server = restreamServer.replace(/\/+$/, "");
  const key = restreamKey.replace(/^\/+/, "");
  destinations.push(["Restream", server + "/" + key]);
} else {
  if (restreamServer || restreamKey) {
    console.warn("Restream is only partially configured. Set both RESTREAM_RTMP_URL and RESTREAM_STREAM_KEY.");
  }
  destinations.push(
    ["Kick", process.env.KICK_RTMP_URL],
    ["TikTok", process.env.TIKTOK_RTMP_URL]
  );
}

const configuredDestinations = destinations.filter(([, url]) => Boolean(url));
destinations.length = 0;
destinations.push(...configuredDestinations);

if (destinations.length === 0) {
  console.error("Set RESTREAM_RTMP_URL and RESTREAM_STREAM_KEY, or configure a direct RTMP destination.");
  process.exit(1);
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
let stopping = false;
let activeChildren = [];
let manualOverlayFile = null;
let overlayRevision = 0;

process.on("message", message => {
  if (message?.type === "overlay-start" && typeof message.filePath === "string") {
    manualOverlayFile = message.filePath;
    overlayRevision++;
    console.log("Manual video overlay requested:", path.basename(message.filePath));
  } else if (message?.type === "overlay-stop") {
    manualOverlayFile = null;
    overlayRevision++;
    console.log("Manual video overlay stop requested.");
  }
});

function stopChildren() {
  for (const child of activeChildren) {
    if (child && !child.killed) child.kill("SIGTERM");
  }
  activeChildren = [];
}

async function runAttempt() {
  console.log("Starting Twitch restream:", twitchUrl);
  console.log("Configured destinations:", destinations.map(([name]) => name).join(", "));

  const streamlink = spawn("streamlink", ["--stdout", twitchUrl, "best"], {
    stdio: ["ignore", "pipe", "pipe"]
  });

  const ffmpegArgs = [
    "-hide_banner",
    "-loglevel", "info",
    "-fflags", "+genpts",
    "-i", "pipe:0",
    "-map", "0:v:0?",
    "-map", "0:a:0?",
    "-c:v", "copy",
    "-c:a", "copy",
    "-max_muxing_queue_size", "1024"
  ];

  if (destinations.length === 1) {
    ffmpegArgs.push("-f", "flv", destinations[0][1]);
  } else {
    const teeTargets = destinations
      .map(([, url]) => `[f=flv:onfail=ignore]${url}`)
      .join("|");
    ffmpegArgs.push("-f", "tee", teeTargets);
  }

  const ffmpeg = spawn("ffmpeg", ffmpegArgs, {
    stdio: ["pipe", "inherit", "inherit"]
  });

  activeChildren = [streamlink, ffmpeg];
  streamlink.stdout.pipe(ffmpeg.stdin);

  let streamlinkError = "";
  streamlink.stderr.on("data", chunk => {
    const line = chunk.toString();
    process.stderr.write(line);
    streamlinkError = (streamlinkError + line).slice(-12000);
  });

  ffmpeg.stdin.on("error", error => {
    if (error.code !== "EPIPE") console.error("FFmpeg input pipe error:", error.message);
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
        console.log("Switching from Twitch to manual video.");
        finish({ source: "overlay", code: 0 });
      }
    }, 250);

    streamlink.on("error", error => {
      console.error("Could not start Streamlink:", error.message);
      finish({ source: "streamlink", code: 1 });
    });

    ffmpeg.on("error", error => {
      console.error("Could not start FFmpeg:", error.message);
      finish({ source: "ffmpeg", code: 1 });
    });

    streamlink.on("close", code => {
      console.log("Streamlink ended with code:", code);
      finish({ source: "streamlink", code });
    });

    ffmpeg.on("close", code => {
      console.error("FFmpeg ended with code:", code);
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

async function runStandbyUntilLive(statusMessage = "انقطعت إشارة البث\nنحاول إعادة الاتصال تلقائيًا\nإذا رجعت الإشارة سيعود البث مباشرة") {
  console.log("Showing the broadcast status screen until Twitch returns.");
  const textFile = path.join(__dirname, "waiting.txt");
  const writeStatus = message => {
    try { fs.writeFileSync(textFile, message, "utf8"); }
    catch (error) { console.error("Could not update broadcast status text:", error.message); }
  };
  writeStatus(statusMessage);

  const hasStandbyVideo = fs.existsSync(standbyVideoPath);
  const statusFilter =
    "drawtext=fontfile=/usr/share/fonts/truetype/noto/NotoSansArabic-Regular.ttf" +
    ":textfile=" + textFile +
    ":reload=30:fontcolor=white:fontsize=52" +
    ":x=(w-text_w)/2:y=(h-text_h)/2" +
    ":box=1:boxcolor=0x5b1028@0.86:boxborderw=24:text_shaping=1";

  const args = ["-hide_banner", "-loglevel", "warning"];
  if (hasStandbyVideo) {
    console.log("Playing automatic standby video in loop with broadcast status text:", path.basename(standbyVideoPath));
    args.push(
      "-stream_loop", "-1", "-re", "-i", standbyVideoPath,
      "-map", "0:v:0", "-map", "0:a:0?",
      "-vf", "scale=1280:720:force_original_aspect_ratio=decrease,pad=1280:720:(ow-iw)/2:(oh-ih)/2,fps=30,format=yuv420p," + statusFilter
    );
  } else {
    console.log("No automatic standby video uploaded; using the status screen.");
    args.push(
      "-re", "-f", "lavfi", "-i", "color=c=0x5b1028:s=1280x720:r=30",
      "-re", "-f", "lavfi", "-i", "anullsrc=channel_layout=stereo:sample_rate=44100",
      "-vf", statusFilter
    );
  }
  args.push(
    "-c:v", "libx264", "-preset", "ultrafast", "-tune", "zerolatency",
    "-b:v", "1500k", "-maxrate", "1500k", "-bufsize", "3000k",
    "-g", "60", "-keyint_min", "60",
    "-c:a", "aac", "-b:a", "96k", "-ar", "44100",
    "-f", "flv", destinations[0][1]
  );

  const standby = spawn("ffmpeg", args, { stdio: ["ignore", "inherit", "inherit"] });
  activeChildren = [standby];

  const ended = new Promise(resolve => {
    standby.once("error", error => {
      console.error("Broadcast status FFmpeg error:", error.message);
      resolve("ended");
    });
    standby.once("close", code => {
      console.log("Broadcast status screen ended with code:", code);
      resolve("ended");
    });
  });

  let nextProbeAt = Date.now() + 15000;
  while (!stopping) {
    if (manualOverlayFile) {
      console.log("Manual video requested during status screen; switching to it.");
      break;
    }
    const next = await Promise.race([
      sleep(250).then(() => "check"),
      ended
    ]);
    if (next === "ended" || stopping) break;
    if (manualOverlayFile) continue;

    if (Date.now() >= nextProbeAt) {
      if (await checkTwitchAvailable()) {
        console.log("Twitch is back. Switching from status screen to live stream.");
        break;
      }
      writeStatus("إشارة البث ما زالت منقطعة\nنواصل محاولة إعادة الاتصال تلقائيًا\nتابعونا، وإذا رجعت الإشارة سيعود البث");
      console.log("Twitch is still unavailable; keeping the broadcast status screen live.");
      nextProbeAt = Date.now() + 15000;
    }
  }

  if (!standby.killed) standby.kill("SIGTERM");
  await Promise.race([ended, sleep(3000)]);
  activeChildren = [];
}

async function runManualOverlayUntilStopped() {
  while (!stopping && manualOverlayFile) {
    const filePath = manualOverlayFile;
    if (!fs.existsSync(filePath)) {
      console.error("Manual video file disappeared:", filePath);
      manualOverlayFile = null;
      break;
    }
    console.log("Playing manual video in loop:", path.basename(filePath));
    const args = [
      "-hide_banner", "-loglevel", "warning",
      "-stream_loop", "-1", "-re", "-i", filePath,
      "-map", "0:v:0", "-map", "0:a:0?",
      "-vf", "scale=1280:720:force_original_aspect_ratio=decrease,pad=1280:720:(ow-iw)/2:(oh-ih)/2,fps=30,format=yuv420p",
      "-c:v", "libx264", "-preset", "ultrafast", "-tune", "zerolatency",
      "-pix_fmt", "yuv420p", "-b:v", "1800k", "-maxrate", "1800k", "-bufsize", "3600k",
      "-g", "60", "-keyint_min", "60",
      "-c:a", "aac", "-b:a", "96k", "-ar", "44100",
      "-max_muxing_queue_size", "1024",
      "-f", "flv", destinations[0][1]
    ];
    const overlay = spawn("ffmpeg", args, { stdio: ["ignore", "inherit", "inherit"] });
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
        console.error("Manual video FFmpeg error:", error.message);
        finish();
      });
      overlay.once("close", code => {
        console.log("Manual video FFmpeg ended with code:", code);
        finish();
      });
      const check = setInterval(() => {
        if (stopping || !manualOverlayFile || manualOverlayFile !== filePath) {
          if (!overlay.killed) overlay.kill("SIGTERM");
          finish();
        }
      }, 250);
    });
    activeChildren = [];
    if (manualOverlayFile === filePath && !stopping) {
      console.warn("Manual video encoder stopped unexpectedly; retrying in 5 seconds.");
      await sleep(5000);
    }
  }
  console.log("Manual video mode ended; returning to Twitch live stream.");
}

async function main() {
  while (!stopping) {
    if (manualOverlayFile) {
      await runManualOverlayUntilStopped();
      continue;
    }

    const result = await runAttempt();
    if (stopping) break;

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
      console.log("Twitch stream is offline.");
      statusMessage = "قناة البث غير مباشرة حاليًا\nننتظر عودتها ونحاول الاتصال تلقائيًا\nإذا رجعت الإشارة سيعود البث مباشرة";
    } else if (result.source === "ffmpeg") {
      console.warn("RTMP/FFmpeg connection ended unexpectedly.");
      statusMessage = "انقطع الاتصال بخادم البث\nنحاول إعادة الاتصال تلقائيًا\nإذا استقر الاتصال سيعود البث مباشرة";
    } else {
      console.warn("Twitch stream connection ended unexpectedly.");
      statusMessage = "انقطعت إشارة Twitch\nنحاول إعادة الاتصال تلقائيًا\nإذا رجعت الإشارة سيعود البث مباشرة";
    }

    await runStandbyUntilLive(statusMessage);
  }
}

function shutdown() {
  if (stopping) return;
  stopping = true;
  stopChildren();
}

process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);

main().catch(error => {
  console.error("Restream worker error:", error?.message || error);
  shutdown();
  process.exitCode = 1;
});
