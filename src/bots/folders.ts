/**
 * A hosted deployment has no disk that outlives a request, so there the database is where a
 * bot's notes (`bot_memory`) and skill packages (`skill_files`) really live, and the folders are
 * copies made for the moment. `fill` lays the stored copy into the folders before anything reads
 * them; `keep` stores the folders after anything changed them. Skills every bot shares use the
 * scope "". On this machine the folders are the real thing and both calls leave them alone.
 */

import { createHash } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmdirSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import type { Store } from "../store/store.ts";
import { type Bot, botRoot, MEMORY_FILES } from "./bots.ts";

interface Places {
  /** The notes folder; the shared scope has none. */
  notes: string | null;
  skills: string;
  scope: string;
}

/** A stored path piece that stays inside its folder. */
const safePiece = (piece: string) =>
  piece !== "" && piece !== "." && piece !== ".." && !/[\\/:\0]/.test(piece);

const revision = (text: string) => createHash("sha256").update(text, "utf8").digest("hex");

/** Every plain file under `dir`, as [skill, path inside the skill]; links are passed over. */
function skillFiles(dir: string): [string, string][] {
  const found: [string, string][] = [];
  const walk = (folder: string, parts: string[]) => {
    for (const entry of readdirSync(folder, { withFileTypes: true })) {
      if (entry.isSymbolicLink()) continue;
      const next = [...parts, entry.name];
      if (entry.isDirectory()) walk(join(folder, entry.name), next);
      else if (entry.isFile() && next.length > 1) {
        found.push([next[0] as string, next.slice(1).join("/")]);
      }
    }
  };
  if (existsSync(dir)) walk(dir, []);
  return found;
}

/** Removes the empty folders under `dir`, deepest first, leaving `dir` itself. */
function pruneEmpty(dir: string): void {
  if (!existsSync(dir)) return;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const path = join(dir, entry.name);
    pruneEmpty(path);
    if (readdirSync(path).length === 0) rmdirSync(path);
  }
}

export class FolderMirror {
  constructor(
    private readonly store: Store,
    private readonly stateDir: string,
    readonly hosted: boolean,
  ) {}

  private places(bot: Pick<Bot, "id"> | null): Places {
    if (!bot) return { notes: null, skills: join(this.stateDir, "skills"), scope: "" };
    const root = botRoot(this.stateDir, bot);
    return { notes: join(root, "memory"), skills: join(root, "skills"), scope: bot.id };
  }

  /** Writes the stored notes and skill files into the bot's folders (or the shared one). */
  async fill(bot: Pick<Bot, "id"> | null): Promise<void> {
    if (!this.hosted) return;
    const { db, instance } = this.store.ctx;
    const { notes, skills, scope } = this.places(bot);
    if (notes !== null) {
      mkdirSync(notes, { recursive: true });
      const stored = await db.query(
        "SELECT file,content FROM bot_memory WHERE instance=? AND bot=?",
        [instance, scope],
      );
      for (const row of stored) {
        const file = String(row.file);
        if ((MEMORY_FILES as readonly string[]).includes(file)) {
          writeFileSync(join(notes, file), String(row.content), "utf8");
        }
      }
    }
    const rows = await db.query(
      "SELECT skill,path,content FROM skill_files WHERE instance=? AND scope=?",
      [instance, scope],
    );
    const wanted = new Map<string, { parts: string[]; content: string }>();
    for (const row of rows) {
      const parts = [String(row.skill), ...String(row.path).split("/")];
      if (parts.every(safePiece)) {
        wanted.set(parts.join("/"), { parts, content: String(row.content) });
      }
    }
    for (const [skill, path] of skillFiles(skills)) {
      if (!wanted.has(`${skill}/${path}`)) unlinkSync(join(skills, skill, ...path.split("/")));
    }
    for (const { parts, content } of wanted.values()) {
      const target = join(skills, ...parts);
      mkdirSync(dirname(target), { recursive: true });
      if (existsSync(target) && lstatSync(target).isSymbolicLink()) unlinkSync(target);
      writeFileSync(target, content, "utf8");
    }
    pruneEmpty(skills);
  }

  /** Stores the bot's folders (or the shared one), dropping skill files no longer there. */
  async keep(bot: Pick<Bot, "id"> | null): Promise<void> {
    if (!this.hosted) return;
    const { db, instance, clock } = this.store.ctx;
    const { notes, skills, scope } = this.places(bot);
    if (notes !== null) {
      const now = clock();
      for (const file of MEMORY_FILES) {
        const path = join(notes, file);
        if (!existsSync(path)) continue;
        await db.run(
          "INSERT INTO bot_memory(instance,bot,file,content,updated) VALUES(?,?,?,?,?) " +
            "ON CONFLICT(instance,bot,file) DO UPDATE SET content=excluded.content," +
            "updated=excluded.updated",
          [instance, scope, file, readFileSync(path, "utf8"), now],
        );
      }
    }
    const present = new Set<string>();
    for (const [skill, path] of skillFiles(skills)) {
      const content = readFileSync(join(skills, skill, ...path.split("/")), "utf8");
      present.add(`${skill}/${path}`);
      await db.run(
        "INSERT INTO skill_files(instance,scope,skill,path,content,revision) " +
          "VALUES(?,?,?,?,?,?) ON CONFLICT(instance,scope,skill,path) " +
          "DO UPDATE SET content=excluded.content,revision=excluded.revision",
        [instance, scope, skill, path, content, revision(content)],
      );
    }
    const stored = await db.query(
      "SELECT skill,path FROM skill_files WHERE instance=? AND scope=?",
      [instance, scope],
    );
    for (const row of stored) {
      if (present.has(`${row.skill}/${row.path}`)) continue;
      await db.run("DELETE FROM skill_files WHERE instance=? AND scope=? AND skill=? AND path=?", [
        instance,
        scope,
        String(row.skill),
        String(row.path),
      ]);
    }
  }
}
