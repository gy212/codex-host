import { setTimeout as delay } from "node:timers/promises";

import type {
  CreateElicitationRequest,
  CreateElicitationResponse,
  PromptResponse,
  RequestPermissionRequest,
  RequestPermissionResponse,
} from "@agentclientprotocol/sdk";
import {
  HarnessOutputChannel,
  validateHostApprovalResponse,
  validateHostQuestionResponse,
  type HarnessCommandCapability,
  type HarnessCommandInvocation,
  type HarnessError,
  type HarnessOutput,
  type HarnessResult,
  type HarnessSession,
  type HarnessSessionCapabilities,
  type HarnessSessionState,
  type HostAgentMessageItem,
  type HostApprovalInteraction,
  type HostCommand,
  type HostItem,
  type HostItemOutcome,
  type HostQuestionInteraction,
  type HostReasoningItem,
  type HostThreadSnapshot,
  type HostUsage,
  type InteractionRespondAccepted,
  type InteractionRespondCommand,
  type ModelSelectCompleted,
  type ModelSelectCommand,
  type PermissionModeSelectCompleted,
  type PermissionModeSelectCommand,
  type ThinkingSelectCompleted,
  type ThinkingSelectCommand,
  type TurnCancelAccepted,
  type TurnCancelCommand,
  type TurnOutcome,
  type TurnStartAccepted,
  type TurnStartCommand,
} from "@codexhost/harness-adapter";
import {
  harnessCommandCatalogSchema,
  harnessIdSchema,
  harnessPermissionModeIdSchema,
  harnessThinkingOptionIdSchema,
  hostItemIdSchema,
  type HarnessId,
  type HarnessPermissionModeId,
  type HarnessThinkingOptionId,
  type HostInteractionId,
  type HostItemId,
  type HostTurnId,
  type NativeSessionRef,
} from "@codexhost/shared-contracts";

import type {
  ActivePromptHandler,
  KimiTransportEvent,
} from "./acp-transport.js";
import type { KimiAcpTransportLike } from "./kimi-adapter.js";
import {
  createKimiNativeSessionRef,
  createKimiNativeTurnRef,
  locateKimiSession,
  parseKimiWireLog,
  readKimiSessionSnapshot,
} from "./history.js";
import {
  decodeKimiModelRefId,
  encodeKimiModelRef,
  isKimiModeId,
  readKimiEffectiveConfig,
} from "./models.js";
import {
  createHostItemFromToolState,
  formatElicitationResponse,
  KimiToolCallAccumulator,
  parseKimiUsage,
  projectKimiApprovalRequest,
  projectKimiElicitationRequest,
  readAcpToolContentText,
} from "./projection.js";

const kimiHarnessId: HarnessId = harnessIdSchema.parse("kimi-code");

export const kimiSessionCapabilities: HarnessSessionCapabilities = {
  configuration: {
    selectModel: true,
    selectThinkingOption: true,
    selectPermissionMode: true,
    permissionModeScope: "live",
  },
  history: {
    fork: false,
    forkAcrossCwd: false,
    rollbackLastTurn: false,
  },
  subagents: {
    observe: false,
    readTranscript: false,
  },
  autonomousTurns: {
    observe: false,
  },
};

function ok<T>(value: T): HarnessResult<T> {
  return { ok: true, value };
}

function err<T>(code: HarnessError["code"], message: string, retryable = false): HarnessResult<T> {
  return { ok: false, error: { code, message, retryable } };
}

interface ActiveInteraction {
  id: HostInteractionId;
  type: "approval" | "question";
  interaction: HostApprovalInteraction | HostQuestionInteraction;
  resolve: (value: unknown) => void;
  metadata?: unknown;
}

export interface KimiSessionOptions {
  transport: KimiAcpTransportLike;
  sessionId: string;
  cwd: string;
  initialState: HarnessSessionState;
  initialUsage?: HostUsage | null;
  homeDirectory?: string;
}

export class KimiSession implements HarnessSession {
  readonly harnessId: HarnessId = kimiHarnessId;
  readonly capabilities: HarnessSessionCapabilities = kimiSessionCapabilities;
  readonly outputs: AsyncIterable<HarnessOutput>;

