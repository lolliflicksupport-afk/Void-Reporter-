import { Telegraf, Markup } from "telegraf";
import QRCode from "qrcode";
import { CFG, PLATFORMS, REASON_LABELS, REASON_SETS, COUNT_OPTIONS } from "./config.js";
import {
  getUserJob, setUserJob, getUserQueue,
  canFire, markFired, rateRemaining,
  withLock,
} from "./state.js";
import {
  tgSessionCount, tgLive, tgDead, tgCool, tgResetAll, detectTgTarget,
} from "./telegram.js";
import {
  waStatus, waReset, waReadyCount, detectWaTarget,
  startWaAuth, endWaAuth, userWaDirs,
} from "./whatsapp.js";
import { ttStatus, ttReset, detectTtTarget } from "./tiktok.js";
import { runJob } from "./reporter.js";
import { recentJobs } from "./db.js";
import { log } from "./logger.js";

const VOID_HEADER = "🕯️ *void reporter*";
const VOID_TAGLINE = "_silence the target._";

export const bot = new Telegraf(CFG.botToken);

function mainMenu() {
  return Markup.inlineKeyboard([
    [Markup.button.callback("🔵 Telegram Report", "plat:telegram")],
    [Markup.button.callback("🟢 WhatsApp Report", "plat:whatsapp")],
    [Markup.button.callback("⚡ TikTok Report", "plat:tiktok")],
    [Markup.button.callback("📊 Status", "menu:status"),
     Markup.button.callback("📋 Queue", "menu:queue")],
    [Markup.button.callback("🧾 History", "menu:history"),
     Markup.button.callback("🛑 Stop Job", "menu:stop")],
    [Markup.button.callback("➕ Add WA Session", "menu:addwa")],
    [Markup.button.callback("🔄 Reset My Sessions", "menu:reset")],
    [Markup.button.callback("ℹ️ Help", "menu:help")],
  ]);
}

function countMenu(platform) {
  const rows = [];
  for (let i = 0; i < COUNT_OPTIONS.length; i += 2) {
    rows.push(COUNT_OPTIONS.slice(i, i + 2).map((n) =>
      Markup.button.callback(`🔹 ${n}`, `count:${platform}:${n}`)
    ));
  }
  rows.push([
    Markup.button.callback("✏️ Custom", `count:${platform}:custom`),
    Markup.button.callback("⬅️ Back", "menu:home"),
  ]);
  return Markup.inlineKeyboard(rows);
}

function reasonMenu(platform) {
  const labels = REASON_LABELS[platform] || {};
  const rows = [[Markup.button.callback("⚡ Mix all (fastest)", `reason:${platform}:mix`)]];
  for (const [k, v] of Object.entries(labels)) {
    rows.push([Markup.button.callback(v, `reason:${platform}:${k}`)]);
  }
  rows.push([Markup.button.callback("⬅️ Back", "menu:home")]);
  return Markup.inlineKeyboard(rows);
}

function backMenu() { return Markup.inlineKeyboard([[Markup.button.callback("⬅️ Back to Menu", "menu:home")]]); }
function statusMenu() { return Markup.inlineKeyboard([[Markup.button.callback("🔄 Refresh", "menu:status")], [Markup.button.callback("⬅️ Back", "menu:home")]]); }
function queueMenu() { return Markup.inlineKeyboard([[Markup.button.callback("🗑️ Clear", "queue:clear")], [Markup.button.callback("📊 Status", "menu:status")], [Markup.button.callback("⬅️ Back", "menu:home")]]); }
function historyMenu() { return Markup.inlineKeyboard([[Markup.button.callback("🔄 Refresh", "menu:history")], [Markup.button.callback("⬅️ Back", "menu:home")]]); }
function jobMenu() { return Markup.inlineKeyboard([[Markup.button.callback("📊 Status", "menu:status")], [Markup.button.callback("🛑 Stop", "menu:stop")], [Markup.button.callback("⬅️ Back", "menu:home")]]); }
function addwaMenu() { return Markup.inlineKeyboard([[Markup.button.callback("❌ Cancel", "addwa:cancel")]]); }

