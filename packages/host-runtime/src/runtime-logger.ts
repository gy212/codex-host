import { appendFileSync, mkdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { sanitizeDiagnosticTail } from "@codexhost/harness-adapter";

export type RuntimeLogFields = Readonly<
  Record<string, string | number | boolean | null | undefined>
>;

const SENSITIVE_KEY = /(api[_-]?key|access[_-]?token|authorization|password|secret)/iu;

export function runtimeLogPath(environment: NodeJS.ProcessEnv): string {
  const dataDirectory = environment.CODEXHOST_DATA_DIR
    ? path.resolve(environment.CODEXHOST_DATA_DIR)
    : path.join(os.homedir(), ".codexhost");
  const logDirectory = environment.CODEXHOST_LOG_DIR
    ? path.resolve(environment.CODEXHOST_LOG_DIR)
    : path.join(dataDirectory, "logs");
  return path.join(logDirectory, "host-runtime.jsonl");
}

export class RuntimeLogger {
  readonly filePath: string;
  #ready = false;

  constructor(environment: NodeJS.ProcessEnv) {
    this.filePath = runtimeLogPath(environment);
  }

  write(input: {
    level: "info" | "warn" | "error";
    event: string;
    message: string;
    fields?: RuntimeLogFields;
  }): void {
    try {
      if (!this.#ready) {
        mkdirSync(path.dirname(this.filePath), { recursive: true });
        this.#ready = true;
      }
      const fields = Object.fromEntries(
        Object.entries(input.fields ?? {}).flatMap(([key, value]) => {
          if (value === undefined) return [];
          if (SENSITIVE_KEY.test(key)) return [[key, "[redacted]"]];
          return [[key, typeof value === "string" ? sanitizeDiagnosticTail(value) : value]];
        }),
      );
      appendFileSync(
        this.filePath,
        `${JSON.stringify({
          timestamp: new Date().toISOString(),
          level: input.level,
          event: input.event,
          message: sanitizeDiagnosticTail(input.message),
          pid: process.pid,
          ...fields,
        })}\n`,
        "utf8",
      );
    } catch {
      // Logging is best-effort and must never take down the Host.
    }
  }
}
