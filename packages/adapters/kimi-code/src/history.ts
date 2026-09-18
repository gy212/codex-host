import { readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { createTwoFilesPatch } from "diff";

import {
  parseHostUsage,
  type HistoricalTurnOutcome,
  type HostAgentMessageItem,
  type HostCommandExecutionItem,
  type HostFileChange,
  type HostFileChangeItem,
  type HostItemSnapshot,
  type HostReasoningItem,
  type HostTextInput,
  type HostThreadSnapshot,
  type HostToolExecutionItem,
  type HostTurnSnapshot,
  type HostUsage,
} from "@codexhost/harness-adapter";
import {
  harnessIdSchema,
  hostItemIdSchema,
  nativeSessionRefSchema,
  nativeTurnRefSchema,
  type HarnessId,
  type JsonObject,
  type NativeSessionRef,
  type NativeTurnRef,
} from "@codexhost/shared-contracts";

import { encodeKimiModelRef } from "./models.js";
import { canonicalizeKimiToolName } from "./projection.js";

const kimiHarnessId: HarnessId = harnessIdSchema.parse("kimi-code");

export function createKimiNativeSessionRef(sessionId: string, cwd: string): NativeSessionRef {
  return nativeSessionRefSchema.parse({
    formatVersion: 1,
    harnessId: kimiHarnessId,
    nativeSessionId: sessionId,
    locator: { cwd },
  });
}

export function createKimiNativeTurnRef(sessionId: string, turnId: number | string): NativeTurnRef {
  return nativeTurnRefSchema.parse({
    formatVersion: 1,
    harnessId: kimiHarnessId,
    nativeSessionId: sessionId,
    nativeTurnKey: `turn:${turnId}`,
  });
}

export function getKimiCodeHome(
  homeDirectory?: string,
  environment: NodeJS.ProcessEnv = process.env,
): string {
  return environment.KIMI_CODE_HOME ||
    (homeDirectory ? path.join(homeDirectory, ".kimi-code") : path.join(os.homedir(), ".kimi-code"));
}

export interface KimiSessionIndexEntry {
  sessionId: string;
  sessionDir?: string;
  workDir?: string;
  deleted?: boolean;
}

export interface KimiStateJson {
  id: string;
  version: number;
  cwd: string;
  archived?: boolean;
  agents?: {
    main?: {
      homedir: string;
      type: string;
    };
  };
  lastTurnReason?: string;
  createdAt?: number;
  updatedAt?: number;
}

export async function locateKimiSession(
  sessionId: string,
  options: { homeDirectory?: string; kimiCodeHome?: string } = {},
): Promise<{
  sessionDir: string;
  mainHomeDir: string;
  state: KimiStateJson;
} | null> {
  const kimiHome = options.kimiCodeHome || getKimiCodeHome(options.homeDirectory);
  const indexFile = path.join(kimiHome, "session_index.jsonl");

  let content: string;
  try {
    content = await readFile(indexFile, "utf8");
  } catch {
    return null;
  }

  const lines = content.split("\n");
  let targetEntry: KimiSessionIndexEntry | null = null;

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const entry = JSON.parse(trimmed) as KimiSessionIndexEntry;
      if (entry.sessionId === sessionId) {
        targetEntry = entry;
      }
    } catch {
      // Ignore malformed lines in index
    }
  }

  if (!targetEntry || targetEntry.deleted || !targetEntry.sessionDir) {
    return null;
  }

  const sessionDir = path.resolve(targetEntry.sessionDir);
  const normalizedKimiHome = path.resolve(kimiHome);
  const relativeToHome = path.relative(normalizedKimiHome, sessionDir);

  if (relativeToHome.startsWith("..") || path.isAbsolute(relativeToHome)) {
    throw new Error(`Session directory ${sessionDir} is outside KIMI_CODE_HOME`);
  }

  let state: KimiStateJson;
  try {
    const stateContent = await readFile(path.join(sessionDir, "state.json"), "utf8");
    state = JSON.parse(stateContent) as KimiStateJson;
  } catch {
    return null;
  }

  if (state.id !== sessionId) {
    throw new Error(`State JSON session ID mismatch: expected ${sessionId}, found ${state.id}`);
  }

  const mainHomeDir = state.agents?.main?.homedir
    ? path.resolve(state.agents.main.homedir)
    : path.join(sessionDir, "agents", "main");

  return { sessionDir, mainHomeDir, state };
}