function renderJob(job, note = "") {
  if (!job) return `${VOID_HEADER}\n\n🟡 _no active job_`;
  const elapsed = Math.floor(Date.now() / 1000 - job.startedAt);
  const done = job.ok + job.fail;
  const pct = job.reportCount > 0 ? Math.min(100, Math.floor((done / job.reportCount) * 100)) : 0;
  const filled = Math.floor(pct / 5);
  const bar = "█".repeat(filled) + "░".repeat(20 - filled);
  const rps = elapsed > 0 ? (done / elapsed).toFixed(1) : "0";
  const lines = [
    `🎯 *void reporter вЂ” job* вЂ” ${PLATFORMS[job.platform].label}`,
    `🎯 target: \`${job.target}\``,
    `⚡ reason: ${REASON_LABELS[job.platform]?.[job.reason] || job.reason}`,
  ];
  if (job.messageIds?.length) lines.push(`🔢 msgs: \`${job.messageIds.join(",")}\``);
  lines.push("", `📈 progress: *${done}/${job.reportCount}* (*${pct}%*)`, `\`${bar}\``, `🟢 ok: *${job.ok}*  🔴 fail: *${job.fail}*`, `⚡ rate: *${rps}/s*  ⏱ elapsed: *${elapsed}s*`);
  if (note) lines.push("", `_${note}_`);
  return lines.join("\n");
}

function renderStatus(userId) {
  const lines = [`${VOID_HEADER}\n${VOID_TAGLINE}\n\n🧮 *your sessions*\n`];
  lines.push(`🔵 TG: sessions=${tgSessionCount()} live=${tgLive()} dead=${tgDead()} cool=${tgCool()}`);
  const wa = waStatus(userId);
  lines.push(`🟢 WA: ready=${waReadyCount(userId)} ok=${wa.ok} fail=${wa.fail}`);
  for (const a of wa.accounts) lines.push(`   \`${a.dir}\` ${a.ready ? "🟢" : "🔴"} ok=${a.ok} fail=${a.fail}`);
  const tt = ttStatus();
  lines.push(`⚡ TT: ok=${tt.ok} fail=${tt.fail} proxies=${CFG.tiktokProxies.length}`);
  lines.push("", `⏳ job quota: *${rateRemaining(userId)}* / ${CFG.ownerIds.has(userId) ? "∞" : CFG.jobsPerHour} per hour`);
  return lines.join("\n");
}

function renderQueue(userId) {
  const lines = [`${VOID_HEADER}\n\n📋 *your queue*\n`];
  const a = getUserJob(userId);
  if (a) lines.push(`*🟢 Active:* ${PLATFORMS[a.platform].label} В· ${a.target} вЂ” ${a.ok + a.fail}/${a.reportCount}`);
  else lines.push("*Active:* none");
  const q = getUserQueue(userId);
  lines.push(`*🟡 Pending:* ${q.length}`);
  q.forEach((j, i) => lines.push(`  ${i + 1}. ${PLATFORMS[j.platform].label} В· ${j.target} Г— ${j.reportCount}`));
  return lines.join("\n");
}

function renderHistory(userId) {
  const rows = recentJobs(userId, 10);
  if (!rows.length) return `${VOID_HEADER}\n\n🧾 *your history*\n\n_no jobs yet_`;
  const lines = [`${VOID_HEADER}\n\n🧾 *your recent jobs*\n`];
  for (const r of rows) {
    const when = new Date(r.started_at * 1000).toISOString().slice(0, 16).replace("T", " ");
    lines.push(`\`#${r.id}\` ${PLATFORMS[r.platform]?.label} В· ${r.target} Г— ${r.report_count} ok=${r.ok} fail=${r.fail} ${when}`);
  }
  return lines.join("\n");
}

async function pushStatus(job, note = "") {
  const text = renderJob(job, note);
  try {
    if (job.statusMsgId) await bot.telegram.editMessageText(job.chatId, job.statusMsgId, undefined, text, { parse_mode: "Markdown" });
    else {
      const m = await bot.telegram.sendMessage(job.chatId, text, { parse_mode: "Markdown" });
      job.statusMsgId = m.message_id;
    }
  } catch (_) {}
}

const flow = new Map();
const addWa = new Map();

