import fs from "fs";
import path from "path";

const DATA_DIR = "data";
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

const DB_PATH = path.join(DATA_DIR, "jobs.json");

function load() {
  if (!fs.existsSync(DB_PATH)) return { jobs: [], nextId: 1 };
  try {
    const parsed = JSON.parse(fs.readFileSync(DB_PATH, "utf8"));
    if (!parsed.jobs) parsed.jobs = [];
    if (!parsed.nextId) parsed.nextId = (parsed.jobs[parsed.jobs.length - 1]?.id || 0) + 1;
    return parsed;
  } catch (_) { return { jobs: [], nextId: 1 }; }
}

function save(db) {
  try { fs.writeFileSync(DB_PATH, JSON.stringify(db, null, 2)); } catch (_) {}
}

export function createJobRow(userId, platform, target, reason, extra, count) {
  const db = load();
  const id = db.nextId++;
  db.jobs.push({
    id, user_id: userId, platform, target, reason, extra: extra || "",
    report_count: count, ok: 0, fail: 0, status: "running",
    started_at: Math.floor(Date.now() / 1000), finished_at: null,
  });
  if (db.jobs.length > 500) db.jobs = db.jobs.slice(-500);
  save(db);
  return id;
}

export function finishJobRow(id, ok, fail, status) {
  const db = load();
  const job = db.jobs.find((j) => j.id === id);
  if (job) {
    job.ok = ok; job.fail = fail; job.status = status;
    job.finished_at = Math.floor(Date.now() / 1000);
    save(db);
  }
}

export function recentJobs(userId, limit = 10) {
  const db = load();
  const mine = userId ? db.jobs.filter((j) => j.user_id === userId) : db.jobs;
  return mine.slice(-limit).reverse();
}
