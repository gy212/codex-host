import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { InitializeResponse, PromptResponse } from "@agentclientprotocol/sdk";
import type { HarnessOutput, HostTurnSnapshot } from "@codexhost/harness-adapter";
import { harnessIdSchema, hostTurnIdSchema } from "@codexhost/shared-contracts";
import { KimiAdapter, type KimiAcpTransportLike } from "../src/kimi-adapter.js";
import { KimiSession } from "../src/kimi-session.js";
import {
  createKimiNativeSessionRef,
  createKimiNativeTurnRef,
  parseKimiWireLog,
} from "../src/history.js";
import {
  KimiTransportError,
  type ActivePromptHandler,
  type SessionEventHandler,
} from "../src/acp-transport.js";

class Transport implements KimiAcpTransportLike {
  sessionId = "review-session";
  isClosed = false;
  handler: SessionEventHandler | null = null;
  setActivePromptHandler() {}
  setSessionEventHandler(handler: SessionEventHandler | null) {
    this.handler = handler;
  }
  async inspect() {
    return { initialize: { protocolVersion: 1 } as InitializeResponse, authReady: true };
  }
  openSession = vi.fn(async () => ({ sessionId: this.sessionId, configOptions: [] }));
  setConfigOption = vi.fn<(id: string, value: string) => Promise<unknown[]>>(async () => []);
  prompt = vi.fn<(text: string, handler: ActivePromptHandler) => Promise<PromptResponse>>(
    async () => ({ stopReason: "end_turn" }),
  );
  cancel = vi.fn(async () => {});
  async close() {
    this.isClosed = true;
  }
}

async function terminal(session: KimiSession): Promise<HarnessOutput[]> {
  const outputs: HarnessOutput[] = [];
  for await (const output of session.outputs) {
    outputs.push(output);
    if (output.kind === "event" && output.event.type === "turn.completed") break;
  }
  return outputs;
}

function nativeTurn(
  key: number,
  text: string,
  status: "unknown" | "succeeded" = "succeeded",
): HostTurnSnapshot {
  return {
    nativeTurnRef: createKimiNativeTurnRef("review-session", key),
    input: [{ type: "text", text }],
    items: [],
    outcome: status === "unknown" ? { status, reason: "Missing terminal record" } : { status },
  };
}

