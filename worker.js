const { spawn } = require("child_process");

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

console.log("Starting Twitch restream:", twitchUrl);
console.log("Configured destinations:", destinations.map(([name]) => name).join(", "));

const streamlink = spawn("streamlink", ["--stdout", twitchUrl, "best"], {
  stdio: ["ignore", "pipe", "inherit"]
});

const ffmpegArgs = [
  "-hide_banner",
  "-loglevel", "info",
  "-fflags", "+genpts",
  "-i", "pipe:0",
  "-map", "0:v:0?",
  "-map", "0:a:0?",
  // Copy Twitch's H.264/AAC streams without re-encoding to reduce CPU use on Render Free.
  "-c:v", "copy",
  "-c:a", "copy",
  "-max_muxing_queue_size", "1024"
];

if (destinations.length === 1) {
  // Send FLV directly to the RTMP endpoint; bypass the FIFO recovery layer for diagnosis.
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

streamlink.stdout.pipe(ffmpeg.stdin);

let stopping = false;
function stop(code = 0) {
  if (stopping) return;
  stopping = true;
  if (!streamlink.killed) streamlink.kill("SIGTERM");
  if (!ffmpeg.killed) ffmpeg.kill("SIGTERM");
  process.exitCode = code;
}

streamlink.on("error", err => {
  console.error("Could not start Streamlink:", err.message);
  stop(1);
});
ffmpeg.on("error", err => {
  console.error("Could not start FFmpeg:", err.message);
  stop(1);
});

// FFmpeg can close its input during an RTMP failure; handle EPIPE without crashing Node.
ffmpeg.stdin.on("error", err => {
  if (err.code !== "EPIPE") console.error("FFmpeg input pipe error:", err.message);
});

streamlink.on("close", code => {
  if (!stopping) {
    console.error("Streamlink ended with code:", code);
    stop(code || 1);
  }
});
ffmpeg.on("close", code => {
  if (!stopping) {
    console.error("FFmpeg ended with code:", code);
    stop(code || 1);
  }
});
process.on("SIGTERM", () => stop(0));
process.on("SIGINT", () => stop(0));
