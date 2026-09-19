import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { RuntimeLogger } from "../src/runtime-logger.js";

const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("RuntimeLogger", () => {
  it("writes redacted structured diagnostics under the data directory", () => {
    const dataDirectory = mkdtempSync(path.join(os.tmpdir(), "codexhost-runtime-log-"));
    directories.push(dataDirectory);
    const logger = new RuntimeLogger({ CODEXHOST_DATA_DIR: dataDirectory });

    logger.write({
      level: "error",
      event: "external.turn.identity.persist_failed",
      message: "Authorization: Bearer private-token",
      fields: { hostThreadId: "thread-1", accessToken: "private-token" },
    });

    const entry = JSON.parse(readFileSync(logger.filePath, "utf8")) as Record<string, unknown>;
    expect(entry).toMatchObject({
      level: "error",
      event: "external.turn.identity.persist_failed",
      hostThreadId: "thread-1",
      accessToken: "[redacted]",
    });
    expect(JSON.stringify(entry)).not.toContain("private-token");
  });
});