describe("Kimi PR review regressions", () => {
  const directories: string[] = [];
  afterEach(async () => {
    for (const directory of directories.splice(0))
      await rm(directory, { recursive: true, force: true });
  });

  it("keeps metadata-only native sessions empty", async () => {
    const wire = [
      { type: "metadata" },
      { type: "runtime.set_binding", time: 100 },
      { type: "profile.bind", time: 101 },
    ];
    expect(
      await parseKimiWireLog(wire.map((row) => JSON.stringify(row)).join("\n"), "review-session"),
    ).toEqual([]);
  });

  it.each(["fork", "rollbackLastTurn"] as const)(
    "rejects unsupported %s before native side effects",
    async (kind) => {
      const transport = new Transport();
      const createTransport = vi.fn(() => transport);
      const adapter = new KimiAdapter({}, { resolveExecutable: () => "kimi", createTransport });
      const sourceRef = createKimiNativeSessionRef("source", process.cwd());
      const result = await adapter.open(
        kind === "fork"
          ? {
              kind,
              sourceRef,
              cwd: process.cwd(),
              checkpoint: {
                formatVersion: 1,
                harnessId: harnessIdSchema.parse("kimi-code"),
                nativeSessionId: "source",
                checkpointId: "turn:0",
              },
            }
          : { kind, sourceRef, cwd: process.cwd() },
      );
      expect(result).toMatchObject({ ok: false, error: { code: "unsupported" } });
      expect(createTransport).not.toHaveBeenCalled();
    },
  );

  it("rejects an unverified unattended execution policy before creating a session", async () => {
    const transport = new Transport();
    const adapter = new KimiAdapter(
      {},
      { resolveExecutable: () => "kimi", createTransport: () => transport },
    );
    expect(
      await adapter.open({
        kind: "create",
        cwd: process.cwd(),
        executionPolicy: "unattended-full-access",
      }),
    ).toMatchObject({ ok: false, error: { code: "unsupported" } });
    expect(transport.openSession).not.toHaveBeenCalled();
  });

  it.each(["old-incomplete", "new-incomplete", "unrelated"])(
    "does not invent success or identity for %s history",
    async (scenario) => {
      const transport = new Transport();
      let reads = 0;
      const turn = nativeTurn(
        0,
        scenario === "unrelated" ? "another prompt" : "hello",
        scenario === "unrelated" ? "succeeded" : "unknown",
      );
      const session = new KimiSession({
        transport,
        sessionId: transport.sessionId,
        cwd: process.cwd(),
        initialState: {},
        nativeTurnFlushTimeoutMs: 1,
        readNativeSnapshot: async () => ({
          turns: reads++ === 0 && scenario !== "old-incomplete" ? [] : [turn],
        }),
      });
      await session.execute({
        type: "turn.start",
        turnId: hostTurnIdSchema.parse("review-turn"),
        input: [{ type: "text", text: "hello" }],
      });
      const outputs = await terminal(session);
      expect(outputs.at(-1)).toMatchObject({
        kind: "event",
        event: { type: "turn.completed", outcome: { status: "failed" } },
      });
      if (scenario !== "new-incomplete")
        expect(outputs.at(-1)).not.toHaveProperty("event.nativeTurnRef");
      await session.close();
    },
  );

  it("settles every started tool before a rejected prompt completes", async () => {
    const transport = new Transport();
    transport.prompt.mockImplementation(async (_text, handler) => {
      handler.onEvent({
        type: "tool.call",
        toolCallId: "shell",
        name: "Bash",
        kind: "execute",
        args: { command: "echo hello" },
      });
      throw new Error("native process failed");
    });
    const session = new KimiSession({
      transport,
      sessionId: transport.sessionId,
      cwd: process.cwd(),
      initialState: {},
      readNativeSnapshot: async () => ({ turns: [] }),
    });
    await session.execute({
      type: "turn.start",
      turnId: hostTurnIdSchema.parse("review-tool"),
      input: [{ type: "text", text: "hello" }],
    });
    const outputs = await terminal(session);
    expect(
      outputs.filter((o) => o.kind === "event" && o.event.type === "item.completed"),
    ).toMatchObject([
      {
        event: { snapshot: { item: { type: "commandExecution" }, outcome: { status: "failed" } } },
      },
    ]);
    await session.close();
  });

  it("clears effective settings absent from the full config response", async () => {
    const transport = new Transport();
    const session = new KimiSession({
      transport,
      sessionId: transport.sessionId,
      cwd: process.cwd(),
      initialState: { effectiveThinkingOptionId: "high" as never },
    });
    transport.handler?.({ type: "config.update", configOptions: [] });
    expect(session.initialState.effectiveThinkingOptionId).toBeUndefined();
    await session.close();
  });

  it("finishes the turn before publishing a transport fault and ends the output stream", async () => {
    const transport = new Transport();
    let rejectPrompt!: (error: Error) => void;
    let started!: () => void;
    const promptStarted = new Promise<void>((resolve) => {
      started = resolve;
    });
    transport.prompt.mockImplementation(async (_text, handler) => {
      handler.onEvent({
        type: "tool.call",
        toolCallId: "shell",
        name: "Bash",
        args: { command: "echo hello" },
      });
      started();
      return new Promise((_resolve, reject) => {
        rejectPrompt = reject;
      });
    });
    transport.close = async () => {
      transport.isClosed = true;
      rejectPrompt(new Error("process exited"));
    };
    const session = new KimiSession({
      transport,
      sessionId: transport.sessionId,
      cwd: process.cwd(),
      initialState: {},
      readNativeSnapshot: async () => ({ turns: [] }),
    });
    const outputs: HarnessOutput[] = [];
    const consume = (async () => {
      for await (const output of session.outputs) outputs.push(output);
    })();
    await session.execute({
      type: "turn.start",
      turnId: hostTurnIdSchema.parse("fault-turn"),
      input: [{ type: "text", text: "hello" }],
    });
    await promptStarted;
    session.handleTransportFault(new KimiTransportError("processExited", "native exit"));
    await consume;
    const types = outputs.map((output) =>
      output.kind === "event" ? output.event.type : output.kind,
    );
    expect(types.slice(-3)).toEqual(["item.completed", "turn.completed", "session.faulted"]);
    expect(transport.isClosed).toBe(true);
  });

  it("does not accept commands missing from the native catalog", async () => {
    const transport = new Transport();
    const session = new KimiSession({
      transport,
      sessionId: transport.sessionId,
      cwd: process.cwd(),
      initialState: {},
    });
    expect(
      await session.commands.execute({
        turnId: hostTurnIdSchema.parse("unknown-command"),
        commandId: "not-a-command",
      }),
    ).toMatchObject({ ok: false, error: { code: "invalidRequest" } });
    expect(transport.prompt).not.toHaveBeenCalled();
    await session.close();
  });

  it("persists command results with distinct identities and leaves native history untouched", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "kimi-command-review-"));
    directories.push(home);
    const sessionDir = path.join(home, "sessions", "review-session");
    await mkdir(path.join(sessionDir, "agents", "main"), { recursive: true });
    await writeFile(
      path.join(home, "session_index.jsonl"),
      JSON.stringify({ sessionId: "review-session", sessionDir }) + "\n",
    );
    await writeFile(
      path.join(sessionDir, "state.json"),
      JSON.stringify({ id: "review-session", version: 2, cwd: home }),
    );
    const wirePath = path.join(sessionDir, "agents", "main", "wire.jsonl");
    const wire = JSON.stringify({ type: "runtime.set_binding", time: 100 }) + "\n";
    await writeFile(wirePath, wire);
    const makeSession = () => {
      const transport = new Transport();
      transport.prompt.mockImplementation(async (_text, handler) => {
        handler.onEvent({ type: "agent.text", text: "Session: review\n" });
        handler.onEvent({ type: "agent.text", text: "Model: relay\n" });
        return { stopReason: "end_turn" };
      });
      return new KimiSession({
        transport,
        sessionId: transport.sessionId,
        cwd: home,
        initialState: {},
        kimiCodeHome: home,
        nativeTurnFlushTimeoutMs: 1,
      });
    };
    const session = makeSession();
    const outputIterator = session.outputs[Symbol.asyncIterator]();
    const references: unknown[] = [];
    for (const id of ["first", "second"]) {
      await session.commands.execute({ commandId: "status", turnId: hostTurnIdSchema.parse(id) });
      for (;;) {
        const { value } = await outputIterator.next();
        if (value?.kind === "event" && value.event.type === "turn.completed") {
          expect(value.event.outcome.status).toBe("succeeded");
          references.push(value.event.nativeTurnRef);
          break;
        }
      }
    }
    expect(references[0]).not.toEqual(references[1]);
    await session.close();
    const resumed = makeSession();
    const snapshot = await resumed.readSnapshot();
    expect(snapshot.ok).toBe(true);
    if (snapshot.ok) {
      expect(snapshot.value.turns).toHaveLength(2);
      expect(snapshot.value.turns.map((t) => t.nativeTurnRef)).toEqual(references);
      expect(snapshot.value.turns[0]?.items).toMatchObject([
        { item: { type: "agentMessage", text: expect.stringContaining("### Session Status") } },
      ]);
    }
    expect(await readFile(wirePath, "utf8")).toBe(wire);
    await resumed.close();
  });
});
