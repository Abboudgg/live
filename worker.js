const { spawn } = require("child_process");

const twitchChannel = (process.env.TWITCH_CHANNEL || "r119_abdlull").replace(/^@/, "");
const twitchUrl = `https://www.twitch.tv/${twitchChannel}`;
const restreamServer = (process.env.RESTREAM_RTMP_URL || "").trim();
const restreamKey = (process.env.RESTREAM_STREAM_KEY || "").trim();
const destinations = [];

if (restreamServer && restreamKey) {
  const server = restreamServer.replace(/\\/+$/, "");
  const key = restreamKey.replace(/^\\/+/, "");
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
      console.log("Twitch stream is offline. Restream worker will stop.");
      process.exitCode = 0;
      break;
    }

    console.warn("Stream connection ended unexpectedly. Retrying in 5 seconds...");
    await sleep(5000);
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
