import { describe, expect, it } from "vitest";
import type {
  AvailableCommand,
  InitializeResponse,
  PromptResponse,
} from "@agentclientprotocol/sdk";
import {
  harnessCommandCatalogSchema,
  hostTurnIdSchema,
  type HostTurnSnapshot,
} from "@codexhost/shared-contracts";
import type { HarnessOutput } from "@codexhost/harness-adapter";

import {
  KimiAdapter,
  type KimiAcpTransportLike,
} from "../src/kimi-adapter.js";
import { KimiSession } from "../src/kimi-session.js";
import { createKimiNativeTurnRef } from "../src/history.js";
import type { ActivePromptHandler, SessionEventHandler } from "../src/acp-transport.js";
import { resolveKimiExecutable } from "../src/command.js";
import { KIMI_DEFAULT_COMMAND_CATALOG } from "../src/slash-commands.js";

class SimulatedAcpTransport implements KimiAcpTransportLike {
  sessionId: string | null = "sim-session-001";
  isClosed = false;
  activeHandler: ActivePromptHandler | null = null;
  sessionEventHandler: SessionEventHandler | null = null;
  pendingSessionEvents: Parameters<SessionEventHandler>[0][] = [];
  promptsReceived: string[] = [];

  setActivePromptHandler(handler: ActivePromptHandler | null): void {
    this.activeHandler = handler;
  }

  setSessionEventHandler(handler: SessionEventHandler | null): void {
    this.sessionEventHandler = handler;
    if (handler) {
      for (const event of this.pendingSessionEvents.splice(0)) {
        handler(event);
      }
    }
  }

  async inspect() {
    return {
      initialize: { protocolVersion: 1 } as InitializeResponse,
      authReady: true,
    };
  }

  async openSession(input: { kind: string; sessionId?: string; cwd?: string }) {
    // Simulate initial discovery notification queued during session creation
    this.pendingSessionEvents.push({
      type: "commands.update",
      commands: [
        {
          name: "compact",
          description: "Compact the conversation context",
          input: { hint: "<optional custom summarization instructions>" },
        },
        {
          name: "status",
          description: "Show current session status",
          input: null,
        },
        {
          name: "/help",
          description: "Show available ACP commands",
        },
      ],
    });
    return {
      sessionId: input.sessionId ?? "sim-session-001",
      configOptions: [
        { id: "model", currentValue: "relay" },
        { id: "mode", currentValue: "default" },
      ],
    };
  }

  async prompt(text: string, handler: ActivePromptHandler): Promise<PromptResponse> {
    this.promptsReceived.push(text);
    this.activeHandler = handler;

    // Simulate ACP streaming chunks: agent.thought -> agent.text -> completion
    handler.onEvent({
      type: "agent.thought",
      text: `Processing slash command: ${text}...`,
    });
    handler.onEvent({
      type: "agent.text",
      text: `Executed command successfully: ${text}`,
    });

    return { stopReason: "end_turn" };
  }

  async cancel(): Promise<void> {}
  async close(): Promise<void> {
    this.isClosed = true;
  }

  emitDynamicCommandsUpdate(commands: AvailableCommand[]): void {
    const event = { type: "commands.update" as const, commands };
    if (this.sessionEventHandler) {
      this.sessionEventHandler(event);
    } else {
      this.pendingSessionEvents.push(event);
    }
  }
}

