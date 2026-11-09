/**
 * Scheduled jobs of the signed-in person.
 *
 * Job: { id, bot, task, spec, nextRun, missed: "run" | "skip", status, running, lastStatus,
 *        lastRun, botName }
 * `when` is "every 30m", "daily 08:00", "at <ISO time>" or "on <event-name>".
 *
 * - GET   /api/jobs   -> { automation: boolean, jobs: Job[], scheduler: { heartbeat, expires } | null }
 * - POST  /api/jobs   { bot, task, when, missed? } -> 201 Job
 * - GET   /api/jobs/:id -> Job & { lastAnswer, wakeups: [{ event, delivery, received, claimed, finished, status }] }
 * - PATCH /api/jobs/:id { bot?, task?, when?, missed? } -> Job; 409 while running or ended
 * - POST  /api/jobs/:id/(pause|resume|cancel) -> Job; 409 when it cannot from where it is
 * - PUT   /api/jobs/automation { enabled: boolean } -> { enabled }
 * - POST  /api/jobs/events { event, delivery } -> 202 { status: "queued" | "duplicate" | "off" | "unknown", accepted }
 */

import { z } from "zod";
import { HttpError } from "../../accounts/http.ts";
import type { Bot } from "../../bots/bots.ts";
import {
  automationEnabled,
  receiveWakeup,
  setAutomation,
  wakeupHistory,
} from "../../schedule/wakeups.ts";
import { parseWhen } from "../../schedule/when.ts";
import { type Job, WEB_CHAT } from "../../store/store.ts";
import type { ApiRouter, Ctx } from "../context.ts";
import { fresh, readJson, readObject } from "../router.ts";

const jobChanges = z
  .object({
    bot: z.string().min(1).max(64),
    task: z.string().min(1).max(16_000),
    when: z.string().min(1).max(80),
    missed: z.enum(["run", "skip"]),
  })
  .partial()
  .strict();

type JobChanges = z.infer<typeof jobChanges>;

async function readChanges(request: Request): Promise<JobChanges> {
  const parsed = jobChanges.safeParse(await readJson(request));
  if (!parsed.success) throw new HttpError(400, "Those job settings are not valid");
  if (Object.values(parsed.data).some((value) => !value.trim())) {
    throw new HttpError(400, "Job settings need some text");
  }
  return parsed.data;
}

/** A job as the page sees it: who it belongs to is left out, its last answer only when asked. */
async function view(ctx: Ctx, job: Job, withAnswer = false): Promise<Record<string, unknown>> {
  const { chat: _c, user: _u, thread: _t, actor: _a, lastAnswer, ...rest } = job;
  const bot = await ctx.gateway.store.bot(job.bot);
  return {
    ...rest,
    ...(withAnswer ? { lastAnswer } : {}),
    botName: bot?.name ?? "Deleted bot",
  };
}

/** The person's own job from the path, or a 404 for anyone else's. */
async function ownJob(ctx: Ctx, raw: string): Promise<Job> {
  const job = raw.length <= 15 ? await ctx.gateway.store.job(Number(raw)) : null;
  if (!job || job.actor !== ctx.actor) throw new HttpError(404, "No such job");
  return job;
}

/** A bot a job may run on: kept, not temporary. */
async function jobBot(ctx: Ctx, id: string): Promise<Bot> {
  const bot = await ctx.gateway.store.bot(id);
  if (!bot || bot.temporary) throw new HttpError(400, "Choose one of your kept bots");
  return bot;
}

function schedule(ctx: Ctx, when: string): { spec: string; first: number | null } {
  try {
    return parseWhen(when, ctx.gateway.store.ctx.clock());
  } catch (error) {
    throw new HttpError(400, (error as Error).message);
  }
}

async function list(ctx: Ctx): Promise<Response> {
  const { store } = ctx.gateway;
  const { db, instance } = store.ctx;
  const lease = await db.query("SELECT heartbeat,expires FROM scheduler_leases WHERE instance=?", [
    instance,
  ]);
  const jobs = [];
  for (const job of await store.jobs({ actor: ctx.actor, history: true })) {
    jobs.push(await view(ctx, job));
  }
  return fresh({
    automation: await automationEnabled(db, instance),
    jobs,
    scheduler: lease[0]
      ? { heartbeat: Number(lease[0].heartbeat), expires: Number(lease[0].expires) }
      : null,
  });
}