export interface KimiNativeTurnBuilder {
  turnId: number;
  promptId?: string;
  input: HostTextInput[];
  startedAtMs?: number;
  completedAtMs?: number;
  reason?: string;
  model?: string;
  contentParts: Array<{ text: string; thought?: boolean; uuid?: string }>;
  toolCalls: Map<string, {
    toolCallId: string;
    name: string;
    args: unknown;
    display?: unknown;
    result?: unknown;
  }>;
  fileHistoryTracked: Map<string, { key: string | null; version: number }>;
  fileHistoryCheckpoint: Map<string, { key: string; version: number; size?: number }>;
}

export async function parseKimiWireLog(
  wireContent: string,
  sessionId: string,
  mainHomeDir?: string,
): Promise<HostTurnSnapshot[]> {
  const lines = wireContent.split("\n");
  const turns = new Map<number, KimiNativeTurnBuilder>();

  const getOrCreateTurn = (turnId: number): KimiNativeTurnBuilder => {
    let turn = turns.get(turnId);
    if (!turn) {
      turn = {
        turnId,
        input: [],
        contentParts: [],
        toolCalls: new Map(),
        fileHistoryTracked: new Map(),
        fileHistoryCheckpoint: new Map(),
      };
      turns.set(turnId, turn);
    }
    return turn;
  };

  for (let index = 0; index < lines.length; index++) {
    const rawLine = lines[index];
    if (!rawLine) continue;
    const line = rawLine.trim();
    if (!line) continue;

    let record: Record<string, unknown>;
    try {
      record = JSON.parse(line) as Record<string, unknown>;
    } catch {
      if (index === lines.length - 1) {
        // Last line incomplete - wait for next read
        break;
      }
      throw new Error(`Malformed JSON in wire log at line ${index + 1}`);
    }

    const type = record.type;
    const agentId = record.agentId;
    if (agentId !== undefined && agentId !== "main") {
      continue; // Only process main agent events
    }

    if (type === "turn.prompt") {
      const turnId = typeof record.turnId === "number" ? record.turnId : 0;
      const turn = getOrCreateTurn(turnId);
      if (typeof record.promptId === "string") turn.promptId = record.promptId;
      if (typeof record.time === "number") turn.startedAtMs = record.time;

      if (Array.isArray(record.input)) {
        for (const item of record.input) {
          if (typeof item === "object" && item !== null) {
            const raw = item as Record<string, unknown>;
            if (raw.type === "text" && typeof raw.text === "string") {
              turn.input.push({ type: "text", text: raw.text });
            }
          }
        }
      }
    } else if (type === "turn.ended") {
      const turnId = typeof record.turnId === "number" ? record.turnId : 0;
      const turn = getOrCreateTurn(turnId);
      if (typeof record.reason === "string") turn.reason = record.reason;
      if (typeof record.time === "number") turn.completedAtMs = record.time;
    } else if (type === "usage.record") {
      const turnId = typeof record.turnId === "number" ? record.turnId : Array.from(turns.keys()).pop() ?? 0;
      const turn = getOrCreateTurn(turnId);
      if (typeof record.model === "string") {
        turn.model = record.model;
      }
    } else if (type === "file_history.tracked") {
      const turnId = typeof record.turnId === "number" ? record.turnId : 0;
      const turn = getOrCreateTurn(turnId);
      const filePath = typeof record.path === "string" ? record.path : undefined;
      const entry = record.entry as Record<string, unknown> | undefined;
      if (filePath && entry) {
        turn.fileHistoryTracked.set(filePath, {
          key: typeof entry.key === "string" ? entry.key : null,
          version: typeof entry.version === "number" ? entry.version : 1,
        });
      }
    } else if (type === "file_history.checkpoint") {
      const turnId = typeof record.turnId === "number" ? record.turnId : 0;
      const turn = getOrCreateTurn(turnId);
      const entries = record.entries as Record<string, Record<string, unknown>> | undefined;
      if (entries) {
        for (const [filePath, entry] of Object.entries(entries)) {
          if (typeof entry?.key === "string") {
            turn.fileHistoryCheckpoint.set(filePath, {
              key: entry.key,
              version: typeof entry.version === "number" ? entry.version : 1,
              ...(typeof entry.size === "number" ? { size: entry.size } : {}),
            });
          }
        }
      }
    } else if (type === "context.append_loop_event") {
      const event = record.event as Record<string, unknown> | undefined;
      if (!event) continue;

      const eventType = event.type;
      const rawTurnId = event.turnId;
      const turnId = typeof rawTurnId === "number"
        ? rawTurnId
        : typeof rawTurnId === "string"
          ? Number.parseInt(rawTurnId, 10)
          : Array.from(turns.keys()).pop() ?? 0;
      const turn = getOrCreateTurn(turnId);

      if (eventType === "content.part") {
        const part = event.part as Record<string, unknown> | undefined;
        if (part) {
          const isThought = part.type === "thought" || part.type === "think";
          const text = typeof part.text === "string"
            ? part.text
            : typeof part.think === "string"
              ? part.think
              : typeof part.thought === "string"
                ? part.thought
                : "";
          if (text || isThought) {
            turn.contentParts.push({
              text: text || "思考中...",
              thought: isThought,
              ...(typeof event.uuid === "string" ? { uuid: event.uuid } : {}),
            });
          }
        }
      } else if (eventType === "tool.call") {
        const toolCallId = typeof event.toolCallId === "string" ? event.toolCallId : (event.uuid as string) || "unknown";
        const name = typeof event.name === "string" ? event.name : "Tool";
        const args = event.args ?? {};
        const display = event.display;
        turn.toolCalls.set(toolCallId, {
          toolCallId,
          name,
          args,
          display,
        });
      } else if (eventType === "tool.result") {
        const toolCallId = typeof event.toolCallId === "string" ? event.toolCallId : undefined;
        if (toolCallId && turn.toolCalls.has(toolCallId)) {
          const call = turn.toolCalls.get(toolCallId)!;
          call.result = event.result;
        } else {
          // Check by parentUuid
          const parentUuid = typeof event.parentUuid === "string" ? event.parentUuid : undefined;
          if (parentUuid) {
            for (const call of turn.toolCalls.values()) {
              if (call.toolCallId === parentUuid) {
                call.result = event.result;
                break;
              }
            }
          }
        }
      }
    }
  }

  const snapshots: HostTurnSnapshot[] = [];

  for (const [turnId, turn] of turns.entries()) {
    const items: HostItemSnapshot[] = [];
    const sourceToolItemIds: ReturnType<typeof hostItemIdSchema.parse>[] = [];

    // 1. Content and reasoning
    let currentAgentText = "";
    let currentThoughtText = "";

    for (const part of turn.contentParts) {
      if (part.thought) {
        currentThoughtText += part.text;
      } else {
        currentAgentText += part.text;
      }
    }

    if (currentThoughtText) {
      const reasoningItem: HostReasoningItem = {
        type: "reasoning",
        itemId: hostItemIdSchema.parse(`item:${turnId}:reasoning`),
        text: currentThoughtText,
      };
      items.push({
        item: reasoningItem,
        outcome: { status: "succeeded" },
      });
    }

    // 2. Tool calls
    for (const [toolCallId, call] of turn.toolCalls.entries()) {
      const itemId = hostItemIdSchema.parse(`item:${turnId}:tool:${toolCallId.replace(/[^A-Za-z0-9._~-]/g, "_")}`);
      sourceToolItemIds.push(itemId);

      const canonicalName = canonicalizeKimiToolName(call.name, undefined, call.args);
      const isBash = canonicalName.toLowerCase() === "bash" || canonicalName.toLowerCase() === "shell" || canonicalName.toLowerCase() === "terminal";
      const resultObj = (call.result && typeof call.result === "object") ? (call.result as Record<string, unknown>) : undefined;
      const outputText = resultObj?.output ? String(resultObj.output) : (call.result ? JSON.stringify(call.result) : undefined);

      if (isBash) {
        const commandText = typeof (call.args as Record<string, unknown>)?.command === "string"
          ? String((call.args as Record<string, unknown>).command)
          : JSON.stringify(call.args);

        const commandItem: HostCommandExecutionItem = {
          type: "commandExecution",
          itemId,
          command: commandText,
          ...(outputText !== undefined ? { output: outputText } : {}),
        };
        items.push({
          item: commandItem,
          outcome: { status: "succeeded" },
        });
      } else {
        const toolItem: HostToolExecutionItem = {
          type: "toolExecution",
          itemId,
          toolName: canonicalName,
          arguments: (call.args && typeof call.args === "object" && !Array.isArray(call.args)
            ? (call.args as JsonObject)
            : {}),
          ...(outputText !== undefined ? { output: { content: [{ type: "text", text: outputText }] } } : {}),
        };
        items.push({
          item: toolItem,
          outcome: { status: "succeeded" },
        });
      }
    }

    // 3. File changes
    if (mainHomeDir && (turn.fileHistoryCheckpoint.size > 0 || turn.fileHistoryTracked.size > 0)) {
      const changes: HostFileChange[] = [];
      const allPaths = new Set([
        ...turn.fileHistoryTracked.keys(),
        ...turn.fileHistoryCheckpoint.keys(),
      ]);

      for (const filePath of allPaths) {
        const tracked = turn.fileHistoryTracked.get(filePath);
        const checkpoint = turn.fileHistoryCheckpoint.get(filePath);

        let oldContent = "";
        let newContent = "";

        if (tracked?.key) {
          try {
            oldContent = await readFile(path.join(mainHomeDir, tracked.key), "utf8");
          } catch {
            oldContent = "";
          }
        }

        if (checkpoint?.key) {
          try {
            newContent = await readFile(path.join(mainHomeDir, checkpoint.key), "utf8");
          } catch {
            newContent = "";
          }
        }

        if (oldContent !== newContent) {
          const kind: "add" | "update" | "delete" = !tracked || tracked.key === null
            ? "add"
            : !checkpoint
              ? "delete"
              : "update";

          const patch = createTwoFilesPatch(filePath, filePath, oldContent, newContent, "", "");
          changes.push({
            path: filePath.replaceAll("\\", "/"),
            kind,
            unifiedDiff: patch,
          });
        }
      }

      if (changes.length > 0) {
        const fileChangeItem: HostFileChangeItem = {
          type: "fileChange",
          itemId: hostItemIdSchema.parse(`item:${turnId}:fileChanges`),
          changes,
          ...(sourceToolItemIds.length > 0 ? { sourceToolItemIds } : {}),
        };
        items.push({
          item: fileChangeItem,
          outcome: { status: "succeeded" },
        });
      }
    }

    // 4. Agent response
    if (currentAgentText) {
      const agentMessageItem: HostAgentMessageItem = {
        type: "agentMessage",
        itemId: hostItemIdSchema.parse(`item:${turnId}:agentMessage`),
        text: currentAgentText,
      };
      items.push({
        item: agentMessageItem,
        outcome: { status: "succeeded" },
      });
    }

    // 5. Determine turn outcome
    let outcome: HistoricalTurnOutcome;
    if (turn.reason === "completed") {
      outcome = { status: "succeeded" };
    } else if (turn.reason === "cancelled") {
      outcome = { status: "cancelled", reason: "Turn was cancelled" };
    } else if (turn.reason === "failed") {
      outcome = {
        status: "failed",
        error: { code: "nativeFailure", message: "Turn ended with native failure", retryable: false },
      };
    } else {
      outcome = {
        status: "unknown",
        reason: turn.reason ? `Unrecognized native reason: ${turn.reason}` : "Missing turn.ended record",
      };
    }

    snapshots.push({
      nativeTurnRef: createKimiNativeTurnRef(sessionId, turnId),
      input: turn.input.length > 0 ? turn.input : [{ type: "text", text: "" }],
      items,
      outcome,
      ...(turn.model ? { model: encodeKimiModelRef(turn.model) } : {}),
      ...(turn.startedAtMs !== undefined ? { startedAtMs: turn.startedAtMs } : {}),
      ...(turn.completedAtMs !== undefined ? { completedAtMs: turn.completedAtMs } : {}),
    });
  }

  return snapshots;
}

