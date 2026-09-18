import fs from "fs";
import "dotenv/config";

function parseIds(raw) {
  return new Set((raw || "").split(",").map((x) => parseInt(x.trim(), 10)).filter(Boolean));
}

function parseList(raw) {
  return (raw || "").split(",").map((x) => x.trim()).filter(Boolean);
}

function loadSessions() {
  if (fs.existsSync("sessions.json")) {
    try {
      const arr = JSON.parse(fs.readFileSync("sessions.json", "utf8"));
      if (Array.isArray(arr) && arr.length > 0) return arr;
    } catch (_) {}
  }
  const arr = [];
  let i = 1;
  while (true) {
    const s = (process.env[`TG_SESSION_${i}`] || "").trim();
    if (!s) break;
    arr.push({
      name: (process.env[`TG_SESSION_${i}_NAME`] || `s${i}`).trim(),
      session: s,
      proxy: null,
      proxyList: [],
    });
    i++;
  }
  return arr;
}

export const CFG = {
  apiId: parseInt(process.env.API_ID, 10),
  apiHash: process.env.API_HASH,
  botToken: process.env.BOT_TOKEN,
  ownerIds: parseIds(process.env.OWNER_IDS || process.env.ADMIN_IDS),
  botImageUrl: (process.env.BOT_IMAGE_URL || "").trim(),

  jobsPerHour: parseInt(process.env.JOBS_PER_HOUR || "3", 10),

  defaultConcurrency: parseInt(process.env.DEFAULT_CONCURRENCY || "50", 10),
  defaultWaveSize: parseInt(process.env.DEFAULT_WAVE_SIZE || "100", 10),
  defaultWaveCooldown: parseInt(process.env.DEFAULT_WAVE_COOLDOWN || "2", 10),
  defaultDelayRange: [
    parseFloat(process.env.DELAY_MIN || "0.1"),
    parseFloat(process.env.DELAY_MAX || "0.5"),
  ],
  defaultMaxRetries: parseInt(process.env.MAX_RETRIES || "1", 10),

  tgSessions: loadSessions(),
  tiktokProxies: parseList(process.env.TIKTOK_PROXIES),
};

export const PLATFORMS = {
  telegram: { label: "рџ“± Telegram" },
  whatsapp: { label: "рџџў WhatsApp" },
  tiktok: { label: "вљ« TikTok" },
};

export const REASON_LABELS = {
  telegram: {
    child_abuse: "рџљё Child Abuse вљЎ",
    violence: "вљ пёЏ Violence вљЎ",
    impersonation: "рџЋ­ Impersonation вљЎ",
    spam: "рџљ« Spam",
    pornography: "рџ”ћ Pornography",
    other: "рџ“Ћ Other",
  },
  whatsapp: {
    scam: "рџЋЈ Scam / Fraud вљЎ",
    abuse: "вљ пёЏ Abuse вљЎ",
    spam: "рџљ« Spam",
    impersonation: "рџЋ­ Impersonation",
    other: "рџ“Ћ Other",
  },
  tiktok: {
    violence: "рџ©ё Violence вљЎ",
    harassment: "вљ пёЏ Harassment вљЎ",
    spam: "рџљ« Spam",
    misinformation: "рџ“° Misinformation",
    other: "рџ“Ћ Other",
  },
};

export const REASON_SETS = {
  telegram: ["impersonation", "child_abuse", "violence", "spam"],
  whatsapp: ["scam", "abuse", "spam"],
  tiktok: ["violence", "harassment", "spam"],
};

export const COUNT_OPTIONS = [100, 200, 500, 1000];
