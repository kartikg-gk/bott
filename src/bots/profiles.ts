import type { Store } from "../store/store.js";

export const STYLES = {
  direct: "Keep answers short, plain and specific.",
  thoughtful: "Take time to explain reasoning and weigh other options.",
  upbeat: "Sound warm and lively but stay exact about facts.",
  custom: "",
} as const;

export const SHAPES = ["orb", "diamond", "square"] as const;

export interface Profile {
  style: string;
  voice: string;
  color: string;
  shape: string;
  greeting: string | null;
}

export type ProfileValues = Partial<Omit<Profile, "greeting">>;

export function validateProfile(p: Omit<Profile, "greeting">): void {
  if (!Object.hasOwn(STYLES, p.style))
    throw new Error("Pick a supported speaking style from the list");
  if (typeof p.voice !== "string" || p.voice.length > 2000) {
    throw new Error("Voice notes are limited to at most 2000 characters");
  }
  if (typeof p.color !== "string" || !/^#[0-9a-fA-F]{6}$/.test(p.color)) {
    throw new Error("Give a color as six hexadecimal digits");
  }
  if (!(SHAPES as readonly string[]).includes(p.shape)) {
    throw new Error("Pick one of the avatar shapes offered");
  }
}

export async function profile(store: Store, botId: string): Promise<Profile> {
  const { db, instance } = store.ctx;
  const rows = await db.query(
    "SELECT style,voice,color,shape,greeting FROM bot_profiles WHERE instance=? AND bot=?",
    [instance, botId],
  );
  const row = rows[0];
  if (!row) {
    return {
      style: "direct",
      voice: "",
      color: `#${botId.slice(0, 6)}`,
      shape: "orb",
      greeting: null,
    };
  }
  return {
    style: String(row.style),
    voice: String(row.voice),
    color: String(row.color),
    shape: String(row.shape),
    greeting: row.greeting === null || row.greeting === undefined ? null : String(row.greeting),
  };
}

/** Applies the given values over the current profile, checks the result, and clears the greeting. */
export async function saveProfile(
  store: Store,
  botId: string,
  values: ProfileValues,
): Promise<Profile> {
  const current = await profile(store, botId);
  const next = { ...current };
  for (const key of ["style", "voice", "color", "shape"] as const) {
    const value = values[key];
    if (value !== undefined) next[key] = value;
  }
  validateProfile(next);
  const { db, instance } = store.ctx;
  await db.run(
    "INSERT INTO bot_profiles VALUES(?,?,?,?,?,?,NULL) " +
      "ON CONFLICT(instance,bot) DO UPDATE SET style=excluded.style,voice=excluded.voice," +
      "color=excluded.color,shape=excluded.shape,greeting=NULL",
    [instance, botId, next.style, next.voice, next.color, next.shape],
  );
  return { ...next, greeting: null };
}

export async function rememberSession(
  store: Store,
  botId: string,
  state: { sessionFile?: string | null },
): Promise<void> {
  const { db, instance } = store.ctx;
  await db.run(
    "INSERT INTO bot_sessions VALUES(?,?,?) ON CONFLICT(instance,bot) " +
      "DO UPDATE SET session_file=excluded.session_file",
    [instance, botId, state.sessionFile ?? null],
  );
}

export async function savedSession(store: Store, botId: string): Promise<string | null> {
  const { db, instance } = store.ctx;
  const rows = await db.query("SELECT session_file FROM bot_sessions WHERE instance=? AND bot=?", [
    instance,
    botId,
  ]);
  const file = rows[0]?.session_file;
  return file === null || file === undefined ? null : String(file);
}

export async function recordChat(
  store: Store,
  botId: string,
  role: string,
  text: string,
): Promise<void> {
  const { db, instance } = store.ctx;
  await db.run("INSERT INTO bot_chat(instance,bot,role,text) VALUES(?,?,?,?)", [
    instance,
    botId,
    role,
    text,
  ]);
}
