import { TelegramClient, Api } from "telegram";
import { StringSession } from "telegram/sessions/index.js";
import { SocksProxyAgent } from "socks-proxy-agent";

import { CFG } from "./config.js";
import { TG_STATE, withLock, sleep, rand, liveTgSessions } from "./state.js";
import { log } from "./logger.js";

const TG_PROXY = process.env.TG_PROXY_URL || "socks4://107.167.18.122:443";

const REASON_CLASSES = {
  spam: Api.InputReportReasonSpam,
  violence: Api.InputReportReasonViolence,
  child_abuse: Api.InputReportReasonChildAbuse,
  pornography: Api.InputReportReasonPornography,
  impersonation: Api.InputReportReasonImpersonation,
  other: Api.InputReportReasonOther,
};

function withTimeout(promise, ms, label) {
  return Promise.race([
    promise,
    new Promise((_, rej) => setTimeout(() => rej(new Error(`timeout:${label}`)), ms)),
  ]);
}

let _agent = null;
function getAgent() {
  if (!_agent && TG_PROXY) {
    try {
      _agent = new SocksProxyAgent(TG_PROXY);
      log.tg(`using proxy: ${TG_PROXY}`);
    } catch (e) {
      log.err(`proxy build failed: ${e.message}`);
    }
  }
  return _agent;
}

function clientOptions() {
  const opts = {
    connectionRetries: 3,
    timeout: 30,
    useIPV6: false,
  };
  const agent = getAgent();
  if (agent) opts.proxy = agent;
  return opts;
}