async function create(ctx: Ctx, request: Request): Promise<Response> {
  const values = await readChanges(request);
  if (!values.bot || !values.when || !values.task) {
    throw new HttpError(400, "A job needs a bot, a time and a task");
  }
  const bot = await jobBot(ctx, values.bot);
  const { store } = ctx.gateway;
  const route = await store.conversation(WEB_CHAT, ctx.actor);
  const { spec, first } = schedule(ctx, values.when);
  let id: number;
  try {
    id = await store.addJob({
      chat: route.chat,
      user: route.user,
      actor: ctx.actor,
      thread: route.thread,
      bot: bot.id,
      task: values.task.trim(),
      spec,
      first,
      missed: values.missed ?? "run",
    });
  } catch (error) {
    throw new HttpError(400, (error as Error).message);
  }
  return fresh(await view(ctx, (await store.job(id)) as Job), 201);
}

async function edit(ctx: Ctx, request: Request, params: Record<string, string>) {
  const values = await readChanges(request);
  const job = await ownJob(ctx, params.job as string);
  const bot = await jobBot(ctx, values.bot ?? job.bot);
  const timing = values.when === undefined ? {} : schedule(ctx, values.when);
  const { store } = ctx.gateway;
  const changed = await store.editJob(job.id, ctx.actor, {
    bot: bot.id,
    task: (values.task ?? job.task).trim(),
    missed: values.missed ?? job.missed,
    ...timing,
  });
  if (!changed) throw new HttpError(409, "This job is running or has ended, so it cannot change");
  return fresh(await view(ctx, (await store.job(job.id)) as Job));
}

async function changeStatus(ctx: Ctx, _request: Request, params: Record<string, string>) {
  const job = await ownJob(ctx, params.job as string);
  const { store } = ctx.gateway;
  const action = params.action as "pause" | "resume" | "cancel";
  const changed =
    action === "cancel"
      ? await store.cancelJob(job.id, ctx.actor)
      : await store.setJobPaused(job.id, ctx.actor, action === "pause");
  if (!changed) throw new HttpError(409, `This job cannot ${action} from where it is now`);
  return fresh(await view(ctx, (await store.job(job.id)) as Job));
}

async function automation(ctx: Ctx, request: Request): Promise<Response> {
  const body = await readJson(request).catch(() => null);
  const keys = typeof body === "object" && body !== null ? Object.keys(body) : [];
  const enabled = (body as { enabled?: unknown } | null)?.enabled;
  if (keys.length !== 1 || typeof enabled !== "boolean") {
    throw new HttpError(400, "Send enabled as true or false, and nothing else");
  }
  const { db, instance } = ctx.gateway.store.ctx;
  await setAutomation(db, instance, enabled);
  return fresh({ enabled });
}

async function wake(ctx: Ctx, request: Request): Promise<Response> {
  const body = await readObject(request, "Send an event name and a delivery id");
  const keys = Object.keys(body).sort().join(",");
  if (keys !== "delivery,event") throw new HttpError(400, "Send an event name and a delivery id");
  const { db, instance, clock } = ctx.gateway.store.ctx;
  let status: string;
  try {
    status = await receiveWakeup(
      db,
      instance,
      ctx.actor,
      body.event as string,
      body.delivery as string,
      clock(),
    );
  } catch (error) {
    const message = (error as Error).message;
    throw new HttpError(/full/.test(message) ? 409 : 400, message);
  }
  return fresh({ status, accepted: status === "queued" }, 202);
}

export function jobRoutes(router: ApiRouter): void {
  const one = "/api/jobs/:job(\\d+)";
  router
    .add("GET", "/api/jobs", list)
    .add("POST", "/api/jobs", create)
    .add("PUT", "/api/jobs/automation", automation)
    .add("POST", "/api/jobs/events", wake)
    .add("GET", one, async (ctx, _r, params) => {
      const job = await ownJob(ctx, params.job as string);
      const { db, instance } = ctx.gateway.store.ctx;
      return fresh({
        ...(await view(ctx, job, true)),
        wakeups: await wakeupHistory(db, instance, job.id),
      });
    })
    .add("PATCH", one, edit)
    .add("POST", `${one}/:action(pause|resume|cancel)`, changeStatus);
}
