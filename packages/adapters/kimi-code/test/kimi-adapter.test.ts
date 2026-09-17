import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { harnessInspectionSchema } from "@codexhost/shared-contracts";

import {
  KimiAdapter,
  type KimiAcpTransportLike,
} from "../src/kimi-adapter.js";
import { KimiExecutableError } from "../src/command.js";
import { KimiTransportError } from "../src/acp-transport.js";
import { encodeKimiModelRef } from "../src/models.js";

class FakeTransport implements KimiAcpTransportLike {
  sessionId: string | null = "session-fake";
  isClosed = false;
  authReady = true;
  initVersion = 1;
  configOptionsSet: Array<{ configId: string; value: string }> = [];
  openKinds: string[] = [];

  setActivePromptHandler = vi.fn();
  inspect = vi.fn(async () => ({
    initialize: { protocolVersion: this.initVersion } as any,
    authReady: this.authReady,
  }));
  openSession = vi.fn(async (input: { kind: string; sessionId?: string; cwd?: string }) => {
    this.openKinds.push(input.kind);
    return {
      sessionId: input.sessionId || "session-created",
      configOptions: [],
    };
  });
  setConfigOption = vi.fn(async (configId: string, value: string) => {
    this.configOptionsSet.push({ configId, value });
    return [];
  });
  prompt = vi.fn();
  cancel = vi.fn();
  close = vi.fn(async () => {
    this.isClosed = true;
  });
}