describe("Real ACP / Kimi Dynamic Slash Commands Simulation", () => {
  it("Step 1: probes local environment for Kimi executable", () => {
    let localExecutable: string | null = null;
    try {
      localExecutable = resolveKimiExecutable();
    } catch {
      localExecutable = null;
    }

    if (localExecutable) {
      expect(typeof localExecutable).toBe("string");
      expect(localExecutable.length).toBeGreaterThan(0);
    } else {
      // Local executable not found, falls back to simulated transport
      expect(localExecutable).toBeNull();
    }
  });

  it("Step 2 (Step A): verifies initial empty catalog -> dynamic discovery via ACP commandsUpdate", async () => {
    const transport = new SimulatedAcpTransport();
    const adapter = new KimiAdapter(
      {},
      {
        resolveExecutable: () => "kimi",
        createTransport: () => transport,
      },
    );

    // Initial catalog must be default and match schema
    expect(adapter.commandCatalog).toEqual(KIMI_DEFAULT_COMMAND_CATALOG);
    expect(harnessCommandCatalogSchema.parse(adapter.commandCatalog)).toEqual(KIMI_DEFAULT_COMMAND_CATALOG);

    // Open session -> triggers ACP session open & processes commands.update
    const sessionRes = await adapter.open({
      kind: "create",
      cwd: "D:/test-workspace",
    });
    expect(sessionRes.ok).toBe(true);
    if (!sessionRes.ok) return;

    // Catalog must be dynamically populated from ACP notification
    const catalog = adapter.commandCatalog;
    expect(harnessCommandCatalogSchema.parse(catalog)).toBeDefined();
    expect(catalog.commands).toHaveLength(3);

    expect(catalog.commands[0]).toEqual({
      id: "compact",
      invocation: "/compact",
      label: "compact",
      description: "Compact the conversation context",
      argumentMode: "text",
    });

    expect(catalog.commands[1]).toEqual({
      id: "status",
      invocation: "/status",
      label: "status",
      description: "Show current session status",
      argumentMode: "none",
    });

    // Strips leading slash from "/help" -> id: "help", invocation: "/help"
    expect(catalog.commands[2]).toEqual({
      id: "help",
      invocation: "/help",
      label: "help",
      description: "Show available ACP commands",
      argumentMode: "none",
    });

    await adapter.close();
  });

  it("Step 3 (Step B): verifies command execution with & without arguments, streaming, and completion", async () => {
    const transport = new SimulatedAcpTransport();
    // Statefully track native turns so correlation resolves immediately
    const turns: HostTurnSnapshot[] = [];
    let turnSeq = 1;

    transport.prompt = async (text: string, handler: ActivePromptHandler): Promise<PromptResponse> => {
      transport.promptsReceived.push(text);
      transport.activeHandler = handler;

      handler.onEvent({
        type: "agent.thought",
        text: `Processing slash command: ${text}...`,
      });
      handler.onEvent({
        type: "agent.text",
        text: `Executed command successfully: ${text}`,
      });

      const currentTurnKey = `turn-${turnSeq++}`;
      turns.push({
        nativeTurnRef: createKimiNativeTurnRef("sim-session-001", currentTurnKey, "D:/test-workspace"),
        input: [{ type: "text", text }],
        items: [],
        outcome: { status: "succeeded" },
      });

      return { stopReason: "end_turn" };
    };

    const session = new KimiSession({
      transport,
      sessionId: "sim-session-001",
      cwd: "D:/test-workspace",
      initialState: {},
      nativeTurnFlushTimeoutMs: 500,
      readNativeSnapshot: async () => ({
        threadId: "sim-session-001",
        turns: [...turns],
      }),
    });

    const allOutputs: HarnessOutput[] = [];
    (async () => {
      for await (const output of session.outputs) {
        allOutputs.push(output);
      }
    })();

    const waitForTurnCompletion = async (turnId: string) => {
      const deadline = Date.now() + 3000;
      while (Date.now() < deadline) {
        const found = allOutputs.find(
          (o) => o.kind === "event" && o.event.type === "turn.completed" && o.event.turnId === turnId,
        );
        if (found) return found;
        await new Promise((r) => setTimeout(r, 20));
      }
      throw new Error(`Timeout waiting for turn ${turnId} completion`);
    };

    // Sub-case B1: Execute without arguments (/status)
    const turnId1 = hostTurnIdSchema.parse("turn-sim-1");
    const execRes1 = await session.commands.execute({
      turnId: turnId1,
      commandId: "status",
    });
    expect(execRes1.ok).toBe(true);

    const completedEvent1 = await waitForTurnCompletion("turn-sim-1");
    expect(transport.promptsReceived).toContain("/status");

    // Verify stream events emitted for turn 1
    const events1 = allOutputs.filter(
      (o): o is Extract<HarnessOutput, { kind: "event" }> =>
        o.kind === "event" && "turnId" in o.event && o.event.turnId === "turn-sim-1",
    );
    const types1 = events1.map((e) => e.event.type);
    expect(types1).toContain("turn.started");
    expect(types1).toContain("item.started");
    expect(types1).toContain("item.updated");
    expect(types1).toContain("item.completed");
    expect(types1).toContain("turn.completed");

    expect(completedEvent1.event).toMatchObject({
      turnId: turnId1,
      outcome: { status: "succeeded" },
    });

    // Sub-case B2: Execute with arguments (/compact full --force)
    const turnId2 = hostTurnIdSchema.parse("turn-sim-2");
    const execRes2 = await session.commands.execute({
      turnId: turnId2,
      commandId: "compact",
      arguments: { text: "full --force" },
    });
    expect(execRes2.ok).toBe(true);

    const completedEvent2 = await waitForTurnCompletion("turn-sim-2");
    expect(transport.promptsReceived).toContain("/compact full --force");

    const events2 = allOutputs.filter(
      (o): o is Extract<HarnessOutput, { kind: "event" }> =>
        o.kind === "event" && "turnId" in o.event && o.event.turnId === "turn-sim-2",
    );
    const types2 = events2.map((e) => e.event.type);
    expect(types2).toContain("turn.started");
    expect(types2).toContain("item.started");
    expect(types2).toContain("item.updated");
    expect(types2).toContain("item.completed");
    expect(types2).toContain("turn.completed");

    expect(completedEvent2.event).toMatchObject({
      turnId: turnId2,
      outcome: { status: "succeeded" },
    });

    await session.close();
  });

  it("Step 4 (Step C): verifies mid-session dynamic updates and clean reset on close", async () => {
    const transport = new SimulatedAcpTransport();
    const adapter = new KimiAdapter(
      {},
      {
        resolveExecutable: () => "kimi",
        createTransport: () => transport,
      },
    );

    const sessionRes = await adapter.open({
      kind: "create",
      cwd: "D:/test-workspace",
    });
    expect(sessionRes.ok).toBe(true);
    expect(adapter.commandCatalog.commands).toHaveLength(3);

    // Simulate server sending dynamic commands update during session
    transport.emitDynamicCommandsUpdate([
      { name: "write-goal", description: "Help craft a goal", input: { hint: "goal text" } },
      { name: "custom-tool", description: "Custom ACP command" },
    ]);

    // Adapter catalog dynamically updates
    expect(adapter.commandCatalog.commands).toHaveLength(2);
    expect(adapter.commandCatalog.commands[0].id).toBe("write-goal");
    expect(adapter.commandCatalog.commands[0].argumentMode).toBe("text");
    expect(adapter.commandCatalog.commands[1].id).toBe("custom-tool");
    expect(adapter.commandCatalog.commands[1].argumentMode).toBe("none");

    // Close adapter -> commandCatalog cleanly resets to default catalog
    await adapter.close();
    expect(adapter.commandCatalog).toEqual(KIMI_DEFAULT_COMMAND_CATALOG);
  });

  it(
    "Step 5: verifies live execution against installed Kimi CLI if available",
    async () => {
      let localExecutable: string | null = null;
      try {
        localExecutable = resolveKimiExecutable();
      } catch {
        localExecutable = null;
      }

      if (!localExecutable) {
        return; // Skip live CLI execution if not installed
      }

      const adapter = new KimiAdapter();
      expect(adapter.commandCatalog).toEqual(KIMI_DEFAULT_COMMAND_CATALOG);

      const sessionRes = await adapter.open({
        kind: "create",
        cwd: process.cwd(),
      });
      expect(sessionRes.ok).toBe(true);
      if (!sessionRes.ok) return;

      const session = sessionRes.value;

      // Wait for live ACP commandsUpdate notification
      let catalogCount = 0;
      for (let i = 0; i < 20; i++) {
        catalogCount = adapter.commandCatalog.commands.length;
        if (catalogCount > 0) break;
        await new Promise((r) => setTimeout(r, 100));
      }
      expect(catalogCount).toBeGreaterThan(0);
      expect(harnessCommandCatalogSchema.parse(adapter.commandCatalog)).toBeDefined();

      // Execute live command: /status
      const turnId = hostTurnIdSchema.parse("turn-live-sim-status");
      const turnCompletedPromise = new Promise<void>((resolve) => {
        (async () => {
          for await (const output of session.outputs) {
            if (output.kind === "event" && output.event.type === "turn.completed") {
              resolve();
              break;
            }
          }
        })();
      });

      const execRes = await session.commands.execute({
        turnId,
        commandId: "status",
      });
      expect(execRes.ok).toBe(true);

      await turnCompletedPromise;

      await session.close();
      await adapter.close();

      expect(adapter.commandCatalog).toEqual(KIMI_DEFAULT_COMMAND_CATALOG);
    },
    25000,
  );
});
