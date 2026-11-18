const express = require("express");
const path = require("path");

const app = express();
const PORT = process.env.PORT || 3000;

app.disable("x-powered-by");
app.use(express.static(path.join(__dirname, "public")));

app.get("/health", (_req, res) => {
  res.json({ ok: true, service: "live-multi-chat" });
});

app.get("/config", (_req, res) => {
  res.json({
    twitchChannel: process.env.TWITCH_CHANNEL || "r119_abdlull",
    kickUsername: process.env.KICK_USERNAME || "cass-sa",
    tiktokUsername: process.env.TIKTOK_USERNAME || "cass_ksa_"
  });
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`Web dashboard listening on port ${PORT}`);
});
