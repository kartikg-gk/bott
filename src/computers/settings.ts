import { z } from "zod";

const schema = z
  .object({
    executor: z.enum(["local", "docker", "daytona"]).default("local"),
    dockerImage: z.string().min(1).nullable().default(null),
    dockerMemory: z.string().min(1).default("2g"),
    daytonaTarget: z.string().min(1).nullable().default(null),
    daytonaSnapshot: z.string().min(1).nullable().default(null),
    daytonaArchiveMinutes: z.number().int().min(1).default(60),
    /** Containers and sandboxes reach the network unless this is closed. */
    sandboxNetwork: z.enum(["open", "closed"]).default("open"),
  })
  .refine((s) => s.executor !== "docker" || s.dockerImage !== null, {
    message: "Running bots in Docker needs an image name",
  });

/** Where bots' commands run and their files live, as saved in the gateway's config. */
export type ComputerSettings = z.infer<typeof schema>;

/** Reads the computer settings from a saved config object; other keys are ignored. */
export function computerSettings(raw: Record<string, unknown>): ComputerSettings {
  const parsed = schema.safeParse(raw);
  if (!parsed.success) throw new Error(parsed.error.issues.map((i) => i.message).join("; "));
  return parsed.data;
}

/** The container or sandbox name for one bot, unique per instance. */
export function computerName(instance: string, botId: string): string {
  const safe = (text: string) => text.toLowerCase().replace(/[^a-z0-9_.-]/g, "-");
  return `bott-bot-${safe(instance.slice(0, 8))}-${safe(botId.slice(0, 12))}`;
}