  #channel = new HarnessOutputChannel<HarnessOutput>();
  #transport: KimiAcpTransportLike;
  #sessionId: string;
  #cwd: string;
  #state: HarnessSessionState;
  #usage: HostUsage | null = null;
  #homeDirectory?: string;
  #closed = false;
  #activeTurn: {
    turnId: HostTurnId;
    cancellationRequested: boolean;
  } | null = null;
  #activeTurnPromise: Promise<void> | null = null;
  #activeInteraction: ActiveInteraction | null = null;
  #availableCommands: string[] = [];
  #turnCount = 0;

  constructor(options: KimiSessionOptions) {
    this.#transport = options.transport;
    this.#sessionId = options.sessionId;
    this.#cwd = options.cwd;
    this.#state = { ...options.initialState };
    this.#usage = options.initialUsage ?? null;
    if (options.homeDirectory) this.#homeDirectory = options.homeDirectory;
    this.outputs = this.#channel.outputs;
  }

  get initialState(): HarnessSessionState {
    return { ...this.#state };
  }

  get initialUsage(): HostUsage | null {
    return this.#usage ? { ...this.#usage } : null;
  }

  get nativeSessionRef(): NativeSessionRef {
    return createKimiNativeSessionRef(this.#sessionId, this.#cwd);
  }

  get commands(): HarnessCommandCapability {
    return {
      list: async () =>
        ok(
          harnessCommandCatalogSchema.parse({
            commands: this.#availableCommands.map((id) => ({
              id,
              invocation: `/${id}`,
              label: id,
              argumentMode: "text" as const,
              description: `Kimi slash command /${id}`,
            })),
          }),
        ),
      execute: async (invocation: HarnessCommandInvocation) => {
        const slashText = invocation.arguments && typeof invocation.arguments.text === "string"
          ? `/${invocation.commandId} ${invocation.arguments.text}`
          : `/${invocation.commandId}`;

        const startAccepted = await this.execute({
          type: "turn.start",
          turnId: invocation.turnId,
          input: [{ type: "text", text: slashText }],
        });

        if (!startAccepted.ok) return startAccepted;
        return ok({ turnId: invocation.turnId });
      },
    };
  }

  async readSnapshot(): Promise<HarnessResult<HostThreadSnapshot>> {
    if (this.#activeTurn) {
      return err("sessionBusy", "Cannot read snapshot while a turn is active");
    }
    try {
      const snapshot = await readKimiSessionSnapshot(this.#sessionId, {
        ...(this.#homeDirectory ? { homeDirectory: this.#homeDirectory } : {}),
      });
      return ok({
        ...snapshot,
        state: { ...this.#state },
      });
    } catch (error) {
      return err(
        "nativeFailure",
        `Failed to read snapshot: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  execute(command: TurnStartCommand): Promise<HarnessResult<TurnStartAccepted>>;
  execute(command: TurnCancelCommand): Promise<HarnessResult<TurnCancelAccepted>>;
  execute(command: InteractionRespondCommand): Promise<HarnessResult<InteractionRespondAccepted>>;
  execute(command: ModelSelectCommand): Promise<HarnessResult<ModelSelectCompleted>>;
  execute(command: ThinkingSelectCommand): Promise<HarnessResult<ThinkingSelectCompleted>>;
  execute(
    command: PermissionModeSelectCommand,
  ): Promise<HarnessResult<PermissionModeSelectCompleted>>;
  async execute(
    command: HostCommand,
  ): Promise<
    HarnessResult<
      | TurnStartAccepted
      | TurnCancelAccepted
      | InteractionRespondAccepted
      | ModelSelectCompleted
      | ThinkingSelectCompleted
      | PermissionModeSelectCompleted
    >
  > {
    if (this.#closed) {
      return err("invalidState", "Kimi session is closed");
    }

    switch (command.type) {
      case "turn.start":
        return this.#handleTurnStart(command);
      case "turn.cancel":
        return this.#handleTurnCancel(command);
      case "interaction.respond":
        return this.#handleInteractionRespond(command);
      case "model.select":
        return this.#handleModelSelect(command);
      case "thinking.select":
        return this.#handleThinkingSelect(command);
      case "permissionMode.select":
        return this.#handlePermissionModeSelect(command);
      default:
        return err("unsupported", `Unsupported command type`);
    }
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;

    if (this.#activeInteraction) {
      this.#activeInteraction.resolve({ outcome: { outcome: "cancelled" }, action: "cancel" });
      this.#activeInteraction = null;
    }

    if (this.#activeTurn) {
      this.#activeTurn.cancellationRequested = true;
      await this.#transport.cancel().catch(() => undefined);
    }

    await this.#transport.close().catch(() => undefined);

    if (this.#activeTurnPromise) {
      await this.#activeTurnPromise.catch(() => undefined);
      this.#activeTurnPromise = null;
    }

    this.#channel.end();
  }

  #applyConfigOptions(configOptions: unknown[]): void {
    const effective = readKimiEffectiveConfig(configOptions);
    if (effective.modelAlias) this.#state.effectiveModel = encodeKimiModelRef(effective.modelAlias);
    if (effective.thinkingOptionId) this.#state.effectiveThinkingOptionId = effective.thinkingOptionId;
    if (effective.permissionModeId) {
      this.#state.effectivePermissionModeId = harnessPermissionModeIdSchema.parse(effective.permissionModeId);
    }
    this.#channel.emit({
      kind: "event",
      event: { type: "session.state.changed", state: { ...this.#state } },
    });
  }

  async #handleTurnStart(command: TurnStartCommand): Promise<HarnessResult<TurnStartAccepted>> {
    if (this.#activeTurn) {
      return err("sessionBusy", "Another turn is already in progress");
    }

    const turnId = command.turnId;
    this.#activeTurn = {
      turnId,
      cancellationRequested: false,
    };

    // Asynchronously drive the turn on outputs
    this.#activeTurnPromise = this.#runTurn(command);

    return ok({ turnId });
  }

  async #runTurn(command: TurnStartCommand): Promise<void> {
    const turnIndex = this.#turnCount++;
    const turnId = command.turnId;
    this.#channel.emit({ kind: "event", event: { type: "turn.started", turnId } });

    const inputText = command.input.map((i) => i.text).join("\n");
    const accumulator = new KimiToolCallAccumulator();

    let agentMessageItem: HostAgentMessageItem | null = null;
    let reasoningItem: HostReasoningItem | null = null;

    const handler: ActivePromptHandler = {
      onEvent: (event: KimiTransportEvent) => {
        if (this.#closed) return;

        switch (event.type) {
          case "agent.text": {
            if (!agentMessageItem) {
              agentMessageItem = {
                type: "agentMessage",
                itemId: hostItemIdSchema.parse(`item:${turnId}:agentMessage`),
                text: "",
              };
              this.#channel.emit({
                kind: "event",
                event: { type: "item.started", turnId, item: agentMessageItem },
              });
            }
            agentMessageItem.text += event.text;
            this.#channel.emit({
              kind: "event",
              event: {
                type: "item.updated",
                turnId,
                itemId: agentMessageItem.itemId,
                update: { type: "text.append", text: event.text },
              },
            });
            break;
          }
          case "agent.thought": {
            if (!reasoningItem) {
              reasoningItem = {
                type: "reasoning",
                itemId: hostItemIdSchema.parse(`item:${turnId}:reasoning`),
                text: "",
              };
              this.#channel.emit({
                kind: "event",
                event: { type: "item.started", turnId, item: reasoningItem },
              });
            }
            reasoningItem.text += event.text;
            this.#channel.emit({
              kind: "event",
              event: {
                type: "item.updated",
                turnId,
                itemId: reasoningItem.itemId,
                update: { type: "text.append", text: event.text },
              },
            });
            break;
          }
          case "tool.call": {
            const state = accumulator.getOrCreate(event.toolCallId, turnId, event.name, event.kind);
            state.name = event.name;
            if (event.kind) state.kind = event.kind;
            state.rawInput = event.args;
            if (!state.itemStartedEmitted && state.rawInput) {
              state.itemStartedEmitted = true;
              const item = createHostItemFromToolState(state, this.#cwd);
              this.#channel.emit({
                kind: "event",
                event: { type: "item.started", turnId, item },
              });
            }
            break;
          }
          case "tool.update": {
            const state = accumulator.getOrCreate(event.toolCallId, turnId, event.name, event.kind);
            if (event.name) state.name = event.name;
            if (event.kind) state.kind = event.kind;
            if (event.rawInput !== undefined) state.rawInput = event.rawInput;
            if (event.rawOutput !== undefined) state.rawOutput = event.rawOutput;
            if (event.content !== undefined) state.contentAccumulator = readAcpToolContentText(event.content);

            if (!state.itemStartedEmitted && (state.rawInput || state.contentAccumulator)) {
              state.itemStartedEmitted = true;
              const item = createHostItemFromToolState(state, this.#cwd);
              this.#channel.emit({
                kind: "event",
                event: { type: "item.started", turnId, item },
              });
            }

            if (event.status === "completed" || event.status === "failed") {
              state.status = event.status;
              const item = createHostItemFromToolState(state, this.#cwd);
              const outcome: HostItemOutcome = event.status === "completed"
                ? { status: "succeeded" }
                : { status: "failed", error: { code: "nativeFailure", message: "Tool execution failed", retryable: false } };

              this.#channel.emit({
                kind: "event",
                event: {
                  type: "item.completed",
                  turnId,
                  snapshot: { item, outcome },
                },
              });
            }
            break;
          }
          case "usage": {
            const parsedUsage = parseKimiUsage(event.update);
            if (parsedUsage) {
              this.#usage = { ...this.#usage, ...parsedUsage };
              this.#channel.emit({
                kind: "event",
                event: {
                  type: "session.usage.changed",
                  usage: { ...this.#usage },
                },
              });
            }
            break;
          }
          case "commands.update": {
            this.#availableCommands = [...event.commands];
            break;
          }
          case "config.update": {
            this.#applyConfigOptions(event.configOptions);
            break;
          }
          case "mode.update": {
            if (isKimiModeId(event.currentModeId)) {
              this.#state.effectivePermissionModeId = harnessPermissionModeIdSchema.parse(event.currentModeId);
              this.#channel.emit({
                kind: "event",
                event: {
                  type: "session.state.changed",
                  state: { ...this.#state },
                },
              });
            }
            break;
          }
        }
      },
      onPermission: async (request: RequestPermissionRequest): Promise<RequestPermissionResponse> => {
        const projected = projectKimiApprovalRequest(turnId, request);
        return new Promise<RequestPermissionResponse>((resolve) => {
          this.#activeInteraction = {
            id: projected.interaction.interactionId,
            type: "approval",
            interaction: projected.interaction,
            metadata: projected.optionIdByActionId,
            resolve: (val) => resolve(val as RequestPermissionResponse),
          };
          this.#channel.emit({
            kind: "interaction",
            interaction: projected.interaction,
          });
        });
      },
      onElicitation: async (request: CreateElicitationRequest): Promise<CreateElicitationResponse> => {
        const projected = projectKimiElicitationRequest(turnId, request);
        return new Promise<CreateElicitationResponse>((resolve) => {
          this.#activeInteraction = {
            id: projected.interaction.interactionId,
            type: "question",
            interaction: projected.interaction,
            metadata: projected.schemaProperties,
            resolve: (val) => resolve(val as CreateElicitationResponse),
          };
          this.#channel.emit({
            kind: "interaction",
            interaction: projected.interaction,
          });
        });
      },
    };

    let promptResponse: PromptResponse | null = null;
    let promptError: Error | null = null;

    try {
      promptResponse = await this.#transport.prompt(inputText, handler);
    } catch (error) {
      promptError = error instanceof Error ? error : new Error(String(error));
    }

    // Complete any open reasoning / message items
    if (reasoningItem) {
      this.#channel.emit({
        kind: "event",
        event: {
          type: "item.completed",
          turnId,
          snapshot: { item: reasoningItem, outcome: { status: "succeeded" } },
        },
      });
    }

    if (agentMessageItem) {
      this.#channel.emit({
        kind: "event",
        event: {
          type: "item.completed",
          turnId,
          snapshot: { item: agentMessageItem, outcome: { status: "succeeded" } },
        },
      });
    }

    // Poll briefly for native wire log flush
    await delay(300);

    let nativeReason: string | undefined;
    let nativeTurnRef = createKimiNativeTurnRef(this.#sessionId, turnIndex);

    try {
      const located = await locateKimiSession(this.#sessionId, {
        ...(this.#homeDirectory ? { homeDirectory: this.#homeDirectory } : {}),
      });

      if (located) {
        const wireFile = `${located.mainHomeDir}/wire.jsonl`;
        const { readFile: readFsFile } = await import("node:fs/promises");
        const wireContent = await readFsFile(wireFile, "utf8");
        const parsedTurns = await parseKimiWireLog(wireContent, this.#sessionId, located.mainHomeDir);
        const lastTurn = parsedTurns[parsedTurns.length - 1];

        if (lastTurn) {
          nativeTurnRef = lastTurn.nativeTurnRef;
          if (lastTurn.outcome.status === "succeeded") {
            nativeReason = "completed";
          } else if (lastTurn.outcome.status === "cancelled") {
            nativeReason = "cancelled";
          } else if (lastTurn.outcome.status === "failed") {
            nativeReason = "failed";
          }

          // Emit any file change item discovered natively
          for (const itemSnap of lastTurn.items) {
            if (itemSnap.item.type === "fileChange") {
              this.#channel.emit({
                kind: "event",
                event: {
                  type: "item.started",
                  turnId,
                  item: itemSnap.item,
                },
              });
              this.#channel.emit({
                kind: "event",
                event: {
                  type: "item.completed",
                  turnId,
                  snapshot: itemSnap,
                },
              });
            }
          }
        }
      }
    } catch {
      // Fall back to promptResponse status
    }

    // Determine Turn Outcome
    let turnOutcome: TurnOutcome;
    if (this.#activeTurn?.cancellationRequested || promptResponse?.stopReason === "cancelled" || nativeReason === "cancelled") {
      turnOutcome = {
        status: "cancelled",
        reason: "Turn was cancelled",
      };
    } else if (promptError || nativeReason === "failed") {
      turnOutcome = {
        status: "failed",
        error: {
          code: "nativeFailure",
          message: promptError ? promptError.message : "Native turn reported failure",
          retryable: false,
        },
      };
    } else {
      turnOutcome = {
        status: "succeeded",
      };
    }

    this.#channel.emit({
      kind: "event",
      event: {
        type: "turn.completed",
        turnId,
        nativeTurnRef,
        outcome: turnOutcome,
      },
    });

    this.#activeTurn = null;
    this.#activeTurnPromise = null;
  }

  async #handleTurnCancel(command: TurnCancelCommand): Promise<HarnessResult<TurnCancelAccepted>> {
    if (!this.#activeTurn || this.#activeTurn.turnId !== command.turnId) {
      return err("invalidRequest", "No active turn matches the cancellation request");
    }

    this.#activeTurn.cancellationRequested = true;
    await this.#transport.cancel();

    if (this.#activeInteraction) {
      const interaction = this.#activeInteraction;
      this.#activeInteraction = null;
      if (interaction.type === "approval") {
        interaction.resolve({ outcome: { outcome: "cancelled" } });
      } else {
        interaction.resolve({ action: "cancel" });
      }
      this.#channel.emit({
        kind: "event",
        event: {
          type: "interaction.closed",
          interactionId: interaction.id,
          turnId: command.turnId,
          reason: "cancelled",
        },
      });
    }

    return ok({ cancellationRequested: true });
  }

  async #handleInteractionRespond(
    command: InteractionRespondCommand,
  ): Promise<HarnessResult<InteractionRespondAccepted>> {
    const active = this.#activeInteraction;
    if (!active || active.id !== command.interactionId) {
      return err("invalidRequest", `No active interaction matches ID ${command.interactionId}`);
    }

    const turnId = (active.interaction as { turnId: HostTurnId }).turnId;

    if (active.type === "approval") {
      if (command.response.type !== "approval") {
        return err("invalidRequest", `Expected approval response for interaction ${command.interactionId}`);
      }

      const validation = validateHostApprovalResponse(active.interaction as HostApprovalInteraction, command.response);
      if (validation) {
        return err(validation.code, validation.message);
      }

      this.#activeInteraction = null;
      const optionIdMap = active.metadata as ReadonlyMap<string, string>;
      const selectedOptionId = optionIdMap?.get(command.response.actionId) || command.response.actionId;

      this.#channel.emit({
        kind: "event",
        event: {
          type: "interaction.closed",
          interactionId: active.id,
          turnId,
          reason: "responded",
        },
      });

      active.resolve({
        outcome: {
          outcome: "selected",
          optionId: selectedOptionId,
        },
      });

      return ok({ accepted: true });
    }

    if (active.type === "question") {
      if (command.response.type !== "question") {
        return err("invalidRequest", `Expected question response for interaction ${command.interactionId}`);
      }

      const validation = validateHostQuestionResponse(active.interaction as HostQuestionInteraction, command.response);
      if (validation) {
        return err(validation.code, validation.message);
      }

      this.#activeInteraction = null;
      const schemaProps = active.metadata as Record<string, { type: "string" | "array" }>;
      const elicitationResponse = formatElicitationResponse(command.response, schemaProps);

      this.#channel.emit({
        kind: "event",
        event: {
          type: "interaction.closed",
          interactionId: active.id,
          turnId,
          reason: command.response.cancelled ? "cancelled" : "responded",
        },
      });

      active.resolve(elicitationResponse);
      return ok({ accepted: true });
    }

    return err("invalidRequest", `Interaction type mismatch for ${command.interactionId}`);
  }

  async #handleModelSelect(command: ModelSelectCommand): Promise<HarnessResult<ModelSelectCompleted>> {
    let alias: string;
    try {
      alias = decodeKimiModelRefId(command.model.id);
    } catch {
      return err("invalidRequest", `Invalid model reference: ${command.model.id}`);
    }

    try {
      const confirmed = await this.#transport.setConfigOption("model", alias);
      this.#applyConfigOptions(confirmed);
      if (this.#state.effectiveModel?.id !== command.model.id) {
        return err("unavailable", `Kimi did not confirm model ${alias}`);
      }
      return ok({ completed: true });
    } catch (error) {
      return err(
        "unavailable",
        `Failed to select model ${alias}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  async #handleThinkingSelect(
    command: ThinkingSelectCommand,
  ): Promise<HarnessResult<ThinkingSelectCompleted>> {
    try {
      const confirmed = await this.#transport.setConfigOption("thinking", command.thinkingOptionId);
      this.#applyConfigOptions(confirmed);
      if (this.#state.effectiveThinkingOptionId !== command.thinkingOptionId) {
        return err("unavailable", `Kimi did not confirm thinking option ${command.thinkingOptionId}`);
      }
      return ok({ completed: true });
    } catch (error) {
      return err(
        "unavailable",
        `Failed to set thinking option: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  async #handlePermissionModeSelect(
    command: PermissionModeSelectCommand,
  ): Promise<HarnessResult<PermissionModeSelectCompleted>> {
    if (!isKimiModeId(command.permissionModeId)) {
      return err("unsupported", `Unsupported permission mode: ${command.permissionModeId}`);
    }

    try {
      const confirmed = await this.#transport.setConfigOption("mode", command.permissionModeId);
      this.#applyConfigOptions(confirmed);
      if (this.#state.effectivePermissionModeId !== command.permissionModeId) {
        return err("unavailable", `Kimi did not confirm permission mode ${command.permissionModeId}`);
      }
      return ok({ completed: true });
    } catch (error) {
      return err(
        "unavailable",
        `Failed to set permission mode: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
}
