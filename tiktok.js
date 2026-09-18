import fetch from "node-fetch";
import { SocksProxyAgent } from "socks-proxy-agent";
import { HttpsProxyAgent } from "https-proxy-agent";
import { CFG } from "./config.js";
import { log } from "./logger.js";
import { withLock, sleep, rand } from "./state.js";

let ttStats = { ok: 0, fail: 0, lastStatus: "init" };
export function ttStatus() { return ttStats; }
export function ttReset() { ttStats = { ok: 0, fail: 0, lastStatus: "reset" }; }

const TT_REASON_MAP = { spam: 1005, harassment: 1004, misinformation: 1007, violence: 1002, other: 1000 };
const TIMEOUT_MS = 8000;

function pickProxy() {
  if (!CFG.tiktokProxies.length) return undefined;
  const raw = CFG.tiktokProxies[Math.floor(Math.random() * CFG.tiktokProxies.length)];
  try { return raw.startsWith("socks") ? new SocksProxyAgent(raw) : new HttpsProxyAgent(raw); }
  catch { return undefined; }
}

export function detectTtTarget(raw) {
  const s = raw.trim();
  if (/^https?:\/\/(vm|vt)\.tiktok\.com\//.test(s)) return { type: "short_link", value: s };
  const vm = s.match(/tiktok\.com\/@[^/]+\/video\/(\d+)/);
  if (vm) return { type: "video", value: vm[1] };
  const cm = s.match(/tiktok\.com\/@[^/]+\/video\/(\d+).*comment_id=(\d+)/);
  if (cm) return { type: "comment", value: { videoId: cm[1], commentId: cm[2] } };
  const um = s.match(/tiktok\.com\/@([a-zA-Z0-9_.]+)/);
  if (um) return { type: "user", value: um[1] };
  const ua = s.match(/^@([a-zA-Z0-9_.]+)$/);
  if (ua) return { type: "user", value: ua[1] };
  if (/^\d+$/.test(s)) return { type: "video", value: s };
  if (/^[a-zA-Z0-9_.]{2,}$/.test(s)) return { type: "user", value: s };
  return { type: "unknown", value: s };
}

async function fetchWithTimeout(url, options = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, { ...options, signal: controller.signal });
    clearTimeout(timer);
    return res;
  } catch (e) {
    clearTimeout(timer);
    if (e.name === "AbortError") throw new Error("timeout");
    throw e;
  }
}

async function getSession(agent) {
  const res = await fetchWithTimeout("https://www.tiktok.com/", {
    headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36" },
    agent,
  });
  const body = await res.text();
  const cookies = res.headers.raw()["set-cookie"]?.join("; ") || "";
  const csrfToken = body.match(/"csrfToken":"([^"]+)"/)?.[1] || "";
  const verifyFp = cookies.match(/s_v_web_id=([^;]+)/)?.[1] || "";
  return { csrfToken, verifyFp, cookies };
}

async function fireReport(target, reason) {
  let info = detectTtTarget(target);
  const agent = pickProxy();
  if (info.type === "unknown") return { ok: false, status: "invalid_target" };

  const reasonCode = TT_REASON_MAP[reason] || 1000;
  let sess;
  try { sess = await getSession(agent); }
  catch (e) { return { ok: false, status: `session:${e.message}` }; }
  const { csrfToken, verifyFp, cookies } = sess;

  const p = new URLSearchParams({
    aid: "1988", app_language: "en", app_name: "tiktok_web", browser_language: "en-US",
    browser_name: "Mozilla", browser_platform: "Win32", browser_version: "5.0 (Windows)",
    channel: "tiktok_web", cookie_enabled: "true", device_platform: "web_pc",
    focus_state: "true", from_page: "video", history_len: "3", is_fullscreen: "false",
    is_page_visible: "true", language: "en", os: "windows", priority_region: "US",
    referer: "", region: "US", screen_height: "1080", screen_width: "1920",
    tz_name: "America/New_York", webcast_language: "en",
  });
  if (verifyFp) p.set("verifyFp", verifyFp);
  if (csrfToken) p.set("csrf_token", csrfToken);

  let url, body;
  if (info.type === "video") {
    url = `https://www.tiktok.com/api/report/v1/report/?${p}`;
    body = JSON.stringify({ object_id: info.value, reason: reasonCode, report_type: 0, r: "", secUid: "", extra: "" });
  } else if (info.type === "user") {
    url = `https://www.tiktok.com/api/report/v1/report/user/?${p}`;
    body = JSON.stringify({ object_id: info.value, reason: reasonCode, report_type: 1, r: "" });
  } else if (info.type === "comment") {
    url = `https://www.tiktok.com/api/report/v1/report/comment/?${p}`;
    body = JSON.stringify({ object_id: info.value.commentId, video_id: info.value.videoId, reason: reasonCode, report_type: 2, r: "" });
  }

  try {
    const res = await fetchWithTimeout(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        "Referer": "https://www.tiktok.com/", "Cookie": cookies, "Origin": "https://www.tiktok.com",
      },
      body, agent,
    });
    const text = await res.text();
    let json; try { json = JSON.parse(text); } catch { json = null; }
    if (json && json.status_code === 0) return { ok: true, status: "reported" };
    if (json && json.status_code) return { ok: false, status: `tt_${json.status_code}` };
    if (res.ok) return { ok: true, status: "reported" };
    return { ok: false, status: `http_${res.status}` };
  } catch (e) { return { ok: false, status: `err:${e.message}` }; }
}

export async function runTtWave(job, sem) {
  const need = job.reportCount - job.reportsDone;
  if (need <= 0) return;
  const batch = Math.min(job.waveSize, need);
  log.tt(`wave в†’ ${batch} (${job.reportsDone}/${job.reportCount})`);

  await Promise.all(
    Array.from({ length: batch }).map(async () => {
      await sem.acquire();
      try {
        if (job.cancel || job.reportsDone >= job.reportCount) return;
        const { ok, status } = await fireReport(job.target, job.reason);
        await withLock(() => {
          if (ok) { ttStats.ok += 1; job.ok += 1; job.reportsDone += 1; ttStats.lastStatus = `ok:${job.target}`; }
          else { ttStats.fail += 1; job.fail += 1; ttStats.lastStatus = `fail:${status}`; }
        });
        if (ok) log.tt(`в†’ ${job.target} (${job.reportsDone}/${job.reportCount})`);
        else log.warn(`tt fail: ${status}`);
        await sleep(rand(job.delayRange[0], job.delayRange[1]) * 1000);
      } finally { sem.release(); }
    })
  );
}
