import fs from "fs";
import makeWASocket, {
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
} from "@whiskeysockets/baileys";
import pino from "pino";
import qrcode from "qrcode-terminal";
import { log } from "./logger.js";
import { withLock, sleep, rand } from "./state.js";

const CLIENTS = new Map();
let rrIndex = 0;

const WA_REASON = { spam: "spam", abuse: "abuse", scam: "scam", impersonation: "impersonation", other: "other" };

async function initOne(dirName, userId, { authMode = false, onQR = null, onReady = null, onError = null } = {}) {
  const { state, saveCreds } = await useMultiFileAuthState(dirName);
  const { version } = await fetchLatestBaileysVersion();

  const entry = { sock: null, ready: false, ok: 0, fail: 0, lastStatus: "init", busy: false, dirName, userId };
  CLIENTS.set(dirName, entry);

  const sock = makeWASocket({
    version, auth: state, printQRInTerminal: false,
    logger: pino({ level: "silent" }),
    browser: ["void reporter", "Chrome", "1.0"],
    generateHighQualityLinkPreview: false, syncFullHistory: false,
  });

  entry.sock = sock;
  sock.ev.on("creds.update", saveCreds);

  sock.ev.on("connection.update", ({ connection, lastDisconnect, qr }) => {
    if (qr) {
      log.wa(`[${dirName}] scan QR`);
      if (!onQR) qrcode.generate(qr, { small: true });
      else onQR(qr);
    }
    if (connection === "open") {
      entry.ready = true;
      log.ok(`[${dirName}] connected`);
      if (onReady) onReady();
      if (authMode) setTimeout(() => process.exit(0), 3000);
    }
    if (connection === "close") {
      entry.ready = false;
      const code = lastDisconnect?.error?.output?.statusCode;
      const shouldReconnect = code !== DisconnectReason.loggedOut;
      log.warn(`[${dirName}] closed (${code}) reconnect=${shouldReconnect}`);
      if (shouldReconnect && !authMode) setTimeout(() => initOne(dirName, userId).catch(() => {}), 3000);
      if (code === DisconnectReason.loggedOut && onError) onError("logged_out");
    }
  });

  if (authMode) await new Promise((r) => setTimeout(r, 180000));
  return entry;
}

export async function initUserWaClients() {
  const dirs = [];
  try {
    for (const d of fs.readdirSync(".")) {
      if (d.startsWith("wa-auth-") && fs.statSync(d).isDirectory()) dirs.push(d);
    }
  } catch (_) {}
  for (const d of dirs) {
    const userId = parseUserIdFromDir(d);
    initOne(d, userId).catch((e) => log.err(`[${d}] ${e.message}`));
  }
  log.info(`booted ${dirs.length} wa clients`);
}

function parseUserIdFromDir(dir) {
  const m = dir.match(/wa-auth-u(\d+)-/);
  return m ? parseInt(m[1], 10) : 0;
}

export async function startWaAuth(dirName, userId, { onQR, onReady, onError }) {
  return initOne(dirName, userId, { authMode: true, onQR, onReady, onError });
}

export function endWaAuth(dirName) {
  const entry = CLIENTS.get(dirName);
  if (entry) { try { entry.sock?.end(new Error("cancelled")); } catch (_) {} }
}

export function detectWaTarget(raw) {
  const s = raw.trim();
  if (/^https?:\/\/chat\.whatsapp\.com\//.test(s)) {
    return { type: "group_invite", value: s.match(/chat\.whatsapp\.com\/([a-zA-Z0-9]+)/)[1] };
  }
  const digits = s.replace(/[^\d]/g, "");
  if (digits.length >= 8 && digits.length <= 15) return { type: "phone", value: digits };
  return { type: "name", value: s };
}

async function resolveJid(entry, info) {
  const sock = entry.sock;
  if (info.type === "phone") {
    const [check] = await sock.onWhatsApp(info.value);
    if (!check || !check.exists) throw new Error("not_on_wa");
    return { kind: "user", jid: check.jid };
  }
  if (info.type === "group_invite") {
    try {
      const meta = await sock.groupAcceptInvite(info.value);
      await sleep(1500);
      return { kind: "group", jid: meta };
    } catch (e) { throw new Error(`invite_fail:${e.message}`); }
  }
  throw new Error("name_lookup_unsupported");
}

