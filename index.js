import fs from "fs";
import path from "path";
import http from "http";
import net from "net";
import fetch from "node-fetch";

import pkg from "telegraf";
const { InputFile } = pkg;

import { bot } from "./bot.js";
import { CFG } from "./config.js";
import { initUserWaClients } from "./whatsapp.js";
import { log } from "./logger.js";

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
process.on("uncaughtException", (e) => console.error(`uncaughtException: ${e.message}\n${e.stack || ""}`));
process.on("unhandledRejection", (e) => console.error(`unhandledRejection: ${e?.message || e}`));

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
      const lines = raw.split("\n").slice(-n).join("\n");
      res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" });
      res.end(lines);
    } catch (e) {
      res.writeHead(200);
      res.end("no log yet: " + e.message);
    }
    return;
  }

  if (req.url === "/debug-modules") {
    try {
      const base = path.join(process.cwd(), "node_modules/telegram");
      const found = {};
      const walk = (dir, depth = 0) => {
        if (depth > 4) return;
        try {
          for (const item of fs.readdirSync(dir)) {
            const full = path.join(dir, item);
            try {
              const stat = fs.statSync(full);
              if (stat.isDirectory()) walk(full, depth + 1);
              else if (/obfusc|connection/i.test(item)) found[full.replace(process.cwd() + "/", "")] = stat.size;
            } catch (_) {}
          }
        } catch (_) {}
      };
      walk(base);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(found, null, 2));
    } catch (e) {
      res.writeHead(200);
      res.end("err: " + e.message);
    }
    return;
  }

  if (req.url === "/test-tg") {
    (async () => {
      res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" });
      res.write("testing telegram direct...\n\n");
      try {
        const { TelegramClient } = await import("telegram");
        const { StringSession } = await import("telegram/sessions/index.js");

        if (!CFG.tgSessions.length) {
          res.end("no tg sessions configured");
          return;
        }

        const s = CFG.tgSessions[0];
        res.write(`session: ${s.name}\n`);
        res.write(`session length: ${s.session.length}\n\n`);
        res.write("=== test: direct (no proxy) ===\n");

        try {
          const c = new TelegramClient(new StringSession(s.session), CFG.apiId, CFG.apiHash, {
            connectionRetries: 1,
            timeout: 30,
            useIPV6: false,
          });
          await Promise.race([
            c.connect(),
            new Promise((_, r) => setTimeout(() => r(new Error("timeout:30s")), 30000)),
          ]);
          const authorized = await c.isUserAuthorized();
          res.write(`connected OK. authorized=${authorized}\n`);
          try { await c.disconnect(); } catch (_) {}
        } catch (e) {
          res.write(`FAILED: ${e.message}\n`);
        }
      } catch (e) {
        res.write(`\nFATAL: ${e.message}\n`);
      }
      res.end();
    })();
    return;
  }

  res.writeHead(404);
  res.end("not found");
});

server.listen(PORT, () => log.ok(`http shim listening on port ${PORT}`));

const BOT_NAME = "void reporter";
const BOT_DESCRIPTION = "🕯️ silence the target. mass report engine вЂ” telegram В· whatsapp В· tiktok.";
const BOT_SHORT = "🕯️ void reporter";

log.banner();
if (!CFG.apiId || !CFG.apiHash || !CFG.botToken) {
  log.err("missing .env vars вЂ” API_ID / API_HASH / BOT_TOKEN");
  process.exit(1);
}

log.info(`bot: ${BOT_NAME}`);
log.info(`concurrency: ${CFG.defaultConcurrency}  wave: ${CFG.defaultWaveSize}  cooldown: ${CFG.defaultWaveCooldown}s`);
log.info(`tg sessions: ${CFG.tgSessions.length}`);
log.info(`tiktok proxies: ${CFG.tiktokProxies.length}`);
log.info(`owners: ${[...CFG.ownerIds].join(", ") || "none"}`);
log.info(`rate limit: ${CFG.jobsPerHour}/hour per user`);

initUserWaClients().catch((e) => log.err(`wa init: ${e.message}`));

async function setBotIdentity() {
  try {
    await bot.telegram.callApi("setMyName", { name: BOT_NAME });
    await bot.telegram.callApi("setMyDescription", { description: BOT_DESCRIPTION });
    await bot.telegram.callApi("setMyShortDescription", { short_description: BOT_SHORT });
    log.ok("bot identity set");
  } catch (e) { log.warn(`identity set failed: ${e.message}`); }
}

async function setBotPhoto() {
  if (!CFG.botImageUrl) return;
  try {
    const res = await fetch(CFG.botImageUrl);
    if (!res.ok) throw new Error(`http_${res.status}`);
    const contentType = res.headers.get("content-type") || "";
    if (!contentType.startsWith("image/")) throw new Error(`not_image`);
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length > 10 * 1024 * 1024) throw new Error("too_large");
    const tmp = path.join(process.cwd(), "data", "bot-photo.jpg");
    if (!fs.existsSync(path.dirname(tmp))) fs.mkdirSync(path.dirname(tmp), { recursive: true });
    fs.writeFileSync(tmp, buf);
    await bot.telegram.callApi("setProfilePhoto", { photo: new InputFile(tmp) });
    log.ok("bot photo updated");
  } catch (e) { log.warn(`photo failed: ${e.message}`); }
}

bot.launch().then(async () => {
  log.rat(`${BOT_NAME} live вЂ” whiskers forward`);
  await setBotIdentity();
  await setBotPhoto();
});

process.once("SIGINT", () => bot.stop("SIGINT"));
process.once("SIGTERM", () => bot.stop("SIGTERM"));
