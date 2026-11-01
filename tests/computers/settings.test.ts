import { describe, expect, it } from "vitest";
import { computerName, computerSettings } from "../../src/computers/settings.ts";

describe("computer settings", () => {
  it("default to this machine", () => {
    expect(computerSettings({})).toEqual({
      executor: "local",
      dockerImage: null,
      dockerMemory: "2g",
      daytonaTarget: null,
      daytonaSnapshot: null,
      daytonaArchiveMinutes: 60,
    });
  });

  it("read the saved config keys", () => {
    const settings = computerSettings({
      executor: "docker",
      dockerImage: "debian:bookworm-slim",
      dockerMemory: "1g",
      unrelated: true,
    });
    expect(settings.executor).toBe("docker");
    expect(settings.dockerImage).toBe("debian:bookworm-slim");
    expect(settings.dockerMemory).toBe("1g");
  });

  it("need an image for docker and refuse unknown executors", () => {
    expect(() => computerSettings({ executor: "docker" })).toThrow(
      "Running bots in Docker needs an image name",
    );
    expect(() => computerSettings({ executor: "vm" })).toThrow();
    expect(() => computerSettings({ daytonaArchiveMinutes: 0 })).toThrow();
  });

  it("name each bot's computer from the instance and bot", () => {
    expect(computerName("main", "0123456789abcdef")).toBe("bott-bot-main-0123456789ab");
    expect(computerName("Team One/x!", "abc")).toBe("bott-bot-team-one-abc");
  });
});