export async function readKimiSessionSnapshot(
  sessionId: string,
  options: { homeDirectory?: string; kimiCodeHome?: string } = {},
): Promise<HostThreadSnapshot> {
  const located = await locateKimiSession(sessionId, options);
  if (!located) {
    throw new Error(`Kimi native session not found: ${sessionId}`);
  }

  const wirePath = path.join(located.mainHomeDir, "wire.jsonl");
  let wireContent = "";
  try {
    wireContent = await readFile(wirePath, "utf8");
  } catch (error) {
    throw new Error(
      `Failed to read Kimi native history ${wirePath}: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }

  const turns = await parseKimiWireLog(wireContent, sessionId, located.mainHomeDir);
  return { turns };
}

export function extractKimiUsageFromWireLog(
  wireContent: string,
  contextWindowTokens?: number,
): HostUsage | null {
  const lines = wireContent.split("\n");
  let inputTokens = 0;
  let outputTokens = 0;
  let cachedInputTokens = 0;
  let cacheWriteInputTokens = 0;
  let contextUsedTokens: number | undefined = undefined;
  let hasUsage = false;

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const record = JSON.parse(trimmed) as Record<string, unknown>;
      const type = record.type;
      if (type === "usage.record" && typeof record.usage === "object" && record.usage !== null) {
        const u = record.usage as Record<string, unknown>;
        if (typeof u.inputOther === "number") inputTokens += u.inputOther;
        if (typeof u.output === "number") outputTokens += u.output;
        if (typeof u.inputCacheRead === "number") cachedInputTokens += u.inputCacheRead;
        if (typeof u.inputCacheCreation === "number") cacheWriteInputTokens += u.inputCacheCreation;
        hasUsage = true;
      }
      if (
        (type === "token_counting.turn_recorded" || type === "token_counting.measured") &&
        typeof record.tokens === "number"
      ) {
        contextUsedTokens = record.tokens;
        hasUsage = true;
      }
    } catch {
      // ignore malformed line
    }
  }

  if (!hasUsage) return null;

  const promptTokens = inputTokens + cachedInputTokens + cacheWriteInputTokens;
  const totalTokens = promptTokens + outputTokens;
  const windowTokens = contextWindowTokens && contextWindowTokens > 0 ? contextWindowTokens : 200_000;

  const effectiveUsedTokens = contextUsedTokens ?? (promptTokens > 0 ? promptTokens : undefined);
  const contextUsagePercent = windowTokens && effectiveUsedTokens !== undefined && windowTokens > 0
    ? (effectiveUsedTokens / windowTokens) * 100
    : undefined;
  const cacheHitRatePercent = promptTokens > 0 && cachedInputTokens !== undefined
    ? (cachedInputTokens / promptTokens) * 100
    : undefined;

  return parseHostUsage({
    inputTokens,
    outputTokens,
    cachedInputTokens,
    cacheWriteInputTokens,
    totalTokens,
    contextWindowTokens: windowTokens,
    ...(effectiveUsedTokens !== undefined ? { contextUsedTokens: effectiveUsedTokens } : {}),
    ...(contextUsagePercent !== undefined ? { contextUsagePercent } : {}),
    ...(cacheHitRatePercent !== undefined ? { cacheHitRatePercent } : {}),
  });
}

export async function readKimiSessionUsage(
  sessionId: string,
  options: { homeDirectory?: string; kimiCodeHome?: string; contextWindowTokens?: number } = {},
): Promise<HostUsage | null> {
  const located = await locateKimiSession(sessionId, options);
  if (!located) return null;

  const wirePath = path.join(located.mainHomeDir, "wire.jsonl");
  try {
    const wireContent = await readFile(wirePath, "utf8");
    return extractKimiUsageFromWireLog(wireContent, options.contextWindowTokens);
  } catch {
    return null;
  }
}
