import { expect, it } from "vitest";

it("loads the entry module", async () => {
  await expect(import("../src/index.ts")).resolves.toBeDefined();
});