function createJob(userId, platform, target, targetInfo, msgIds, reason, reportCount, chatId) {
  return {
    userId, platform, target, targetInfo, messageIds: msgIds, reason, reportCount,
    reportsDone: 0, concurrency: CFG.defaultConcurrency, delayRange: CFG.defaultDelayRange,
    maxRetries: CFG.defaultMaxRetries, waveSize: CFG.defaultWaveSize, waveCooldown: CFG.defaultWaveCooldown,
    chatId, statusMsgId: 0, running: true, cancel: false, ok: 0, fail: 0, sessionsUsed: 0, startedAt: Date.now() / 1000,
  };
}

function startProgressLoop(job) {
  const timer = setInterval(async () => {
    if (!job.running) { clearInterval(timer); return; }
    await pushStatus(job);
  }, 2000);
}

async function startJob(job) {
  setUserJob(job.userId, job);
  const sent = await bot.telegram.sendMessage(job.chatId, renderJob(job, "queued"), { parse_mode: "Markdown", ...jobMenu() });
  job.statusMsgId = sent.message_id;
  startProgressLoop(job);

  runJob(job, pushStatus)
    .catch((e) => pushStatus(job, `crash: ${e.constructor.name}`))
    .finally(async () => {
      try {
        await bot.telegram.editMessageText(job.chatId, job.statusMsgId, undefined, renderJob(job, job.cancel ? "cancelled" : "finished"), { parse_mode: "Markdown", ...queueMenu() });
      } catch (_) {}
      setUserJob(job.userId, null);
      const q = getUserQueue(job.userId);
      if (q.length) {
        const n = q.shift();
        const nextJob = createJob(job.userId, n.platform, n.target, n.targetInfo, n.messageIds, n.reason, n.reportCount, n.chatId);
        markFired(job.userId);
        startJob(nextJob);
      }
    });
}

function nextWaDirForUser(userId) {
  const used = new Set(userWaDirs(userId));
  let i = 1;
  while (used.has(`wa-auth-u${userId}-${i}`)) i++;
  return `wa-auth-u${userId}-${i}`;
}

bot.start((ctx) => ctx.replyWithMarkdown(`${VOID_HEADER}\n${VOID_TAGLINE}\n\n🐀 _whiskers forward. pick a platform._`, mainMenu()));
bot.command("menu", (ctx) => ctx.replyWithMarkdown(`${VOID_HEADER}\n\n🐀 pick a platform`, mainMenu()));
bot.command("status", (ctx) => ctx.replyWithMarkdown(renderStatus(ctx.from.id), statusMenu()));
bot.command("queue", (ctx) => ctx.replyWithMarkdown(renderQueue(ctx.from.id), queueMenu()));
bot.command("history", (ctx) => ctx.replyWithMarkdown(renderHistory(ctx.from.id), historyMenu()));
bot.command("stop", (ctx) => {
  const a = getUserJob(ctx.from.id);
  if (!a || !a.running) return ctx.replyWithMarkdown(`${VOID_HEADER}\n\n🟡 _no job running_`, backMenu());
  a.cancel = true; a.running = false;
  ctx.replyWithMarkdown("🛑 *cancelling...*", backMenu());
});
bot.command("reset", async (ctx) => {
  await withLock(() => { tgResetAll(); waReset(ctx.from.id); ttReset(); });
  ctx.replyWithMarkdown("🔄 *your sessions reset*", backMenu());
});
bot.command("addwa", (ctx) => {
  const userId = ctx.from.id;
  const dir = nextWaDirForUser(userId);
  addWa.set(ctx.chat.id, { step: "qr", dir, userId });
  ctx.replyWithMarkdown(`${VOID_HEADER}\n\n➕ *add whatsapp session*\n\n📁 Starting auth for \`${dir}\`...\n\n_QR will arrive in a moment_`, addwaMenu());
  kickOffWaAuth(ctx.chat.id, dir, userId).catch((e) => {
    ctx.replyWithMarkdown(`❌ wa auth failed: \`${e.message}\``, addwaMenu());
    addWa.delete(ctx.chat.id);
  });
});

