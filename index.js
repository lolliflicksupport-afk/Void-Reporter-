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

// ===============================================================
// FILE LOGGING вЂ” mirrors all console output to bot.log
// ===============================================================
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

// ===============================================================
// HTTP SHIM вЂ” keeps Render alive + /log endpoint + /test endpoint
// ===============================================================
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

  if (req.url === "/test-tg") {
    (async () => {
      res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" });
      res.write("testing telegram direct + proxies...\n\n");
      try {
        const { TelegramClient } = await import("telegram");
        const { StringSession } = await import("telegram/sessions/index.js");

        if (!CFG.tgSessions.length) {
          res.end("no tg sessions configured");
          return;
        }

        const s = CFG.tgSessions[0];
        res.write(`session: ${s.name}\n`);
        res.write(`proxyList: ${JSON.stringify(s.proxyList || [])}\n\n`);

        // test direct
        res.write("=== test 1: direct (no proxy) ===\n");
        try {
          const c = new TelegramClient(new StringSession(s.session), CFG.apiId, CFG.apiHash, {
            connectionRetries: 1,
            useWSS: true,
            timeout: 15,
          });
          await Promise.race([
            c.connect(),
            new Promise((_, r) => setTimeout(() => r(new Error("timeout:15s")), 15000)),
          ]);
          res.write("DIRECT: connected OK\n");
          try { await c.disconnect(); } catch (_) {}
        } catch (e) {
          res.write(`DIRECT: FAILED ${e.message}\n`);
        }

        // test each proxy
        const list = s.proxyList?.length ? s.proxyList : (s.proxy ? [s.proxy] : []);
        for (let i = 0; i < list.length; i++) {
          const p = list[i];
          res.write(`\n=== test proxy ${i + 1}: ${p.host}:${p.port} ===\n`);
          try {
            const { SocksProxyAgent } = await import("socks-proxy-agent");
            const { HttpsProxyAgent } = await import("https-proxy-agent");
            const url = `${p.scheme || "socks5"}://${p.username ? `${p.username}:${p.password}@` : ""}${p.host}:${p.port}`;
            const agent = url.startsWith("socks") ? new SocksProxyAgent(url) : new HttpsProxyAgent(url);

            const c = new TelegramClient(new StringSession(s.session), CFG.apiId, CFG.apiHash, {
              connectionRetries: 1,
              useWSS: true,
              timeout: 15,
              proxy: agent,
            });
            await Promise.race([
              c.connect(),
              new Promise((_, r) => setTimeout(() => r(new Error("timeout:15s")), 15000)),
            ]);
            res.write(`PROXY ${i + 1}: connected OK\n`);
            try { await c.disconnect(); } catch (_) {}
          } catch (e) {
            res.write(`PROXY ${i + 1}: FAILED ${e.message}\n`);
          }
        }
      } catch (e) {
        res.write(`\nFATAL: ${e.message}\n${e.stack || ""}\n`);
      }
      res.end();
    })();
    return;
  }

  res.writeHead(404);
  res.end("not found");
});

server.listen(PORT, () => log.ok(`http shim listening on port ${PORT}`));

// ===============================================================
// PROXY REACHABILITY TEST вЂ” runs at boot
// ===============================================================
async function runProxyTests() {
  const all = [];

  let i = 1;
  while (true) {
    const p = process.env[`TG_PROXY_${i}`];
    if (!p) break;
    all.push({ label: `TG_PROXY_${i}`, url: p });
    i++;
  }

  const ttProxies = (process.env.TIKTOK_PROXIES || "").split(",").map((x) => x.trim()).filter(Boolean);
  for (let j = 0; j < ttProxies.length; j++) all.push({ label: `TIKTOK_${j + 1}`, url: ttProxies[j] });

  if (all.length === 0) { log.info("[proxytest] none configured"); return; }

  log.info(`[proxytest] testing ${all.length} proxies...`);

  const results = await Promise.all(all.map(async ({ label, url }) => {
    let host, port;
    try {
      const u = new URL(url);
      host = u.hostname;
      port = parseInt(u.port, 10);
    } catch {
      log.warn(`[proxytest] ${label}: bad url`);
      return false;
    }
    return new Promise((resolve) => {
      const s = net.createConnection({ host, port, timeout: 5000 });
      s.on("connect", () => { log.ok(`[proxytest] ${label} ${host}:${port} OPEN`); s.destroy(); resolve(true); });
      s.on("timeout", () => { log.warn(`[proxytest] ${label} ${host}:${port} TIMEOUT`); s.destroy(); resolve(false); });
      s.on("error", (e) => { log.err(`[proxytest] ${label} ${host}:${port} ${e.code || e.message}`); s.destroy(); resolve(false); });
    });
  }));

  const open = results.filter(Boolean).length;
  log.info(`[proxytest] ${open}/${all.length} proxies reachable`);
}

// ===============================================================
// BOT BOOT
// ===============================================================
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
  runProxyTests().catch((e) => log.err(`proxytest crash: ${e.message}`));
  await setBotIdentity();
  await setBotPhoto();
});

process.once("SIGINT", () => bot.stop("SIGINT"));
process.once("SIGTERM", () => bot.stop("SIGTERM"));
