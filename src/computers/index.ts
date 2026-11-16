import { localWorkspace, type Workspace } from "../agent/tools/workspace.ts";
import type { Bot } from "../bots/bots.ts";
import { daytonaComputer } from "./daytona.ts";
import { dockerComputer } from "./docker.ts";
import { type ComputerSettings, computerName } from "./settings.ts";

/** What a bot's computer is made from. */
export interface ComputerPlace {
  instance: string;
  bot: Pick<Bot, "id" | "chief">;
  /** The bot's workspace folder on this machine. */
  hostRoot: string;
  /** The bot's memory notes on this machine. */
  memoryDir: string;
}

export type ComputerFactory = (settings: ComputerSettings, place: ComputerPlace) => Workspace;

/** Makes the computer the settings name: this machine, a container, or a remote sandbox. */
export const makeComputer: ComputerFactory = (settings, place) => {
  const name = computerName(place.instance, place.bot.id);
  switch (settings.executor) {
    case "docker":
      return dockerComputer({
        name,
        image: settings.dockerImage as string,
        memory: settings.dockerMemory,
        hostRoot: place.hostRoot,
        memoryDir: place.memoryDir,
        network: settings.sandboxNetwork,
      });
    case "daytona":
      return daytonaComputer({
        name,
        instance: place.instance,
        memoryDir: place.memoryDir,
        snapshot: settings.daytonaSnapshot,
        target: settings.daytonaTarget,
        archiveMinutes: settings.daytonaArchiveMinutes,
        network: settings.sandboxNetwork,
      });
    default:
      return { ...localWorkspace(place.hostRoot), memoryPath: place.memoryDir };
  }
};
