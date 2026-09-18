import { Semaphore, sleep } from "./state.js";
import { runTgWave } from "./telegram.js";
import { runWaWave } from "./whatsapp.js";
import { runTtWave } from "./tiktok.js";
import { createJobRow, finishJobRow } from "./db.js";
import { log } from "./logger.js";

const RUNNERS = { telegram: runTgWave, whatsapp: runWaWave, tiktok: runTtWave };

export async function runJob(job, pushStatus) {
  const sem = new Semaphore(job.concurrency);
  const dbId = createJobRow(job.userId, job.platform, job.target, job.reason, (job.messageIds || []).join(","), job.reportCount);
  job.dbId = dbId;

  await pushStatus(job, "started");
  log.job(`started вЂ” u${job.userId} В· ${job.platform} В· ${job.reportCount} on ${job.target} [${job.reason}]`);

  const runWave = RUNNERS[job.platform];
  if (!runWave) { await pushStatus(job, "unknown platform"); job.running = false; return; }

  while (job.running && !job.cancel) {
    if (job.reportsDone >= job.reportCount) break;
    if (job.reportsDone + job.fail >= job.reportCount * 3) { await pushStatus(job, "too many failures"); break; }
    await runWave(job, sem);
    if (job.reportsDone < job.reportCount && !job.cancel) await sleep(job.waveCooldown * 1000);
  }

  job.running = false;
  const status = job.cancel ? "cancelled" : "finished";
  finishJobRow(dbId, job.ok, job.fail, status);
  await pushStatus(job, status);
  log.job(`done вЂ” ${job.reportsDone}/${job.reportCount} ok, ${job.fail} fail`);
}
