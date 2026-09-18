import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { InitializeResponse } from "@agentclientprotocol/sdk";
import {
  harnessCommandCatalogSchema,
  harnessIdSchema,
  harnessInspectionSchema,
  harnessPermissionModeIdSchema,
  harnessThinkingOptionIdSchema,
  nativeSessionRefSchema,
} from "@codexhost/shared-contracts";

import {
  KimiAdapter,
  type KimiAcpTransportLike,
} from "../src/kimi-adapter.js";
import { KimiExecutableError } from "../src/command.js";
import { KimiTransportError } from "../src/acp-transport.js";
import type { SessionEventHandler } from "../src/acp-transport.js";
import { encodeKimiModelRef } from "../src/models.js";

class FakeTransport implements KimiAcpTransportLike {
  sessionId: string | null = "session-fake";
  isClosed = false;
  authReady = true;
  initVersion = 1;
  configOptionsSet: Array<{ configId: string; value: string }> = [];
  currentConfig = { model: "relay", thinking: "medium", mode: "default" };
  openKinds: string[] = [];

  setActivePromptHandler = vi.fn();
  sessionEventHandler: SessionEventHandler | null = null;
  pendingSessionEvents: Parameters<SessionEventHandler>[0][] = [];
  setSessionEventHandler(handler: SessionEventHandler | null) {
    this.sessionEventHandler = handler;
    if (handler) for (const event of this.pendingSessionEvents.splice(0)) handler(event);
  }
  inspect = vi.fn(async () => ({
    initialize: { protocolVersion: this.initVersion } as InitializeResponse,
    authReady: this.authReady,
  }));
  openSession = vi.fn(async (input: { kind: string; sessionId?: string; cwd?: string }) => {
    this.openKinds.push(input.kind);
    this.pendingSessionEvents.push({
      type: "commands.update",
      commands: [{ name: "compact", description: "Compact the current session", input: { hint: "instructions" } }],
    });
    return {
      sessionId: input.kind === "fork" ? "session-forked-123" : (input.sessionId || "session-created"),
      configOptions: this.configOptions(),
    };
  });
  setConfigOption = vi.fn(async (configId: string, value: string) => {
    this.configOptionsSet.push({ configId, value });
    this.currentConfig[configId as keyof typeof this.currentConfig] = value;
    return this.configOptions();
  });
  configOptions() {
    return Object.entries(this.currentConfig).map(([id, currentValue]) => ({ id, currentValue }));
  }
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
    it("forks existing session and returns distinct native session", async () => {
      const sessionId = "s-1";
      const sessionDir = path.join(tempDir, ".kimi-code", "sessions", sessionId);
      await mkdir(path.join(sessionDir, "agents", "main"), { recursive: true });
      await writeFile(
        path.join(tempDir, ".kimi-code", "session_index.jsonl"),
        JSON.stringify({ sessionId, sessionDir, workDir: tempDir }) + "\n",
        "utf8",
      );
      await writeFile(
        path.join(sessionDir, "state.json"),
        JSON.stringify({ id: sessionId, version: 2, cwd: tempDir }),
        "utf8",
      );

      const adapter = new KimiAdapter(
        { homeDirectory: tempDir },
        {
          resolveExecutable: () => "kimi",
          createTransport: () => fakeTransport,
        },
      );

      const result = await adapter.open({
        kind: "fork",
        sourceRef: { formatVersion: 1, harnessId: harnessIdSchema.parse("kimi-code"), nativeSessionId: sessionId },
        checkpoint: { formatVersion: 1, harnessId: harnessIdSchema.parse("kimi-code"), nativeSessionId: sessionId, checkpointId: "turn:0" },
        cwd: tempDir,
      });

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.initialState.nativeRef?.nativeSessionId).toBe("session-forked-123");
        expect(fakeTransport.openKinds).toContain("fork");
      }
    });

    it("rejects fork when source session does not exist", async () => {
      const adapter = new KimiAdapter(
        { homeDirectory: tempDir },
        {
          resolveExecutable: () => "kimi",
          createTransport: () => fakeTransport,
        },
      );
      const result = await adapter.open({
        kind: "fork",
        sourceRef: { formatVersion: 1, harnessId: harnessIdSchema.parse("kimi-code"), nativeSessionId: "non-existent" },
        checkpoint: { formatVersion: 1, harnessId: harnessIdSchema.parse("kimi-code"), nativeSessionId: "non-existent", checkpointId: "turn:0" },
        cwd: tempDir,
      });

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe("sessionNotFound");
      }
    });

    it("rejects fork when checkpoint does not belong to source session", async () => {
      const sessionId = "s-checkpoint-test";
      const sessionDir = path.join(tempDir, ".kimi-code", "sessions", sessionId);
      await mkdir(path.join(sessionDir, "agents", "main"), { recursive: true });
      await writeFile(
        path.join(tempDir, ".kimi-code", "session_index.jsonl"),
        JSON.stringify({ sessionId, sessionDir, workDir: tempDir }) + "\n",
        "utf8",
      );
      await writeFile(
        path.join(sessionDir, "state.json"),
        JSON.stringify({ id: sessionId, version: 2, cwd: tempDir }),
        "utf8",
      );

      const adapter = new KimiAdapter(
        { homeDirectory: tempDir },
        {
          resolveExecutable: () => "kimi",
          createTransport: () => fakeTransport,
        },
      );
      const result = await adapter.open({
        kind: "fork",
        sourceRef: { formatVersion: 1, harnessId: harnessIdSchema.parse("kimi-code"), nativeSessionId: sessionId },
        checkpoint: { formatVersion: 1, harnessId: harnessIdSchema.parse("kimi-code"), nativeSessionId: "other-session", checkpointId: "turn:0" },
        cwd: tempDir,
      });

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe("checkpointNotFound");
      }
    });

    it("rejects fork across different working directory", async () => {
      const sessionId = "s-cross-cwd";
      const sessionDir = path.join(tempDir, ".kimi-code", "sessions", sessionId);
      await mkdir(path.join(sessionDir, "agents", "main"), { recursive: true });
      await writeFile(
        path.join(tempDir, ".kimi-code", "session_index.jsonl"),
        JSON.stringify({ sessionId, sessionDir, workDir: tempDir }) + "\n",
        "utf8",
      );
      await writeFile(
        path.join(sessionDir, "state.json"),
        JSON.stringify({ id: sessionId, version: 2, cwd: tempDir }),
        "utf8",
      );

      const adapter = new KimiAdapter(
        { homeDirectory: tempDir },
        {
          resolveExecutable: () => "kimi",
          createTransport: () => fakeTransport,
        },
      );
      const otherCwd = path.join(tempDir, "other-worktree");
      await mkdir(otherCwd, { recursive: true });

      const result = await adapter.open({
        kind: "fork",
        sourceRef: { formatVersion: 1, harnessId: harnessIdSchema.parse("kimi-code"), nativeSessionId: sessionId },
        checkpoint: { formatVersion: 1, harnessId: harnessIdSchema.parse("kimi-code"), nativeSessionId: sessionId, checkpointId: "turn:0" },
        cwd: otherCwd,
      });

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe("unsupported");
        expect(result.error.message).toContain("different working directories");
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
        thinkingOptionId: harnessThinkingOptionIdSchema.parse("high"),
        permissionModeId: harnessPermissionModeIdSchema.parse("yolo"),
      });

      expect(result.ok).toBe(true);
      if (result.ok) {
        const session = result.value;
        expect(session.harnessId).toBe("kimi-code");
        expect(nativeSessionRefSchema.parse(session.initialState.nativeRef)).toEqual({
          formatVersion: 1,
          harnessId: "kimi-code",
          nativeSessionId: "session-created",
          locator: { cwd: tempDir },
        });
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
      if (result.ok) {
        const commands = await result.value.commands?.list();
        expect(commands?.ok && commands.value.commands).toEqual([{
          id: "compact",
          invocation: "/compact",
          label: "compact",
          argumentMode: "text",
          description: "Compact the current session",
        }]);
      }
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
          harnessId: harnessIdSchema.parse("kimi-code"),
          nativeSessionId: sessionId,
        },
        cwd: tempDir,
        thinkingOptionId: harnessThinkingOptionIdSchema.parse("high"),
        permissionModeId: harnessPermissionModeIdSchema.parse("plan"),
      });

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(nativeSessionRefSchema.parse(result.value.initialState.nativeRef)).toEqual({
          formatVersion: 1,
          harnessId: harnessIdSchema.parse("kimi-code"),
          nativeSessionId: sessionId,
          locator: { cwd: tempDir },
        });
        expect(result.value.initialState.effectiveThinkingOptionId).toBe("high");
        expect(result.value.initialState.effectivePermissionModeId).toBe("plan");
      }
      expect(fakeTransport.openKinds).toContain("load");
      expect(fakeTransport.configOptionsSet).toEqual(expect.arrayContaining([
        { configId: "thinking", value: "high" },
        { configId: "mode", value: "plan" },
      ]));
    });

    it("fails open when native configuration rejects a requested value", async () => {
      fakeTransport.setConfigOption = vi.fn(async () => {
        throw new Error("plan is unavailable");
      });
      const adapter = new KimiAdapter(
        { homeDirectory: tempDir },
        { resolveExecutable: () => "kimi", createTransport: () => fakeTransport },
      );

      const result = await adapter.open({
        kind: "create",
        cwd: tempDir,
        permissionModeId: harnessPermissionModeIdSchema.parse("plan"),
      });

      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.message).toContain("plan is unavailable");
      expect(fakeTransport.close).toHaveBeenCalled();
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
          harnessId: harnessIdSchema.parse("kimi-code"),
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

    it("rolls back 1-turn session to empty created session", async () => {
      const sourceSessionId = "source-1-turn";
      const sessionDir = path.join(tempDir, ".kimi-code", "sessions", sourceSessionId);
      await mkdir(path.join(sessionDir, "agents", "main"), { recursive: true });
      await writeFile(
        path.join(tempDir, ".kimi-code", "session_index.jsonl"),
        JSON.stringify({ sessionId: sourceSessionId, sessionDir }) + "\n",
      );
      await writeFile(
        path.join(sessionDir, "state.json"),
        JSON.stringify({ id: sourceSessionId, version: 2, cwd: tempDir }),
      );

      const adapter = new KimiAdapter(
        { homeDirectory: tempDir },
        {
          resolveExecutable: () => "kimi",
          createTransport: () => fakeTransport,
          readSessionSnapshot: async (sessionId: string) => {
            if (sessionId === sourceSessionId) {
              return {
                turns: [
                  {
                    nativeTurnRef: {
                      formatVersion: 1,
                      harnessId: harnessIdSchema.parse("kimi-code"),
                      nativeSessionId: sourceSessionId,
                      nativeTurnKey: "turn:0",
                    },
                    checkpoint: {
                      formatVersion: 1,
                      harnessId: harnessIdSchema.parse("kimi-code"),
                      nativeSessionId: sourceSessionId,
                      nativeTurnKey: "turn:0",
                    },
                    input: [{ type: "text", text: "hello" }],
                    items: [],
                    outcome: { status: "succeeded" },
                  },
                ],
              };
            }
            return { turns: [] };
          },
        },
      );

      const result = await adapter.open({
        kind: "rollbackLastTurn",
        sourceRef: {
          formatVersion: 1,
          harnessId: harnessIdSchema.parse("kimi-code"),
          nativeSessionId: sourceSessionId,
        },
        cwd: tempDir,
      });

      expect(result.ok).toBe(true);
      expect(fakeTransport.openKinds).toContain("create");
      if (result.ok) {
        const snapshot = await result.value.readSnapshot();
        expect(snapshot.ok).toBe(true);
        if (snapshot.ok) {
          expect(snapshot.value.turns).toHaveLength(0);
        }
      }
    });

    it("rolls back multi-turn session by forking and truncating wire log", async () => {
      const sourceSessionId = "source-multi-turn";
      const sourceDir = path.join(tempDir, ".kimi-code", "sessions", sourceSessionId);
      const forkedSessionId = "session-forked-123";
      const forkedDir = path.join(tempDir, ".kimi-code", "sessions", forkedSessionId);

      await mkdir(path.join(sourceDir, "agents", "main"), { recursive: true });
      await mkdir(path.join(forkedDir, "agents", "main"), { recursive: true });

      const indexContent = [
        JSON.stringify({ sessionId: sourceSessionId, sessionDir: sourceDir }),
        JSON.stringify({ sessionId: forkedSessionId, sessionDir: forkedDir }),
      ].join("\n") + "\n";
      await writeFile(path.join(tempDir, ".kimi-code", "session_index.jsonl"), indexContent);

      await writeFile(
        path.join(sourceDir, "state.json"),
        JSON.stringify({ id: sourceSessionId, version: 2, cwd: tempDir }),
      );
      await writeFile(
        path.join(forkedDir, "state.json"),
        JSON.stringify({ id: forkedSessionId, version: 2, cwd: tempDir, lastPrompt: "turn 2" }),
      );

      const wireLines = [
        JSON.stringify({ type: "turn.prompt", turnId: 0, input: [{ type: "text", text: "turn 1" }] }),
        JSON.stringify({ type: "turn.ended", turnId: 0 }),
        JSON.stringify({ type: "prompt.completed", turnId: 0, reason: "completed" }),
        JSON.stringify({ type: "turn.prompt", turnId: 1, input: [{ type: "text", text: "turn 2" }] }),
        JSON.stringify({ type: "turn.ended", turnId: 1 }),
      ];
      await writeFile(path.join(forkedDir, "agents", "main", "wire.jsonl"), wireLines.join("\n") + "\n");

      const adapter = new KimiAdapter(
        { homeDirectory: tempDir },
        {
          resolveExecutable: () => "kimi",
          createTransport: () => fakeTransport,
          readSessionSnapshot: async (sessionId: string) => {
            if (sessionId === sourceSessionId) {
              return {
                turns: [
                  {
                    nativeTurnRef: {
                      formatVersion: 1,
                      harnessId: harnessIdSchema.parse("kimi-code"),
                      nativeSessionId: sourceSessionId,
                      nativeTurnKey: "turn:0",
                    },
                    checkpoint: {
                      formatVersion: 1,
                      harnessId: harnessIdSchema.parse("kimi-code"),
                      nativeSessionId: sourceSessionId,
                      nativeTurnKey: "turn:0",
                    },
                    input: [{ type: "text", text: "turn 1" }],
                    items: [],
                    outcome: { status: "succeeded" },
                  },
                  {
                    nativeTurnRef: {
                      formatVersion: 1,
                      harnessId: harnessIdSchema.parse("kimi-code"),
                      nativeSessionId: sourceSessionId,
                      nativeTurnKey: "turn:1",
                    },
                    checkpoint: {
                      formatVersion: 1,
                      harnessId: harnessIdSchema.parse("kimi-code"),
                      nativeSessionId: sourceSessionId,
                      nativeTurnKey: "turn:1",
                    },
                    input: [{ type: "text", text: "turn 2" }],
                    items: [],
                    outcome: { status: "succeeded" },
                  },
                ],
              };
            }
            return {
              turns: [
                {
                  nativeTurnRef: {
                    formatVersion: 1,
                    harnessId: harnessIdSchema.parse("kimi-code"),
                    nativeSessionId: sessionId,
                    nativeTurnKey: "turn:0",
                  },
                  checkpoint: {
                    formatVersion: 1,
                    harnessId: harnessIdSchema.parse("kimi-code"),
                    nativeSessionId: sessionId,
                    nativeTurnKey: "turn:0",
                  },
                  input: [{ type: "text", text: "turn 1" }],
                  items: [],
                  outcome: { status: "succeeded" },
                },
              ],
            };
          },
        },
      );

      const result = await adapter.open({
        kind: "rollbackLastTurn",
        sourceRef: {
          formatVersion: 1,
          harnessId: harnessIdSchema.parse("kimi-code"),
          nativeSessionId: sourceSessionId,
        },
        cwd: tempDir,
      });

      expect(result.ok).toBe(true);
      expect(fakeTransport.openKinds).toContain("fork");
      expect(fakeTransport.openKinds).toContain("load");

      // Check truncated wire log on disk
      const truncatedWire = await readFile(path.join(forkedDir, "agents", "main", "wire.jsonl"), "utf8");
      expect(truncatedWire.split("\n").filter(Boolean)).toHaveLength(3);
    });

    it("returns sessionNotFound when rolling back non-existent session", async () => {
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
        kind: "rollbackLastTurn",
        sourceRef: {
          formatVersion: 1,
          harnessId: harnessIdSchema.parse("kimi-code"),
          nativeSessionId: "missing-source",
        },
        cwd: tempDir,
      });

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe("sessionNotFound");
      }
    });
  });

  describe("commandCatalog", () => {
    it("is initially empty and conforms to schema", () => {
      const adapter = new KimiAdapter();
      expect(adapter.commandCatalog).toEqual({ commands: [] });
      expect(harnessCommandCatalogSchema.parse(adapter.commandCatalog)).toEqual({ commands: [] });
    });

    it("dynamically synchronizes commandCatalog upon session creation", async () => {
      const adapter = new KimiAdapter(
        { homeDirectory: tempDir },
        {
          resolveExecutable: () => "kimi",
          createTransport: () => fakeTransport,
        },
      );

      expect(adapter.commandCatalog).toEqual({ commands: [] });

      const result = await adapter.open({
        kind: "create",
        cwd: tempDir,
      });

      expect(result.ok).toBe(true);
      expect(adapter.commandCatalog.commands).toHaveLength(1);
      expect(adapter.commandCatalog.commands[0]).toEqual({
        id: "compact",
        invocation: "/compact",
        label: "compact",
        description: "Compact the current session",
        argumentMode: "text",
      });
    });

    it("dynamically updates commandCatalog when session emits commands.update", async () => {
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
      expect(adapter.commandCatalog.commands).toHaveLength(1);

      // Simulate ACP sending an updated commands notification
      fakeTransport.sessionEventHandler?.({
        type: "commands.update",
        commands: [
          { name: "compact", description: "Compact session", input: { hint: "prompt" } },
          { name: "/clear", description: "Clear context", input: null },
          { name: "export", description: "Export session data", input: { hint: "filename" } },
        ],
      });

      expect(adapter.commandCatalog.commands).toHaveLength(3);
      expect(adapter.commandCatalog.commands.map((c) => c.id)).toEqual(["compact", "clear", "export"]);
      expect(adapter.commandCatalog.commands[1].invocation).toBe("/clear");
      expect(adapter.commandCatalog.commands[1].argumentMode).toBe("none");
      expect(adapter.commandCatalog.commands[2].argumentMode).toBe("text");
    });

    it("resets commandCatalog to empty upon adapter.close()", async () => {
      const adapter = new KimiAdapter(
        { homeDirectory: tempDir },
        {
          resolveExecutable: () => "kimi",
          createTransport: () => fakeTransport,
        },
      );

      await adapter.open({
        kind: "create",
        cwd: tempDir,
      });

      expect(adapter.commandCatalog.commands.length).toBeGreaterThan(0);

      await adapter.close();

      expect(adapter.commandCatalog).toEqual({ commands: [] });
    });
  });
});
