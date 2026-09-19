import { appendFile, readFile } from "node:fs/promises";
import path from "node:path";
import type { HostTurnSnapshot } from "@codexhost/harness-adapter";
import { locateKimiSession } from "./history.js";

type HistoryOptions = { homeDirectory?: string; kimiCodeHome?: string };

// ACP commands do not enter wire.jsonl. This adapter-owned journal preserves
// their actual replies without changing native conversation context.
export async function readKimiCommandHistory(
  sessionId: string,
  options: HistoryOptions,
): Promise<HostTurnSnapshot[]> {
  const located = await locateKimiSession(sessionId, options);
  if (!located) return [];
  let content: string;
  try {
    content = await readFile(path.join(located.sessionDir, "codexhost-commands.jsonl"), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  return content
    .split("\n")
    .filter((line) => line.trim())
    .map((line) => {
      const turn = JSON.parse(line) as HostTurnSnapshot;
      if (
        turn.nativeTurnRef?.harnessId !== "kimi-code" ||
        turn.nativeTurnRef.nativeSessionId !== sessionId ||
        !turn.nativeTurnRef.nativeTurnKey.startsWith("turn:command:")
      ) {
        throw new Error("Invalid Kimi command history identity");
      }
      return turn;
    });
}

export async function appendKimiCommandHistory(
  turn: HostTurnSnapshot,
  options: HistoryOptions,
): Promise<void> {
  const located = await locateKimiSession(turn.nativeTurnRef.nativeSessionId, options);
  if (!located) throw new Error("Cannot persist Kimi command: native session is missing");
  await appendFile(
    path.join(located.sessionDir, "codexhost-commands.jsonl"),
    `${JSON.stringify(turn)}\n`,
    "utf8",
  );
}