async function kickOffWaAuth(chatId, dir, userId) {
  let qrSent = false;
  await startWaAuth(dir, userId, {
    onQR: async (qr) => {
      if (qrSent) return;
      qrSent = true;
      try {
        const buf = await QRCode.toBuffer(qr, { type: "png", width: 512, margin: 2 });
        await bot.telegram.sendPhoto(chatId, { source: buf }, {
          caption: `📲 *scan this QR*\n\n1. Open WhatsApp on the phone you want to link\n2. Settings в†’ Linked Devices в†’ Link a Device\n3. Scan this QR\n\n_auth dir:_ \`${dir}\``,
          parse_mode: "Markdown",
        });
      } catch (e) {
        await bot.telegram.sendMessage(chatId, "📲 scan QR in the bot console.", { parse_mode: "Markdown" });
      }
    },
    onReady: async () => {
      endWaAuth(dir);
      addWa.delete(chatId);
      await bot.telegram.sendMessage(chatId, `✅ *whatsapp linked*\n\ndir: \`${dir}\``, { parse_mode: "Markdown", ...backMenu() });
    },
    onError: async (err) => {
      endWaAuth(dir);
      addWa.delete(chatId);
      await bot.telegram.sendMessage(chatId, `❌ wa auth error: \`${err}\``, { parse_mode: "Markdown", ...backMenu() });
    },
  });
}

bot.action(/^plat:(telegram|whatsapp|tiktok)$/, async (ctx) => {
  const platform = ctx.match[1];
  await ctx.answerCbQuery(platform);
  flow.set(ctx.chat.id, { platform, step: "target", userId: ctx.from.id });
  const prompt = {
    telegram: `${VOID_HEADER}\n\n🔵 *telegram*\n\n*Step 1/4* вЂ” target.\n\`@channel\`, \`https://t.me/...\`, \`+invite\`, or numeric id`,
    whatsapp: `${VOID_HEADER}\n\n🟢 *whatsapp*\n\n*Step 1/3* вЂ” target.\n\`+234...\`, group invite, or chat name`,
    tiktok: `${VOID_HEADER}\n\n⚡ *tiktok*\n\n*Step 1/3* вЂ” target.\nvideo URL, \`@user\`, video id, or short link`,
  }[platform];
  return ctx.editMessageText(prompt, { parse_mode: "Markdown", ...Markup.inlineKeyboard([[Markup.button.callback("❌ Cancel", "flow:cancel")]]) });
});

bot.action("flow:cancel", async (ctx) => { await ctx.answerCbQuery(); flow.delete(ctx.chat.id); ctx.editMessageText(`${VOID_HEADER}\n\n🟡 _cancelled_`, backMenu()); });

bot.action("menu:addwa", async (ctx) => {
  await ctx.answerCbQuery();
  const userId = ctx.from.id;
  const dir = nextWaDirForUser(userId);
  addWa.set(ctx.chat.id, { step: "qr", dir, userId });
  ctx.editMessageText(`${VOID_HEADER}\n\n➕ *add whatsapp session*\n\n📁 Starting auth for \`${dir}\`...`, { parse_mode: "Markdown", ...addwaMenu() });
  kickOffWaAuth(ctx.chat.id, dir, userId).catch((e) => {
    ctx.replyWithMarkdown(`❌ wa auth failed: \`${e.message}\``, addwaMenu());
    addWa.delete(ctx.chat.id);
  });
});

bot.action("addwa:cancel", async (ctx) => {
  await ctx.answerCbQuery("cancelled");
  const s = addWa.get(ctx.chat.id);
  if (s?.dir) endWaAuth(s.dir);
  addWa.delete(ctx.chat.id);
  ctx.editMessageText(`${VOID_HEADER}\n\n🟡 _add wa cancelled_`, backMenu());
});

