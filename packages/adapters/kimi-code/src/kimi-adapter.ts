import { readFile } from "node:fs/promises";
import path from "node:path";

import type {
  HarnessAdapter,
  HarnessErrorCode,
  HarnessInspection,
  HarnessResult,
  HarnessSession,
  HarnessSessionState,
  InspectHarnessInput,
  OpenSessionInput,
} from "@codexhost/harness-adapter";
import {
  harnessIdSchema,
  harnessPermissionModeIdSchema,
  harnessThinkingOptionIdSchema,
  type HarnessCommandCatalog,
  type HarnessId,
  type HarnessModelCatalog,
} from "@codexhost/shared-contracts";
import type {
  InitializeResponse,
  PromptResponse,
} from "@agentclientprotocol/sdk";

import {
  KimiAcpTransport,
  KimiTransportError,
  type ActivePromptHandler,
  type KimiAcpTransportOptions,
  type SessionEventHandler,
} from "./acp-transport.js";
import { resolveKimiExecutable } from "./command.js";
import {
  createKimiNativeSessionRef,
  getKimiCodeHome,
  locateKimiSession,
  readKimiSessionUsage,
} from "./history.js";
import {
  buildModelCatalogFromConfig,
  decodeKimiModelRefId,
  encodeKimiModelRef,
  isKimiModeId,
  kimiPermissionModeCatalog,
  parseKimiConfigToml,
  readKimiEffectiveConfig,
  resolveKimiContextWindow,
  type KimiNativeConfig,
} from "./models.js";
import {
  KimiSession,
  kimiSessionCapabilities,
} from "./kimi-session.js";
import { KIMI_DEFAULT_COMMAND_CATALOG } from "./slash-commands.js";

const kimiHarnessId: HarnessId = harnessIdSchema.parse("kimi-code");

function ok<T>(value: T): HarnessResult<T> {
  return { ok: true, value };
}

function err<T>(code: HarnessErrorCode, message: string, retryable = false): HarnessResult<T> {
  return { ok: false, error: { code, message, retryable } };
}

export interface KimiAcpTransportLike {
  readonly sessionId: string | null;
  readonly isClosed: boolean;
  setActivePromptHandler(handler: ActivePromptHandler | null): void;
  setSessionEventHandler(handler: SessionEventHandler | null): void;
  inspect(): Promise<{
    initialize: InitializeResponse;
    authReady: boolean;
  }>;
  openSession(input: {
    kind: "create" | "resume" | "load" | "fork";
    sessionId?: string;
    cwd?: string;
  }): Promise<{
    sessionId: string;
    configOptions?: unknown[];
    modes?: unknown;
  }>;
  setConfigOption(configId: string, value: string): Promise<unknown[]>;
  prompt(text: string, handler: ActivePromptHandler): Promise<PromptResponse>;
  cancel(): Promise<void>;
  close(): Promise<void>;
}

export interface KimiAdapterDependencies {
  createTransport?: (options: KimiAcpTransportOptions) => KimiAcpTransportLike;
  resolveExecutable?: (input: {
    command?: string;
    environment?: NodeJS.ProcessEnv;
    homeDirectory?: string;
  }) => string;
}

export interface KimiAdapterOptions {
  command?: string;
  environment?: NodeJS.ProcessEnv;
  commandTimeoutMs?: number;
  closeTimeoutMs?: number;
  homeDirectory?: string;
}

async function applyRequestedConfig(
  transport: KimiAcpTransportLike,
  configOptions: unknown[] | undefined,
  requested: Array<{ id: "model" | "thinking" | "mode"; value: string }>,
): Promise<unknown[]> {
  let confirmed = configOptions ?? [];
  for (const option of requested) {
    confirmed = await transport.setConfigOption(option.id, option.value);
    const effective = readKimiEffectiveConfig(confirmed);
    const actual = option.id === "model"
      ? effective.modelAlias
      : option.id === "thinking"
        ? effective.thinkingOptionId
        : effective.permissionModeId;
    if (actual !== option.value) {
      throw new Error(`Kimi did not confirm ${option.id}=${option.value}`);
    }
  }
  return confirmed;
}

