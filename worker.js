const { spawn } = require("child_process");
const fs = require("fs");
const path = require("path");

const twitchChannel = (process.env.TWITCH_CHANNEL || "r119_abdlull").replace(/^@/, "");
const twitchUrl = `https://www.twitch.tv/${twitchChannel}`;
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
    const finish = result => {
      if (settled) return;
      settled = true;
      stopChildren();
      resolve({ ...result, streamlinkError });
    };

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

async function runStandbyUntilLive() {
  console.log("Showing the maroon waiting screen until Twitch returns.");
  const textFile = path.join(__dirname, "waiting.txt");
  const args = [
    "-hide_banner", "-loglevel", "warning",
    "-re", "-f", "lavfi", "-i", "color=c=0x5b1028:s=1280x720:r=30",
    "-re", "-f", "lavfi", "-i", "anullsrc=channel_layout=stereo:sample_rate=44100",
    "-vf", `drawtext=fontfile=/usr/share/fonts/truetype/noto/NotoSansArabic-Regular.ttf:textfile=${textFile}:fontcolor=white:fontsize=76:x=(w-text_w)/2:y=(h-text_h)/2:text_shaping=1`,
    "-c:v", "libx264", "-preset", "ultrafast", "-tune", "zerolatency",
    "-b:v", "1200k", "-maxrate", "1200k", "-bufsize", "2400k",
    "-g", "60", "-keyint_min", "60",
    "-c:a", "aac", "-b:a", "128k", "-ar", "44100",
    "-f", "flv", destinations[0][1]
  ];
  const standby = spawn("ffmpeg", args, { stdio: ["ignore", "inherit", "inherit"] });
  activeChildren = [standby];

  const ended = new Promise(resolve => {
    standby.once("error", error => {
      console.error("Waiting screen FFmpeg error:", error.message);
      resolve("ended");
    });
    standby.once("close", code => {
      console.log("Waiting screen ended with code:", code);
      resolve("ended");
    });
  });

  while (!stopping) {
    const next = await Promise.race([
      sleep(15000).then(() => "probe"),
      ended
    ]);
    if (next === "ended" || stopping) break;

    if (await checkTwitchAvailable()) {
      console.log("Twitch is back. Switching from waiting screen to live stream.");
      break;
    }
    console.log("Twitch is still unavailable; keeping the waiting screen live.");
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
      "-c:v", "libx264", "-preset", "veryfast", "-tune", "zerolatency",
      "-pix_fmt", "yuv420p", "-b:v", "2500k", "-maxrate", "2500k", "-bufsize", "5000k",
      "-g", "60", "-keyint_min", "60",
      "-c:a", "aac", "-b:a", "128k", "-ar", "44100",
      "-f", "flv", destinations[0][1]
    ];
    const overlay = spawn("ffmpeg", args, { stdio: ["ignore", "inherit", "inherit"] });
    activeChildren = [overlay];
    await new Promise(resolve => {
      overlay.once("error", error => {
        console.error("Manual video FFmpeg error:", error.message);
        resolve();
      });
      overlay.once("close", code => {
        console.log("Manual video FFmpeg ended with code:", code);
        resolve();
      });
      const check = setInterval(() => {
        if (stopping || !manualOverlayFile) {
          clearInterval(check);
          if (!overlay.killed) overlay.kill("SIGTERM");
        }
      }, 250);
      overlay.once("close", () => clearInterval(check));
    });
    activeChildren = [];
    if (manualOverlayFile === filePath && !stopping) {
      console.warn("Manual video encoder stopped unexpectedly; retrying in 3 seconds.");
      await sleep(3000);
    }
  }
  console.log("Manual video mode ended; returning to Twitch live stream.");
}

async function main() {
  while (!stopping) {
    const result = await runAttempt();
    if (stopping) break;

    const message = result.streamlinkError.toLowerCase();
    const twitchOffline =
      result.source === "streamlink" &&
      (
        message.includes("no playable streams found") ||
        message.includes("is offline") ||
        message.includes("stream is offline") ||
        message.includes("no streams found")
      );

    if (twitchOffline) {
      console.log("Twitch stream is offline.");
    } else {
      console.warn("Stream connection ended unexpectedly.");
    }

    await runStandbyUntilLive();
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