describe("KimiAdapter", () => {
  let tempDir: string;
  let fakeTransport: FakeTransport;

  beforeEach(async () => {
    tempDir = await mkdtemp(path.join(os.tmpdir(), "kimi-adapter-test-"));
    fakeTransport = new FakeTransport();
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true }).catch(() => undefined);
  });

  it("exposes harnessId 'kimi-code'", () => {
    const adapter = new KimiAdapter();
    expect(adapter.harnessId).toBe("kimi-code");
  });

  describe("inspect()", () => {
    it("returns notInstalled when executable cannot be resolved", async () => {
      const adapter = new KimiAdapter(
        {},
        {
          resolveExecutable: () => {
            throw new KimiExecutableError("CLI not found");
          },
        },
      );

      const inspection = await adapter.inspect();
      expect(inspection.status).toBe("notInstalled");
      if (inspection.status === "notInstalled") {
        expect(inspection.error?.code).toBe("notInstalled");
      }
      expect(harnessInspectionSchema.parse(inspection)).toBeDefined();
    });

    it("returns error with authenticationRequired when authReady is false", async () => {
      fakeTransport.authReady = false;
      const adapter = new KimiAdapter(
        { homeDirectory: tempDir },
        {
          resolveExecutable: () => "kimi",
          createTransport: () => fakeTransport,
        },
      );

      const inspection = await adapter.inspect();
      expect(inspection.status).toBe("error");
      if (inspection.status === "error") {
        expect(inspection.error?.code).toBe("authenticationRequired");
      }
      expect(harnessInspectionSchema.parse(inspection)).toBeDefined();
    });

    it("returns unavailable when transport handshake throws", async () => {
      fakeTransport.inspect = vi.fn(async () => {
        throw new KimiTransportError("unavailable", "Connection refused");
      });

      const adapter = new KimiAdapter(
        { homeDirectory: tempDir },
        {
          resolveExecutable: () => "kimi",
          createTransport: () => fakeTransport,
        },
      );

      const inspection = await adapter.inspect();
      expect(inspection.status).toBe("unavailable");
      if (inspection.status === "unavailable") {
        expect(inspection.error?.code).toBe("unavailable");
      }
      expect(harnessInspectionSchema.parse(inspection)).toBeDefined();
    });

    it("returns ready with catalog and capabilities when installed and configured", async () => {
      // Create config.toml
      const configToml = `
default_model = "relay"

[models.relay]
model = "claude-sonnet-5"
provider = "bedrock"

[thinking]
enabled = true
effort = "medium"
`;
      await mkdir(path.join(tempDir, ".kimi-code"), { recursive: true });
      await writeFile(path.join(tempDir, ".kimi-code", "config.toml"), configToml, "utf8");

      const adapter = new KimiAdapter(
        { homeDirectory: tempDir },
        {
          resolveExecutable: () => "kimi",
          createTransport: () => fakeTransport,
        },
      );

      const inspection = await adapter.inspect();
      expect(inspection.status).toBe("ready");
      if (inspection.status === "ready") {
        expect(inspection.catalog.models).toHaveLength(1);
        expect(inspection.catalog.defaultThinkingOptionId).toBe("medium");
        expect(inspection.capabilities.configuration.selectModel).toBe(true);
        expect(inspection.permissionModes?.defaultModeId).toBe("default");
      }

      const validated = harnessInspectionSchema.parse(inspection);
      expect(validated.status).toBe("ready");

      // Verifies caching behavior
      const second = await adapter.inspect({ refresh: false });
      expect(second).toBe(inspection);
      expect(fakeTransport.inspect).toHaveBeenCalledTimes(1);
    });
  });

  describe("open()", () => {
    it("rejects fork with typed unsupported error", async () => {
      const adapter = new KimiAdapter();
      const result = await adapter.open({
        kind: "fork",
        sourceRef: { formatVersion: 1, harnessId: "kimi-code" as any, nativeSessionId: "s-1" as any },
        checkpoint: { nativeSessionId: "s-1", checkpointKey: "cp-1" } as any,
        cwd: tempDir,
      });

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe("unsupported");
        expect(result.error.message).toContain("fork");
      }
    });

    it("rejects rollbackLastTurn with typed unsupported error", async () => {
      const adapter = new KimiAdapter();
      const result = await adapter.open({
        kind: "rollbackLastTurn",
        sourceRef: { formatVersion: 1, harnessId: "kimi-code" as any, nativeSessionId: "s-1" as any },
        cwd: tempDir,
      });

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe("unsupported");
        expect(result.error.message).toContain("rollbackLastTurn");
      }
    });

    it("creates new session and applies options", async () => {
      const adapter = new KimiAdapter(
        { homeDirectory: tempDir },
        {
          resolveExecutable: () => "kimi",
          createTransport: () => fakeTransport,
        },
      );

      const result = await adapter.open({
        kind: "create",
        cwd: tempDir,
        model: encodeKimiModelRef("relay"),
        thinkingOptionId: "high" as any,
        permissionModeId: "yolo" as any,
      });

      expect(result.ok).toBe(true);
      if (result.ok) {
        const session = result.value;
        expect(session.harnessId).toBe("kimi-code");
        expect(session.initialState.effectiveModel?.id).toBe(encodeKimiModelRef("relay").id);
        expect(session.initialState.effectiveThinkingOptionId).toBe("high");
        expect(session.initialState.effectivePermissionModeId).toBe("yolo");
      }

      expect(fakeTransport.openKinds).toContain("create");
      expect(fakeTransport.configOptionsSet).toEqual(
        expect.arrayContaining([
          { configId: "model", value: "relay" },
          { configId: "thinking", value: "high" },
          { configId: "mode", value: "yolo" },
        ]),
      );
    });

    it("resumes existing session when native files exist", async () => {
      const sessionId = "session-to-resume";
      const sessionDir = path.join(tempDir, ".kimi-code", "sessions", sessionId);
      await mkdir(path.join(sessionDir, "agents", "main"), { recursive: true });
      await writeFile(
        path.join(tempDir, ".kimi-code", "session_index.jsonl"),
        JSON.stringify({ sessionId, sessionDir }) + "\n",
      );
      await writeFile(
        path.join(sessionDir, "state.json"),
        JSON.stringify({ id: sessionId, version: 2, cwd: tempDir }),
      );

      const adapter = new KimiAdapter(
        { homeDirectory: tempDir },
        {
          resolveExecutable: () => "kimi",
          createTransport: () => fakeTransport,
        },
      );

      const result = await adapter.open({
        kind: "resume",
        nativeRef: {
          formatVersion: 1,
          harnessId: "kimi-code" as any,
          nativeSessionId: sessionId,
        },
        cwd: tempDir,
      });

      expect(result.ok).toBe(true);
      expect(fakeTransport.openKinds).toContain("load");
    });

    it("returns sessionNotFound when resuming non-existent session", async () => {
      await mkdir(path.join(tempDir, ".kimi-code"), { recursive: true });
      await writeFile(path.join(tempDir, ".kimi-code", "session_index.jsonl"), "");

      const adapter = new KimiAdapter(
        { homeDirectory: tempDir },
        {
          resolveExecutable: () => "kimi",
          createTransport: () => fakeTransport,
        },
      );

      const result = await adapter.open({
        kind: "resume",
        nativeRef: {
          formatVersion: 1,
          harnessId: "kimi-code" as any,
          nativeSessionId: "missing-session",
        },
        cwd: tempDir,
      });

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe("sessionNotFound");
      }
    });

    it("rejects open when adapter is closed", async () => {
      const adapter = new KimiAdapter();
      await adapter.close();

      const result = await adapter.open({
        kind: "create",
        cwd: tempDir,
      });

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe("invalidState");
      }
    });

    it("closes all created sessions on adapter.close()", async () => {
      const adapter = new KimiAdapter(
        { homeDirectory: tempDir },
        {
          resolveExecutable: () => "kimi",
          createTransport: () => fakeTransport,
        },
      );

      const result = await adapter.open({
        kind: "create",
        cwd: tempDir,
      });

      expect(result.ok).toBe(true);
      await adapter.close();
      expect(fakeTransport.close).toHaveBeenCalled();
    });
  });
});
