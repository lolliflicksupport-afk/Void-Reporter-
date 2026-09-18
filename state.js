import { CFG } from "./config.js";

export class SessionState {
  constructor(cfg) {
    this.name = cfg.name;
    this.cfg = cfg;
    this.floodUntil = 0;
    this.dead = false;
    this.ok = 0;
    this.failed = 0;
    this.lastStatus = "init";
  }
}

export const TG_STATE = new Map();
for (const s of CFG.tgSessions) TG_STATE.set(s.name, new SessionState(s));

export const USER_JOBS = new Map();
export const USER_QUEUES = new Map();
export const USER_RATE = new Map();

export function getUserJob(userId) { return USER_JOBS.get(userId) || null; }
export function setUserJob(userId, job) { if (job) USER_JOBS.set(userId, job); else USER_JOBS.delete(userId); }
export function getUserQueue(userId) { if (!USER_QUEUES.has(userId)) USER_QUEUES.set(userId, []); return USER_QUEUES.get(userId); }

export function canFire(userId) {
  if (CFG.ownerIds.has(userId)) return true;
  const now = Date.now();
  const window = 60 * 60 * 1000;
  let arr = USER_RATE.get(userId) || [];
  arr = arr.filter((t) => now - t < window);
  USER_RATE.set(userId, arr);
  return arr.length < CFG.jobsPerHour;
}

export function markFired(userId) {
  if (CFG.ownerIds.has(userId)) return;
  const arr = USER_RATE.get(userId) || [];
  arr.push(Date.now());
  USER_RATE.set(userId, arr);
}

export function rateRemaining(userId) {
  if (CFG.ownerIds.has(userId)) return "unlimited";
  const now = Date.now();
  const window = 60 * 60 * 1000;
  const arr = (USER_RATE.get(userId) || []).filter((t) => now - t < window);
  return Math.max(0, CFG.jobsPerHour - arr.length);
}

let lockChain = Promise.resolve();
export function withLock(fn) {
  const next = lockChain.then(fn, fn);
  lockChain = next.catch(() => {});
  return next;
}

export class Semaphore {
  constructor(n) { this.n = n; this.queue = []; }
  acquire() {
    if (this.n > 0) { this.n--; return Promise.resolve(); }
    return new Promise((res) => this.queue.push(res));
  }
  release() {
    if (this.queue.length) this.queue.shift()();
    else this.n++;
  }
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export const rand = (min, max) => Math.random() * (max - min) + min;
export function liveTgSessions() {
  const now = Date.now() / 1000;
  return [...TG_STATE.values()].filter((s) => !s.dead && s.floodUntil < now);
    }