function stateFromConfig(sessionId: string, cwd: string, configOptions: unknown[]): HarnessSessionState {
  const effective = readKimiEffectiveConfig(configOptions);
  return {
    nativeRef: createKimiNativeSessionRef(sessionId, cwd),
    ...(effective.modelAlias ? { effectiveModel: encodeKimiModelRef(effective.modelAlias) } : {}),
    ...(effective.thinkingOptionId ? { effectiveThinkingOptionId: effective.thinkingOptionId } : {}),
    ...(effective.permissionModeId
      ? { effectivePermissionModeId: harnessPermissionModeIdSchema.parse(effective.permissionModeId) }
      : {}),
  };
}

export class KimiAdapter implements HarnessAdapter {
  readonly harnessId: HarnessId = kimiHarnessId;

  #options: KimiAdapterOptions;
  #deps: KimiAdapterDependencies;
  #sessions = new Set<KimiSession>();
  #inspectionCache: HarnessInspection | null = null;
  #closed = false;
  #commandCatalog: HarnessCommandCatalog = KIMI_DEFAULT_COMMAND_CATALOG;

  get commandCatalog(): HarnessCommandCatalog {
    return this.#commandCatalog;
  }

  constructor(options: KimiAdapterOptions = {}, dependencies: KimiAdapterDependencies = {}) {
    this.#options = options;
    this.#deps = dependencies;
  }