bot.on("text", async (ctx) => {
  const s = flow.get(ctx.chat.id);
  if (!s) return;
  if (s.step === "target") {
    s.target = ctx.message.text.trim();
    let info;
    if (s.platform === "telegram") info = detectTgTarget(s.target);
    else if (s.platform === "whatsapp") info = detectWaTarget(s.target);
    else info = detectTtTarget(s.target);
    s.targetInfo = info;
    const label = { public: "📢 channel/group", invite: "🔐 invite", numeric: "🔢 id", phone: "📱 number", group_invite: "👥 group", name: "🏷️ name", video: "🎬 video", user: "👤 user", comment: "💬 comment", short_link: "🔗 short", unknown: "❓ unknown" }[info.type] || info.type;
    if (s.platform === "telegram") {
      s.step = "msgs";
      return ctx.replyWithMarkdown(`✅ target: \`${s.target}\` (${label})\n\n*Step 2/4* вЂ” msg IDs.\nExample: \`100,101,102\``, Markup.inlineKeyboard([[Markup.button.callback("❌ Cancel", "flow:cancel")]]));
    }
    s.step = "count";
    return ctx.replyWithMarkdown(`✅ target: \`${s.target}\` (${label})\n\n*Step 2/3* вЂ” how many reports?`, countMenu(s.platform));
  }
  if (s.step === "msgs") {
    s.messageIds = ctx.message.text.split(/[,\s]+/).map((x) => parseInt(x, 10)).filter((n) => !isNaN(n));
    if (!s.messageIds.length) return ctx.reply("integers please");
    s.step = "count";
    return ctx.replyWithMarkdown(`✅ msgs: \`${s.messageIds.join(",")}\`\n\n*Step 3/4* вЂ” count?`, countMenu(s.platform));
  }
  if (s.step === "custom_count") {
    const n = parseInt(ctx.message.text.trim(), 10);
    if (isNaN(n) || n < 1 || n > 100000) return ctx.reply("1вЂ“100000");
    s.reportCount = n; s.step = "reason";
    return ctx.replyWithMarkdown(`✅ *${n}* reports\n\n*Final* вЂ” reason:`, reasonMenu(s.platform));
  }
});

bot.action(/^count:(telegram|whatsapp|tiktok):(\d+)$/, async (ctx) => {
  const [, platform, n] = ctx.match;
  await ctx.answerCbQuery(`${n}`);
  const s = flow.get(ctx.chat.id);
  if (!s || s.platform !== platform) return ctx.editMessageText("expired", backMenu());
  s.reportCount = parseInt(n, 10); s.step = "reason";
  return ctx.editMessageText(`✅ *${n}* reports\n\n*Final* вЂ” reason:`, { parse_mode: "Markdown", ...reasonMenu(platform) });
});

bot.action(/^count:(telegram|whatsapp|tiktok):custom$/, async (ctx) => {
  await ctx.answerCbQuery();
  const s = flow.get(ctx.chat.id);
  if (!s) return ctx.editMessageText("expired", backMenu());
  s.step = "custom_count";
  return ctx.editMessageText("send a number 1вЂ“100000:", { ...backMenu() });
});

bot.action(/^reason:(telegram|whatsapp|tiktok):(.+)$/, async (ctx) => {
  const [, platform, reason] = ctx.match;
  await ctx.answerCbQuery(reason);
  const s = flow.get(ctx.chat.id);
  if (!s || s.platform !== platform) return ctx.editMessageText("expired", backMenu());
  flow.delete(ctx.chat.id);
  const userId = s.userId;
  if (!canFire(userId)) return ctx.editMessageText(`⏳ *quota reached*\n\n_${CFG.jobsPerHour} jobs per hour. try again later._`, { parse_mode: "Markdown", ...backMenu() });

  let reasons = [reason];
  if (reason === "mix") reasons = REASON_SETS[platform] || [Object.keys(REASON_LABELS[platform])[0]];

  if (reasons.length > 1) {
    const per = Math.floor(s.reportCount / reasons.length);
    const remainder = s.reportCount - per * reasons.length;
    const summary = [];
    for (let i = 0; i < reasons.length; i++) {
      const count = per + (i === 0 ? remainder : 0);
      const job = createJob(userId, platform, s.target, s.targetInfo, s.messageIds, reasons[i], count, ctx.chat.id);
      if (getUserJob(userId)?.running || getUserQueue(userId).length > 0) {
        getUserQueue(userId).push({ platform, target: s.target, targetInfo: s.targetInfo, messageIds: s.messageIds, reason: reasons[i], reportCount: count, chatId: ctx.chat.id });
        summary.push(`  🟡 queued ${REASON_LABELS[platform][reasons[i]]} (${count})`);
      } else {
        markFired(userId);
        await startJob(job);
        summary.push(`  🟢 firing ${REASON_LABELS[platform][reasons[i]]} (${count})`);
      }
    }
    return ctx.editMessageText(`🚀 *mix* вЂ” ${PLATFORMS[platform].label} В· \`${s.target}\` Г— *${s.reportCount}*\n\n${summary.join("\n")}`, { parse_mode: "Markdown", ...backMenu() });
  }

  const job = createJob(userId, platform, s.target, s.targetInfo, s.messageIds, reason, s.reportCount, ctx.chat.id);
  if (getUserJob(userId)?.running) {
    getUserQueue(userId).push({ platform, target: s.target, targetInfo: s.targetInfo, messageIds: s.messageIds, reason, reportCount: s.reportCount, chatId: ctx.chat.id });
    return ctx.editMessageText(`📋 queued вЂ” ${PLATFORMS[platform].label} В· \`${s.target}\` Г— *${s.reportCount}* [${reason}]`, queueMenu());
  }
  markFired(userId);
  await ctx.editMessageText(`🚀 firing вЂ” ${PLATFORMS[platform].label} В· \`${s.target}\` Г— *${s.reportCount}* [${reason}]`, backMenu());
  await startJob(job);
});

