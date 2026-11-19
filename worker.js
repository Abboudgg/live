const { spawn } = require("child_process");

const twitchChannel = (process.env.TWITCH_CHANNEL || "r119_abdlull").replace(/^@/, "");
const twitchUrl = `https://www.twitch.tv/${twitchChannel}`;
const destinations = [
  ["Kick", process.env.KICK_RTMP_URL],
  ["TikTok", process.env.TIKTOK_RTMP_URL]
].filter(([, url]) => Boolean(url));

if (destinations.length === 0) {
  console.error("Set KICK_RTMP_URL and/or TIKTOK_RTMP_URL as secret environment variables.");
  process.exit(1);
}

for (const name of ["Kick", "TikTok"]) {
  if (!destinations.some(([destination]) => destination === name)) {
    console.warn(name + " RTMP destination is not configured.");
  }
}

console.log("Starting Twitch restream:", twitchUrl);
console.log("Configured destinations:", destinations.map(([name]) => name).join(", "));

const streamlink = spawn("streamlink", ["--stdout", twitchUrl, "best"], {
  stdio: ["ignore", "pipe", "inherit"]
});

const teeTargets = destinations
  .map(([, url]) => `[f=flv:onfail=ignore]${url}`)
  .join("|");

const ffmpegArgs = [
  "-hide_banner",
  "-loglevel", "info",
  "-fflags", "+genpts",
  "-i", "pipe:0",
  "-map", "0:v:0?",
  "-map", "0:a:0?",
  "-c:v", "libx264",
  "-preset", "veryfast",
  "-tune", "zerolatency",
  "-pix_fmt", "yuv420p",
  "-profile:v", "high",
  "-r", "30",
  "-g", "60",
  "-keyint_min", "60",
  "-b:v", "4500k",
  "-maxrate", "4500k",
  "-bufsize", "9000k",
  "-c:a", "aac",
  "-b:a", "160k",
  "-ac", "2",
  "-ar", "44100",
  "-max_muxing_queue_size", "1024",
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