  #createTransport(options: KimiAcpTransportOptions): KimiAcpTransportLike {
    return this.#deps.createTransport ? this.#deps.createTransport(options) : new KimiAcpTransport(options);
  }

  #resolveExecutable(input: {
    command?: string;
    environment?: NodeJS.ProcessEnv;
    homeDirectory?: string;
  }): string {
    return this.#deps.resolveExecutable ? this.#deps.resolveExecutable(input) : resolveKimiExecutable(input);
  }

  async inspect(input: InspectHarnessInput = {}): Promise<HarnessInspection> {
    if (!input.refresh && this.#inspectionCache) {
      return this.#inspectionCache;
    }

    const cwd = input.cwd ?? process.cwd();
    const environment = { ...process.env, ...this.#options.environment };

    // 1. Resolve executable
    let executable: string;
    try {
      executable = this.#resolveExecutable({
        ...(this.#options.command ? { command: this.#options.command } : {}),
        environment,
        ...(this.#options.homeDirectory ? { homeDirectory: this.#options.homeDirectory } : {}),
      });
    } catch (error) {
      const result: HarnessInspection = {
        status: "notInstalled",
        error: {
          code: "notInstalled",
          message: error instanceof Error ? error.message : "Kimi Code CLI is not installed",
          retryable: false,
        },
      };
      this.#inspectionCache = result;
      return result;
    }

    // 2. Read native config.toml
    const kimiHome = getKimiCodeHome(this.#options.homeDirectory, environment);
    const configPath = path.join(kimiHome, "config.toml");
    let nativeConfig: KimiNativeConfig | null = null;

    try {
      const configContent = await readFile(configPath, "utf8");
      nativeConfig = parseKimiConfigToml(configContent);
    } catch {
      nativeConfig = null;
    }

    // 3. Test ACP handshake and auth readiness (without creating a session!)
    const transport = this.#createTransport({
      cwd,
      command: executable,
      environment,
      commandTimeoutMs: this.#options.commandTimeoutMs ?? 15_000,
      closeTimeoutMs: this.#options.closeTimeoutMs ?? 5_000,
    });

    let authReady = false;
    try {
      const inspectionResult = await transport.inspect();
      authReady = inspectionResult.authReady;
    } catch (error) {
      await transport.close().catch(() => undefined);
      const isNotInstalled = error instanceof KimiTransportError && error.kind === "notInstalled";
      const result: HarnessInspection = {
        status: isNotInstalled ? "notInstalled" : "unavailable",
        error: {
          code: isNotInstalled ? "notInstalled" : "unavailable",
          message: error instanceof Error ? error.message : String(error),
          retryable: false,
        },
      };
      this.#inspectionCache = result;
      return result;
    } finally {
      await transport.close().catch(() => undefined);
    }

    if (!authReady) {
      const result: HarnessInspection = {
        status: "error",
        error: {
          code: "authenticationRequired",
          message: "Kimi Code CLI authentication is required (run `kimi login`)",
          retryable: false,
        },
      };
      this.#inspectionCache = result;
      return result;
    }

    // 4. Build Model Catalog
    let modelCatalog: HarnessModelCatalog;
    if (nativeConfig && nativeConfig.models.length > 0) {
      modelCatalog = buildModelCatalogFromConfig(nativeConfig);
    } else {
      modelCatalog = {
        models: [],
        thinkingOptions: [
          { id: harnessThinkingOptionIdSchema.parse("off"), label: "Off" },
          { id: harnessThinkingOptionIdSchema.parse("medium"), label: "Medium" },
          { id: harnessThinkingOptionIdSchema.parse("high"), label: "High" },
        ],
      };
    }

    const inspection: HarnessInspection = {
      status: "ready",
      catalog: modelCatalog,
      permissionModes: kimiPermissionModeCatalog,
      capabilities: kimiSessionCapabilities,
    };

    this.#inspectionCache = inspection;
    return inspection;
  }

  async open(input: OpenSessionInput): Promise<HarnessResult<HarnessSession>> {
    if (this.#closed) {
      return err("invalidState", "Adapter is closed");
    }

    if (input.kind === "fork" || input.kind === "rollbackLastTurn") {
      return err("unsupported", `Kimi Code does not support ${input.kind}`);
    }
    if (input.kind === "create" && input.executionPolicy === "unattended-full-access") {
      return err("unsupported", "Kimi Code cannot guarantee unattended-full-access");
    }
    if (input.kind === "resume" && input.nativeRef.harnessId !== this.harnessId) {
      return err("invalidRequest", "Native Session belongs to a different Harness");
    }
    if (input.permissionModeId && !isKimiModeId(input.permissionModeId)) {
      return err("invalidRequest", `Unsupported permission mode: ${input.permissionModeId}`);
    }
    let requestedModelAlias: string | undefined;
    try {
      if (input.model) requestedModelAlias = decodeKimiModelRefId(input.model.id);
    } catch (error) {
      return err("invalidRequest", error instanceof Error ? error.message : String(error));
    }
    const environment = { ...process.env, ...this.#options.environment, ...input.environment };
    const cwd = input.cwd ?? process.cwd();
    const kimiCodeHome = getKimiCodeHome(this.#options.homeDirectory, environment);

    let executable: string;
    try {
      executable = this.#resolveExecutable({
        ...(this.#options.command ? { command: this.#options.command } : {}),
        environment,
        ...(this.#options.homeDirectory ? { homeDirectory: this.#options.homeDirectory } : {}),
      });
    } catch (error) {
      return err("notInstalled", error instanceof Error ? error.message : "Kimi CLI not found");
    }

    let session: KimiSession | null = null;
    const transport = this.#createTransport({
      cwd,
      command: executable,
      environment,
      ...(this.#options.commandTimeoutMs ? { commandTimeoutMs: this.#options.commandTimeoutMs } : {}),
      ...(this.#options.closeTimeoutMs ? { closeTimeoutMs: this.#options.closeTimeoutMs } : {}),
      onFault: (error) => session?.handleTransportFault(error),
    });

    const kimiHome = getKimiCodeHome(this.#options.homeDirectory, environment);
    const configPath = path.join(kimiHome, "config.toml");
    let nativeConfig: KimiNativeConfig | null = null;
    try {
      const configContent = await readFile(configPath, "utf8");
      nativeConfig = parseKimiConfigToml(configContent);
    } catch {
      nativeConfig = null;
    }

    const selectedModelAlias = requestedModelAlias ?? nativeConfig?.defaultModel;
    const contextWindowTokens = resolveKimiContextWindow(selectedModelAlias, nativeConfig);

    if (input.kind === "create") {
      try {
        const sessionInfo = await transport.openSession({ kind: "create", cwd });
        if (input.permissionModeId && !isKimiModeId(input.permissionModeId)) {
          throw new Error(`Unsupported permission mode: ${input.permissionModeId}`);
        }
        const requested = [
          ...(input.model ? [{ id: "model" as const, value: decodeKimiModelRefId(input.model.id) }] : []),
          ...(input.thinkingOptionId ? [{ id: "thinking" as const, value: input.thinkingOptionId }] : []),
          ...(input.permissionModeId ? [{ id: "mode" as const, value: input.permissionModeId }] : []),
        ];
        const configOptions = await applyRequestedConfig(transport, sessionInfo.configOptions, requested);
        const state = stateFromConfig(sessionInfo.sessionId, cwd, configOptions);

        session = new KimiSession({
          transport,
          sessionId: sessionInfo.sessionId,
          cwd,
          initialState: state,
          contextWindowTokens,
          kimiCodeHome,
          ...(this.#options.homeDirectory ? { homeDirectory: this.#options.homeDirectory } : {}),
          onCommandsUpdate: (catalog) => {
            this.#commandCatalog = catalog;
          },
        });

        this.#sessions.add(session);
        return ok(session);
      } catch (error) {
        await transport.close().catch(() => undefined);
        return err(
          "nativeFailure",
          `Failed to create Kimi session: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }

    if (input.kind === "resume") {
      const sessionId = input.nativeRef.nativeSessionId;

      try {
        const located = await locateKimiSession(sessionId, {
          kimiCodeHome,
          ...(this.#options.homeDirectory ? { homeDirectory: this.#options.homeDirectory } : {}),
        });
        if (!located) {
          await transport.close().catch(() => undefined);
          return err("sessionNotFound", `Kimi native session not found: ${sessionId}`);
        }
        const sessionInfo = await transport.openSession({
          kind: "load",
          sessionId,
          cwd,
        });

        if (sessionInfo.sessionId !== sessionId) throw new Error("Kimi resumed a different Native Session");

        if (input.permissionModeId && !isKimiModeId(input.permissionModeId)) {
          throw new Error(`Unsupported permission mode: ${input.permissionModeId}`);
        }
        const requested = [
          ...(input.model ? [{ id: "model" as const, value: decodeKimiModelRefId(input.model.id) }] : []),
          ...(input.thinkingOptionId ? [{ id: "thinking" as const, value: input.thinkingOptionId }] : []),
          ...(input.permissionModeId ? [{ id: "mode" as const, value: input.permissionModeId }] : []),
        ];
        const configOptions = await applyRequestedConfig(transport, sessionInfo.configOptions, requested);
        const state = stateFromConfig(sessionInfo.sessionId, cwd, configOptions);

        const initialUsage = await readKimiSessionUsage(sessionId, {
          kimiCodeHome,
          ...(this.#options.homeDirectory ? { homeDirectory: this.#options.homeDirectory } : {}),
          contextWindowTokens,
        });

        session = new KimiSession({
          transport,
          sessionId: sessionInfo.sessionId,
          cwd,
          initialState: state,
          initialUsage,
          contextWindowTokens,
          kimiCodeHome,
          ...(this.#options.homeDirectory ? { homeDirectory: this.#options.homeDirectory } : {}),
          onCommandsUpdate: (catalog) => {
            this.#commandCatalog = catalog;
          },
        });

        this.#sessions.add(session);
        return ok(session);
      } catch (error) {
        await transport.close().catch(() => undefined);
        return err(
          "nativeFailure",
          `Failed to resume Kimi session: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }

    await transport.close().catch(() => undefined);
    return err("unsupported", `Unsupported open kind`);
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    this.#commandCatalog = KIMI_DEFAULT_COMMAND_CATALOG;

    for (const session of this.#sessions) {
      await session.close().catch(() => undefined);
    }
    this.#sessions.clear();
  }
}
