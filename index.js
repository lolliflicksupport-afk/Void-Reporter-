import fs from "fs";
import path from "path";
import http from "http";
import fetch from "node-fetch";

process.on("uncaughtException", (e) => {
  console.error("[BOOT CRASH uncaughtException]", e.message);
  console.error(e.stack);
  process.exit(1);
});
process.on("unhandledRejection", (e) => {
  console.error("[BOOT CRASH unhandledRejection]", e?.message || e);
  console.error(e?.stack || "");
});

// file logging
const logStream = fs.createWriteStream("bot.log", { flags: "a" });
const _origLog = console.log.bind(console);
const _origErr = console.error.bind(console);
console.log = (...args) => {
  const line = args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" ");
  _origLog(line);
  try { logStream.write(line + "\n"); } catch (_) {}
};
console.error = (...args) => {
  const line = args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" ");
  _origErr(line);
  try { logStream.write("[ERR] " + line + "\n"); } catch (_) {}
};

const PORT = process.env.PORT || 10000;
const server = http.createServer((req, res) => {
  if (req.url === "/" || req.url === "/health") {
    res.writeHead(200, { "Content-Type": "text/plain" });
    res.end("void reporter online");
    return;
  }
  if (req.url === "/log" || req.url.startsWith("/log?")) {
    try {
      const raw = fs.readFileSync("bot.log", "utf8");
      const n = parseInt((req.url.match(/lines=(\d+)/) || [])[1] || "200", 10);
      res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" });
      res.end(raw.split("\n").slice(-n).join("\n"));
    } catch (e) { res.writeHead(200); res.end("no log: " + e.message); }
    return;
  }
  res.writeHead(404); res.end("not found");
});
server.listen(PORT, () => console.log(`[ok] http shim listening on ${PORT}`));

const BOT_NAME = "void reporter";

try {
  const pkg = await import("telegraf");
  const { InputFile } = pkg.default;

  const { bot } = await import("./bot.js");
  const { CFG } = await import("./config.js");
  const { initUserWaClients } = await import("./whatsapp.js");
  const { log } = await import("./logger.js");

  log.banner();
  if (!CFG.apiId || !CFG.apiHash || !CFG.botToken) {
    log.err("missing .env vars вЂ” API_ID / API_HASH / BOT_TOKEN");
    process.exit(1);
  }
  log.info(`bot: ${BOT_NAME}`);
  log.info(`tg sessions: ${CFG.tgSessions.length}`);
  log.info(`owners: ${[...CFG.ownerIds].join(", ") || "none"}`);

  initUserWaClients().catch((e) => log.err(`wa: ${e.message}`));

  bot.launch().then(async () => {
    log.rat(`${BOT_NAME} live вЂ” whiskers forward`);
    try {
      await bot.telegram.callApi("setMyName", { name: BOT_NAME });
    } catch (_) {}
  }).catch((e) => {
    log.err(`bot.launch failed: ${e.message}`);
  });
} catch (e) {
  console.error("[BOOT CRASH import]", e.message);
  console.error(e.stack);
  process.exit(1);
}

process.once("SIGINT", () => process.exit(0));
process.once("SIGTERM", () => process.exit(0));