async function reportAndBlock(entry, target, reason) {
  const info = detectWaTarget(target);
  const sock = entry.sock;
  let resolved;
  try { resolved = await resolveJid(entry, info); }
  catch (e) { return { ok: false, status: `resolve:${e.message}` }; }

  let reported = false, blocked = false, reportErr = null, blockErr = null;

  try {
    await sock.sendMessage(resolved.jid, { text: " " });
    await sleep(300);
    await sock.query({
      tag: "iq",
      attrs: { to: "s.whatsapp.net", type: "set", xmlns: "spam" },
      content: [{ tag: "spam_list", attrs: {}, content: [{ tag: "spam_item", attrs: { jid: resolved.jid, reason: WA_REASON[reason] || "other" } }] }],
    });
    reported = true;
  } catch (e) { reportErr = e.message || "report_fail"; }

  try { await sock.updateBlockStatus(resolved.jid, "block"); blocked = true; }
  catch (e) { blockErr = e.message || "block_fail"; }

  if (reported || blocked) {
    const tag = reported && blocked ? "report+block" : reported ? "report" : "block";
    return { ok: true, status: tag };
  }
  return { ok: false, status: `err:${reportErr || blockErr || "fail"}` };
}

function nextClientForUser(userId) {
  const mine = [...CLIENTS.values()].filter((e) => e.ready && !e.busy && (userId === 0 || e.userId === userId));
  const ready = mine.length ? mine : [...CLIENTS.values()].filter((e) => e.ready && !e.busy);
  if (!ready.length) return null;
  return ready[rrIndex++ % ready.length];
}

export async function runWaWave(job, sem) {
  const readyEntries = [...CLIENTS.values()].filter((e) => e.ready && (job.userId === 0 || e.userId === job.userId));
  if (!readyEntries.length) {
    const anyReady = [...CLIENTS.values()].filter((e) => e.ready);
    if (!anyReady.length) { log.err("no wa ready"); job.running = false; return; }
  }
  const need = job.reportCount - job.reportsDone;
  if (need <= 0) return;
  const batch = Math.min(job.waveSize, need);
  log.wa(`wave в†’ ${batch} (${job.reportsDone}/${job.reportCount})`);

  await Promise.all(
    Array.from({ length: batch }).map(async () => {
      await sem.acquire();
      try {
        if (job.cancel || job.reportsDone >= job.reportCount) return;
        let picked = null;
        await withLock(() => {
          const entry = nextClientForUser(job.userId);
          if (entry) { entry.busy = true; picked = entry; }
        });
        if (!picked) { await sleep(200); return; }
        let res;
        try { res = await reportAndBlock(picked, job.target, job.reason); }
        catch (e) { res = { ok: false, status: `err:${e.message}` }; }
        finally { await withLock(() => { picked.busy = false; }); }
        await withLock(() => {
          if (res.ok) { picked.ok += 1; picked.lastStatus = `ok:${res.status}`; job.ok += 1; job.reportsDone += 1; }
          else { picked.fail += 1; picked.lastStatus = `fail:${res.status}`; job.fail += 1; }
        });
        if (res.ok) log.wa(`[${picked.dirName}] в†’ ${job.target} ${res.status}`);
        else log.warn(`[${picked.dirName}] fail: ${res.status}`);
        await sleep(rand(job.delayRange[0], job.delayRange[1]) * 1000);
      } finally { sem.release(); }
    })
  );
}

export function waStatus(userId) {
  const mine = [...CLIENTS.values()].filter((e) => userId === 0 || e.userId === userId);
  const totals = mine.reduce((a, e) => { a.ok += e.ok; a.fail += e.fail; return a; }, { ok: 0, fail: 0 });
  return { ...totals, accounts: mine.map((e) => ({ dir: e.dirName, ready: e.ready, ok: e.ok, fail: e.fail })) };
}
export function waReset(userId) {
  for (const e of CLIENTS.values()) if (userId === 0 || e.userId === userId) { e.ok = 0; e.fail = 0; }
}
export function waReadyCount(userId) {
  return [...CLIENTS.values()].filter((e) => e.ready && (userId === 0 || e.userId === userId)).length;
}
export function userWaDirs(userId) {
  const dirs = [];
  try {
    for (const d of fs.readdirSync(".")) {
      if (d.startsWith(`wa-auth-u${userId}-`) && fs.statSync(d).isDirectory()) dirs.push(d);
    }
  } catch (_) {}
  return dirs;
}
