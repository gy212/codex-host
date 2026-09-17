import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { Readable, Writable } from "node:stream";

import { sanitizeDiagnosticTail } from "@codexhost/harness-adapter";
import {
  ClientSideConnection,
  PROTOCOL_VERSION,
  ndJsonStream,
  type Client,
  type CreateElicitationRequest,
  type CreateElicitationResponse,
  type InitializeResponse,
  type LoadSessionResponse,
  type NewSessionResponse,
  type PromptResponse,
  type RequestPermissionRequest,
  type RequestPermissionResponse,
  type SessionNotification,
  type SessionUpdate,
} from "@agentclientprotocol/sdk";

import { KimiExecutableError, kimiInvocation, resolveKimiExecutable } from "./command.js";

export type KimiTransportFaultKind =
  | "notInstalled"
  | "authenticationRequired"
  | "unavailable"
  | "protocolError"
  | "processExited"
  | "unsupported";

export class KimiTransportError extends Error {
  readonly diagnostic: string | undefined;

  constructor(
    readonly kind: KimiTransportFaultKind,
    message: string,
    options?: ErrorOptions & { diagnostic?: string },
  ) {
    super(message, options);
    this.diagnostic = options?.diagnostic;
    this.name = "KimiTransportError";
  }
}

export class KimiRequestTimeoutError extends KimiTransportError {
  constructor(operation: string, timeoutMs: number) {
    super("unavailable", `${operation} timed out after ${timeoutMs}ms`);
    this.name = "KimiRequestTimeoutError";
  }
}