export function detectTgTarget(raw) {
  const s = raw.trim();
  if (/^https?:\/\/t\.me\/\+/.test(s)) return { type: "invite", value: s };
  if (/^https?:\/\/t\.me\/joinchat\//.test(s)) return { type: "invite", value: s };
  if (/^\+[a-zA-Z0-9_-]{10,}$/.test(s)) return { type: "invite", value: s };
  if (/^https?:\/\/t\.me\/[a-zA-Z0-9_]{4,}/.test(s)) {
    const uname = s.match(/t\.me\/([a-zA-Z0-9_]+)/)[1];
    return { type: "public", value: uname };
  }
  if (/^@[a-zA-Z0-9_]{4,}$/.test(s)) return { type: "public", value: s.slice(1) };
  if (/^[a-zA-Z][a-zA-Z0-9_]{3,}$/.test(s)) return { type: "public", value: s };
  if (/^-?\d+$/.test(s)) return { type: "numeric", value: s };
  return { type: "unknown", value: s };
}

async function resolveTarget(client, info) {
  if (info.type === "invite") {
    const hash = info.value.replace(/.*\//, "").replace(/^\+/, "");
    const inv = await withTimeout(
      client.invoke(new Api.messages.CheckChatInvite({ hash })), 15000, "checkinvite"
    );
    if (inv.chat) return await client.getInputEntity(inv.chat.id);
    throw new Error("invite_unresolved");
  }
  try {
    return await withTimeout(client.getInputEntity(info.value), 15000, "resolve");
  } catch (e) {
    throw new Error(`resolve_fail:${e.message || e.constructor.name}`);
  }
}

async function fireReportWithLeave(client, peer, msgIds, reason) {
  let reported = false, left = false, reportErr = null, leaveErr = null;

  try {
    await withTimeout(
      client.invoke(new Api.messages.Report({ peer, id: msgIds, reason, message: "" })),
      15000, "report"
    );
    reported = true;
  } catch (e) {
    if (e.seconds) return { ok: false, status: `flood_wait:${e.seconds}` };
    if (e.errorMessage?.includes("BANNED")) return { ok: false, status: "banned" };
    reportErr = e.errorMessage || e.message || e.constructor.name;
  }

  try {
    await withTimeout(client.invoke(new Api.channels.LeaveChannel({ channel: peer })), 10000, "leave");
    left = true;
  } catch (e) {
    try {
      await withTimeout(client.invoke(new Api.messages.DeleteHistory({ peer, maxId: 0, revoke: false })), 8000, "delhist");
      left = true;
    } catch (e2) { leaveErr = e2.errorMessage || e2.message || e2.constructor.name; }
  }

  if (reported || left) {
    const tag = reported && left ? "report+leave" : reported ? "report" : "leave";
    return { ok: true, status: tag };
  }
  return { ok: false, status: `err:${reportErr || leaveErr || "fail"}` };
}

async function worker(session, job, sem) {
  await sem.acquire();
  try {
    if (session.dead || job.cancel) return;
    if (session.floodUntil > Date.now() / 1000) return;
    if (job.reportsDone >= job.reportCount) return;

    const client = new TelegramClient(
      new StringSession(session.cfg.session),
      CFG.apiId, CFG.apiHash,
      clientOptions()
    );

    try {
      await withTimeout(client.connect(), 45000, "connect");
    } catch (e) {
      await withLock(() => { session.lastStatus = `cf:${e.message || e.constructor.name}`; });
      log.err(`${session.name} connect failed: ${e.message}`);
      try { await client.disconnect(); } catch (_) {}
      await withLock(() => { job.fail += 1; job.reportsDone += 1; });
      return;
    }

    let peer;
    try { peer = await resolveTarget(client, job.targetInfo); }
    catch (e) {
      await withLock(() => { session.lastStatus = e.message; job.fail += 1; job.reportsDone += 1; });
      log.warn(`${session.name} resolve fail: ${e.message}`);
      try { await client.disconnect(); } catch (_) {}
      return;
    }

    const reason = new REASON_CLASSES[job.reason]();

    for (let attempt = 1; attempt <= job.maxRetries; attempt++) {
      if (job.cancel) break;
      if (job.reportsDone >= job.reportCount) break;
      const { ok, status } = await fireReportWithLeave(client, peer, job.messageIds, reason);
      if (ok) {
        await withLock(() => { session.ok += 1; session.lastStatus = `ok:${status}`; job.ok += 1; job.reportsDone += 1; });
        log.tg(`${session.name} в†’ ${job.target} ${status} (${job.reportsDone}/${job.reportCount})`);
        break;
      }
      if (status.startsWith("flood_wait:")) {
        const secs = parseInt(status.split(":")[1], 10);
        await withLock(() => { session.floodUntil = Date.now() / 1000 + secs; session.lastStatus = `flood:${secs}s`; job.fail += 1; job.reportsDone += 1; });
        log.warn(`${session.name} flood ${secs}s`);
        break;
      }
      if (status === "banned") {
        await withLock(() => { session.dead = true; session.lastStatus = "banned"; job.fail += 1; job.reportsDone += 1; });
        log.err(`${session.name} BANNED`);
        break;
      }
      if (attempt < job.maxRetries) await sleep((2 ** attempt + Math.random()) * 1000);
      else await withLock(() => { session.failed += 1; session.lastStatus = `fail:${status}`; job.fail += 1; job.reportsDone += 1; });
      log.warn(`${session.name} fail: ${status}`);
    }

    try { await client.disconnect(); } catch (_) {}
    await sleep(rand(job.delayRange[0], job.delayRange[1]) * 1000);
  } catch (e) {
    log.err(`worker crash: ${e.message}`);
  } finally { sem.release(); }
}

export async function runTgWave(job, sem) {
  const need = job.reportCount - job.reportsDone;
  if (need <= 0) return;
  let live = liveTgSessions();
  live.sort(() => Math.random() - 0.5);

  if (live.length === 0) {
    const all = [...TG_STATE.values()];
    if (all.length === 0) { log.err("no tg sessions"); job.running = false; return; }
    for (const s of all) {
      if (s.dead && s.lastStatus !== "banned") { s.dead = false; s.lastStatus = "revived"; log.tg(`revived ${s.name}`); }
    }
    live = liveTgSessions();
    if (live.length === 0) { log.err("no live sessions"); await sleep(2000); return; }
  }

  const wave = live.slice(0, Math.min(job.waveSize, need));
  job.sessionsUsed += wave.length;
  log.tg(`wave в†’ ${wave.length} (${job.reportsDone}/${job.reportCount})`);
  await Promise.all(wave.map((s) => worker(s, job, sem)));
}

export function tgSessionCount() { return TG_STATE.size; }
export function tgLive() { return liveTgSessions().length; }
export function tgDead() { return [...TG_STATE.values()].filter((s) => s.dead).length; }
export function tgCool() {
  const now = Date.now() / 1000;
  return [...TG_STATE.values()].filter((s) => !s.dead && s.floodUntil > now).length;
}
export function tgResetAll() {
  for (const s of TG_STATE.values()) { s.dead = false; s.floodUntil = 0; s.lastStatus = "reset"; }
}

export const AUTH_CLIENTS = new Map();

export async function authSendCode(phone, chatId) {
  const prev = AUTH_CLIENTS.get(chatId);
  if (prev) { try { await prev.disconnect(); } catch (_) {} AUTH_CLIENTS.delete(chatId); }
  const client = new TelegramClient(new StringSession(""), CFG.apiId, CFG.apiHash, {
    connectionRetries: 5,
    deviceModel: "VoidReporter",
    systemVersion: "10",
    appVersion: "1.0",
    langCode: "en",
    systemLangCode: "en",
    useIPV6: false,
  });
  await withTimeout(client.connect(), 20000, "auth_connect");
  const result = await withTimeout(client.sendCode({ apiId: CFG.apiId, apiHash: CFG.apiHash }, phone), 20000, "send_code");
  AUTH_CLIENTS.set(chatId, client);
  return { phoneCodeHash: result.phoneCodeHash, isCodeViaApp: result.isCodeViaApp };
}

export async function authSignIn(chatId, phone, phoneCodeHash, code) {
  const client = AUTH_CLIENTS.get(chatId);
  if (!client) throw new Error("no_auth_client");
  try {
    await withTimeout(client.invoke(new Api.auth.SignIn({ phoneNumber: phone, phoneCodeHash, phoneCode: code })), 15000, "signin");
    return { ok: true, session: client.session.save() };
  } catch (e) {
    const msg = e.errorMessage || e.message || e.constructor.name;
    if (msg === "SESSION_PASSWORD_NEEDED" || e.constructor.name === "SessionPasswordNeededError") return { ok: false, need2fa: true };
    throw e;
  }
}

export async function authSignIn2FA(chatId, password) {
  const client = AUTH_CLIENTS.get(chatId);
  if (!client) throw new Error("no_auth_client");
  const pwd = await withTimeout(client.invoke(new Api.account.GetPassword()), 10000, "get_pwd");
  const { computeCheck } = await import("telegram/Password.js");
  const check = await computeCheck(pwd, password);
  await withTimeout(client.invoke(new Api.auth.CheckPassword({ password: check })), 15000, "check_pwd");
  return { ok: true, session: client.session.save() };
}

export async function authDisconnect(chatId) {
  const client = AUTH_CLIENTS.get(chatId);
  if (client) { try { await client.disconnect(); } catch (_) {} AUTH_CLIENTS.delete(chatId); }
}