bot.action("menu:home", async (ctx) => { await ctx.answerCbQuery(); ctx.editMessageText(`${VOID_HEADER}\n${VOID_TAGLINE}\n\n🐀 pick a platform`, { parse_mode: "Markdown", ...mainMenu() }); });
bot.action("menu:status", async (ctx) => { await ctx.answerCbQuery(); ctx.editMessageText(renderStatus(ctx.from.id), { parse_mode: "Markdown", ...statusMenu() }); });
bot.action("menu:queue", async (ctx) => { await ctx.answerCbQuery(); ctx.editMessageText(renderQueue(ctx.from.id), { parse_mode: "Markdown", ...queueMenu() }); });
bot.action("menu:history", async (ctx) => { await ctx.answerCbQuery(); ctx.editMessageText(renderHistory(ctx.from.id), { parse_mode: "Markdown", ...historyMenu() }); });
bot.action("queue:clear", async (ctx) => { await ctx.answerCbQuery(); getUserQueue(ctx.from.id).length = 0; ctx.editMessageText("🗑️ *your queue cleared*", { parse_mode: "Markdown", ...queueMenu() }); });
bot.action("menu:stop", async (ctx) => { await ctx.answerCbQuery(); const a = getUserJob(ctx.from.id); if (!a || !a.running) return ctx.editMessageText("no job", backMenu()); a.cancel = true; a.running = false; ctx.editMessageText("🛑 *cancelling...*", backMenu()); });
bot.action("menu:reset", async (ctx) => { await ctx.answerCbQuery(); await withLock(() => { tgResetAll(); waReset(ctx.from.id); ttReset(); }); ctx.editMessageText("🔄 *your sessions reset*", backMenu()); });
bot.action("menu:help", async (ctx) => {
  await ctx.answerCbQuery();
  ctx.editMessageText(
    `${VOID_HEADER}\n${VOID_TAGLINE}\n\n` +
      "🎛 *max pressure config:*\n" +
      `⚡ concurrency: *${CFG.defaultConcurrency}*\n` +
      `🌊 wave size: *${CFG.defaultWaveSize}*\n` +
      `⏱ wave cooldown: *${CFG.defaultWaveCooldown}s*\n` +
      `🛋 per-report delay: *${CFG.defaultDelayRange[0]}вЂ“${CFG.defaultDelayRange[1]}s*\n\n` +
      "🕹 *platforms:*\n🔵 telegram В· 🟢 whatsapp В· ⚡ tiktok\n\n" +
      "➕ `/addwa` вЂ” link your whatsapp\n" +
      `⏳ job quota: *${CFG.ownerIds.has(ctx.from.id) ? "∞" : CFG.jobsPerHour}* per hour\n\n` +
      "🧭 *flow:* platform в†’ target в†’ count в†’ reason",
    { parse_mode: "Markdown", ...backMenu() }
  );
});

export { pushStatus };