export async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  operation: string,
): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new KimiRequestTimeoutError(operation, timeoutMs)), timeoutMs);
  });
  try {
    return await Promise.race([promise, timeoutPromise]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export type KimiTransportEvent =
  | { type: "agent.text"; text: string }
  | { type: "agent.thought"; text: string }
  | { type: "tool.call"; toolCallId: string; name: string; args?: unknown }
  | { type: "tool.update"; toolCallId: string; status?: string; rawInput?: unknown; rawOutput?: unknown; content?: unknown }
  | { type: "usage"; update: Record<string, unknown> }
  | { type: "config.update"; configOptions: unknown[] }
  | { type: "mode.update"; currentModeId: string }
  | { type: "commands.update"; commands: string[] };

export interface ActivePromptHandler {
  onEvent(event: KimiTransportEvent): void;
  onPermission(request: RequestPermissionRequest): Promise<RequestPermissionResponse>;
  onElicitation(request: CreateElicitationRequest): Promise<CreateElicitationResponse>;
}

export interface KimiAcpTransportOptions {
  cwd: string;
  command?: string;
  environment?: NodeJS.ProcessEnv;
  commandTimeoutMs?: number;
  closeTimeoutMs?: number;
  onFault?: (error: KimiTransportError) => void;
}

export function projectKimiTextUpdate(
  update: Record<string, unknown>,
): Extract<KimiTransportEvent, { type: "agent.text" | "agent.thought" }> | null {
  const content = update.content;
  const text = content && typeof content === "object" && (content as Record<string, unknown>).type === "text"
    && typeof (content as Record<string, unknown>).text === "string"
    ? (content as Record<string, unknown>).text as string
    : "";

  if (update.sessionUpdate === "agent_message_chunk") return { type: "agent.text", text };
  if (update.sessionUpdate === "agent_thought_chunk") return { type: "agent.thought", text };
  return null;
}

export class KimiAcpTransport {
  #options: KimiAcpTransportOptions;
  #child: ChildProcessWithoutNullStreams | null = null;
  #connection: ClientSideConnection | null = null;
  #initializeResponse: InitializeResponse | null = null;
  #activePrompt: ActivePromptHandler | null = null;
  #sessionId: string | null = null;
  #stderrTail = "";
  #closed = false;
  #closing = false;
  #commandTimeoutMs: number;
  #closeTimeoutMs: number;
  #pendingConfigUpdates: Array<(configOptions: unknown[]) => void> = [];

  constructor(options: KimiAcpTransportOptions) {
    this.#options = options;
    this.#commandTimeoutMs = options.commandTimeoutMs ?? 30_000;
    this.#closeTimeoutMs = options.closeTimeoutMs ?? 5_000;
  }

  get sessionId(): string | null {
    return this.#sessionId;
  }

  get isClosed(): boolean {
    return this.#closed;
  }

  setActivePromptHandler(handler: ActivePromptHandler | null): void {
    this.#activePrompt = handler;
  }

  async inspect(): Promise<{
    initialize: InitializeResponse;
    authReady: boolean;
  }> {
    const initialize = await this.#ensureInitialized();
    let authReady = false;
    try {
      if (this.#connection) {
        await withTimeout(
          this.#connection.authenticate({ methodId: "login" }),
          this.#commandTimeoutMs,
          "Kimi authenticate check",
        );
        authReady = true;
      }
    } catch (error) {
      // Authentication check might fail if not logged in
      authReady = false;
    }
    return { initialize, authReady };
  }

  async openSession(input: {
    kind: "create" | "resume" | "load";
    sessionId?: string;
    cwd?: string;
  }): Promise<{
    sessionId: string;
    configOptions?: unknown[];
    modes?: unknown;
  }> {
    await this.#ensureInitialized();
    const connection = this.#connection;
    if (!connection) throw new KimiTransportError("unavailable", "Kimi ACP is unavailable");

    const targetCwd = input.cwd || this.#options.cwd;

    if (input.kind === "create") {
      const created = await withTimeout(
        connection.newSession({ cwd: targetCwd, mcpServers: [] }),
        this.#commandTimeoutMs,
        "Kimi session/new",
      );
      this.#sessionId = created.sessionId;
      const createdRaw = created as { configOptions?: unknown[]; modes?: unknown };
      return {
        sessionId: created.sessionId,
        ...(Array.isArray(createdRaw.configOptions) ? { configOptions: createdRaw.configOptions } : {}),
        ...(createdRaw.modes !== undefined ? { modes: createdRaw.modes } : {}),
      };
    }

    if (!input.sessionId) {
      throw new KimiTransportError("unavailable", "Session ID required for resume/load");
    }

    this.#sessionId = input.sessionId;

    // Kimi supports session/load (and session/resume)
    let loaded: unknown;
    try {
      loaded = await withTimeout(
        connection.loadSession({
          sessionId: input.sessionId,
          cwd: targetCwd,
          mcpServers: [],
        }),
        this.#commandTimeoutMs,
        "Kimi session/load",
      );
    } catch (error) {
      throw new KimiTransportError(
        "unavailable",
        `Failed to load session ${input.sessionId}: ${error instanceof Error ? error.message : String(error)}`,
        { cause: error },
      );
    }

    const raw = (loaded && typeof loaded === "object" ? loaded : {}) as Record<string, unknown>;
    return {
      sessionId: input.sessionId,
      ...(Array.isArray(raw.configOptions) ? { configOptions: raw.configOptions as unknown[] } : {}),
      ...(raw.modes !== undefined ? { modes: raw.modes } : {}),
    };
  }

  async setConfigOption(configId: string, value: string): Promise<unknown[]> {
    const connection = this.#connection;
    const sessionId = this.#sessionId;
    if (!connection || !sessionId || this.#closed) {
      throw new KimiTransportError("unavailable", "Kimi ACP session is not available");
    }

    try {
      const response = await withTimeout(
        connection.setSessionConfigOption({
          sessionId,
          configId,
          value,
        }),
        this.#commandTimeoutMs,
        `Kimi set_config_option (${configId})`,
      );

      const raw = response as { configOptions?: unknown[] };
      return Array.isArray(raw?.configOptions) ? raw.configOptions : [];
    } catch (error) {
      throw new KimiTransportError(
        "unavailable",
        `Failed to set config option ${configId}: ${error instanceof Error ? error.message : String(error)}`,
        { cause: error },
      );
    }
  }

  async prompt(
    text: string,
    handler: ActivePromptHandler,
  ): Promise<PromptResponse> {
    const connection = this.#connection;
    const sessionId = this.#sessionId;
    if (!connection || !sessionId || this.#closed) {
      throw new KimiTransportError("unavailable", "Kimi ACP session is not available");
    }

    this.#activePrompt = handler;
    try {
      return await connection.prompt({
        sessionId,
        prompt: [{ type: "text", text }],
      });
    } catch (error) {
      throw new KimiTransportError(
        "unavailable",
        `Kimi session/prompt failed: ${error instanceof Error ? error.message : String(error)}`,
        { cause: error },
      );
    } finally {
      if (this.#activePrompt === handler) {
        this.#activePrompt = null;
      }
    }
  }

  async cancel(): Promise<void> {
    const connection = this.#connection;
    const sessionId = this.#sessionId;
    if (!connection || !sessionId || this.#closed) return;

    try {
      await connection.cancel({ sessionId });
    } catch {
      // Cancellation is best effort
    }
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closing = true;

    const child = this.#child;
    const connection = this.#connection;
    const sessionId = this.#sessionId;

    if (connection && sessionId) {
      try {
        await withTimeout(
          connection.request("session/close", { sessionId }),
          Math.min(2000, this.#closeTimeoutMs),
          "Kimi session/close",
        );
      } catch {
        // Ignore errors during session close
      }
    }

    if (child && child.exitCode === null) {
      const exited = new Promise<void>((resolve) => {
        child.once("exit", () => resolve());
      });

      try {
        child.stdin.end();
      } catch {
        // Ignore
      }

      const timer = setTimeout(() => {
        try {
          child.kill("SIGTERM");
        } catch {
          // Ignore
        }
      }, Math.min(2500, this.#closeTimeoutMs));

      await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, this.#closeTimeoutMs))]);
      clearTimeout(timer);

      if (child.exitCode === null) {
        try {
          child.kill("SIGKILL");
        } catch {
          // Ignore
        }
      }
    }

    this.#closed = true;
    this.#closing = false;
    this.#connection = null;
    this.#child = null;
  }

  async #ensureInitialized(): Promise<InitializeResponse> {
    if (this.#initializeResponse) return this.#initializeResponse;
    if (this.#child || this.#closed) {
      throw new KimiTransportError("unavailable", "Kimi ACP transport cannot be started twice");
    }

    let executable: string;
    try {
      executable = resolveKimiExecutable({
        ...(this.#options.command ? { command: this.#options.command } : {}),
        ...(this.#options.environment ? { environment: this.#options.environment } : {}),
      });
    } catch (error) {
      if (error instanceof KimiExecutableError) {
        throw new KimiTransportError("notInstalled", error.message);
      }
      throw new KimiTransportError("unavailable", String(error));
    }

    const invocation = kimiInvocation(executable, this.#options.environment);
    const child = spawn(invocation.command, invocation.arguments, {
      cwd: this.#options.cwd,
      env: { ...process.env, ...this.#options.environment },
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
      windowsVerbatimArguments: invocation.windowsVerbatimArguments,
    });
    this.#child = child;

    child.stderr.on("data", (chunk: Buffer | string) => {
      this.#stderrTail = sanitizeDiagnosticTail(`${this.#stderrTail}${chunk.toString()}`);
    });

    child.on("error", (error) => {
      this.#fault(new KimiTransportError("unavailable", `Process error: ${error.message}`, { diagnostic: this.#stderrTail }));
    });

    child.on("exit", (code, signal) => {
      if (!this.#closing && !this.#closed) {
        this.#fault(
          new KimiTransportError(
            "processExited",
            `Kimi process exited prematurely (code ${code}, signal ${signal})`,
            { diagnostic: this.#stderrTail },
          ),
        );
      }
    });

    await withTimeout(
      new Promise<void>((resolve, reject) => {
        child.once("spawn", resolve);
        child.once("error", reject);
      }),
      this.#commandTimeoutMs,
      "Kimi CLI spawn",
    );

    const stream = ndJsonStream(
      Writable.toWeb(child.stdin) as WritableStream<Uint8Array>,
      Readable.toWeb(child.stdout) as ReadableStream<Uint8Array>,
    );

    const client: Client = {
      sessionUpdate: (params: SessionNotification) => this.#handleSessionUpdate(params),
      requestPermission: (params: RequestPermissionRequest) => this.#handleRequestPermission(params),
      unstable_createElicitation: (params: CreateElicitationRequest) => this.#handleCreateElicitation(params),
      extMethod: (method: string, params: Record<string, unknown>) => this.#handleExtMethod(method, params),
      extNotification: (method: string, params: Record<string, unknown>) => this.#handleExtNotification(method, params),
    };

    const connection = new ClientSideConnection(() => client, stream);
    this.#connection = connection;

    try {
      const response = await withTimeout(
        connection.initialize({
          protocolVersion: 1,
          clientCapabilities: {
            elicitation: { form: {} },
          },
          clientInfo: {
            name: "codexhost",
            version: "0.9.0",
          },
        }),
        this.#commandTimeoutMs,
        "Kimi initialize",
      );

      if (response.protocolVersion !== 1) {
        throw new KimiTransportError(
          "protocolError",
          `Unsupported Kimi protocol version: ${response.protocolVersion}`,
        );
      }

      this.#initializeResponse = response;
      return response;
    } catch (error) {
      await this.close().catch(() => undefined);
      if (error instanceof KimiTransportError) throw error;
      throw new KimiTransportError("unavailable", `Failed to initialize Kimi ACP: ${error instanceof Error ? error.message : String(error)}`, {
        cause: error,
        diagnostic: this.#stderrTail,
      });
    }
  }

  #handleSessionUpdate(notification: SessionNotification): void {
    const update = notification.update as Record<string, unknown>;
    if (!update) return;

    const sessionUpdate = typeof update.sessionUpdate === "string" ? update.sessionUpdate : undefined;
    const textEvent = projectKimiTextUpdate(update);

    if (textEvent) {
      this.#activePrompt?.onEvent(textEvent);
    } else if (sessionUpdate === "tool_call") {
      const toolCallId = typeof update.toolCallId === "string" ? update.toolCallId : "";
      const name = typeof update.name === "string" ? update.name : "Tool";
      const args = update.args;
      this.#activePrompt?.onEvent({ type: "tool.call", toolCallId, name, args });
    } else if (sessionUpdate === "tool_call_update") {
      const toolCallId = typeof update.toolCallId === "string" ? update.toolCallId : "";
      const status = typeof update.status === "string" ? update.status : undefined;
      const rawInput = update.rawInput;
      const rawOutput = update.rawOutput;
      const content = update.content;
      this.#activePrompt?.onEvent({
        type: "tool.update",
        toolCallId,
        ...(status !== undefined ? { status } : {}),
        ...(rawInput !== undefined ? { rawInput } : {}),
        ...(rawOutput !== undefined ? { rawOutput } : {}),
        ...(content !== undefined ? { content } : {}),
      });
    } else if (sessionUpdate === "usage_update") {
      this.#activePrompt?.onEvent({ type: "usage", update });
    } else if (sessionUpdate === "config_option_update") {
      const configOptions = Array.isArray(update.configOptions) ? update.configOptions : [];
      this.#activePrompt?.onEvent({ type: "config.update", configOptions });
      for (const listener of this.#pendingConfigUpdates) {
        listener(configOptions);
      }
    } else if (sessionUpdate === "current_mode_update") {
      const currentModeId = typeof update.currentModeId === "string" ? update.currentModeId : "";
      this.#activePrompt?.onEvent({ type: "mode.update", currentModeId });
    } else if (sessionUpdate === "available_commands_update") {
      const commands = Array.isArray(update.commands) ? (update.commands as string[]) : [];
      this.#activePrompt?.onEvent({ type: "commands.update", commands });
    }
  }

  async #handleRequestPermission(
    request: RequestPermissionRequest,
  ): Promise<RequestPermissionResponse> {
    if (this.#activePrompt) {
      return this.#activePrompt.onPermission(request);
    }
    // Default fallback: cancel
    return { outcome: { outcome: "cancelled" } };
  }

  async #handleCreateElicitation(
    request: CreateElicitationRequest,
  ): Promise<CreateElicitationResponse> {
    if (this.#activePrompt) {
      return this.#activePrompt.onElicitation(request);
    }
    // Default fallback: cancel
    return { action: "cancel" };
  }

  async #handleExtMethod(method: string, params: Record<string, unknown>): Promise<Record<string, unknown>> {
    if (method === "elicitation/create") {
      const res = await this.#handleCreateElicitation(params as unknown as CreateElicitationRequest);
      return res as unknown as Record<string, unknown>;
    }
    if (method === "session/request_permission") {
      const res = await this.#handleRequestPermission(params as unknown as RequestPermissionRequest);
      return res as unknown as Record<string, unknown>;
    }
    throw new Error(`Unsupported client method: ${method}`);
  }

  async #handleExtNotification(_method: string, _params: Record<string, unknown>): Promise<void> {
    // Ignore unrecognized notifications
  }

  #fault(error: KimiTransportError): void {
    if (this.#options.onFault) {
      this.#options.onFault(error);
    }
  }
}
