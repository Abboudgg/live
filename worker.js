const { spawn } = require("child_process");

const twitchChannel = process.env.TWITCH_CHANNEL || "r119_abdlull";
const twitchUrl = `https://www.twitch.tv/${twitchChannel}`;
const destinations = [
  process.env.KICK_RTMP_URL,
  process.env.TIKTOK_RTMP_URL
].filter(Boolean);

if (destinations.length === 0) {
  console.error("Set KICK_RTMP_URL and/or TIKTOK_RTMP_URL as secret environment variables.");
  process.exit(1);
}

const missing = [];
if (!process.env.KICK_RTMP_URL) missing.push("KICK_RTMP_URL");
if (!process.env.TIKTOK_RTMP_URL) missing.push("TIKTOK_RTMP_URL");
if (missing.length) {
  console.warn("One destination is not configured:", missing.join(", "));
}

console.log("Starting authorized Twitch restream:", twitchUrl);
console.log("Configured RTMP destinations:", destinations.length);

const streamlink = spawn("streamlink", ["--stdout", twitchUrl, "best"], {
  stdio: ["ignore", "pipe", "inherit"]
});

const teeTargets = destinations.map(url => `[f=flv]${url}`).join("|");
const ffmpegArgs = [
  "-hide_banner",
  "-loglevel", "warning",
  "-i", "pipe:0",
  "-map", "0:v:0?",
  "-map", "0:a:0?",
  "-c", "copy",
  "-f", "tee",
  teeTargets
];

const ffmpeg = spawn("ffmpeg", ffmpegArgs, {
  stdio: ["pipe", "inherit", "inherit"]
});

streamlink.stdout.pipe(ffmpeg.stdin);

let stopping = false;
function stop(code = 0) {
  if (stopping) return;
  stopping = true;
  streamlink.kill("SIGTERM");
  ffmpeg.kill("SIGTERM");
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
