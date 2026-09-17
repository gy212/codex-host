import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  createKimiNativeSessionRef,
  createKimiNativeTurnRef,
  locateKimiSession,
  parseKimiWireLog,
  readKimiSessionSnapshot,
} from "../src/history.js";

describe("Kimi Code History & Diff", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(path.join(os.tmpdir(), "kimi-hist-test-"));
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true }).catch(() => undefined);
  });

  describe("Native References", () => {
    it("creates valid native session and turn references", () => {
      const sessionRef = createKimiNativeSessionRef("session-abc", "D:/project");
      expect(sessionRef.harnessId).toBe("kimi-code");
      expect(sessionRef.nativeSessionId).toBe("session-abc");
      expect(sessionRef.locator).toEqual({ cwd: "D:/project" });

      const turnRef = createKimiNativeTurnRef("session-abc", 1);
      expect(turnRef.harnessId).toBe("kimi-code");
      expect(turnRef.nativeSessionId).toBe("session-abc");
      expect(turnRef.nativeTurnKey).toBe("turn:1");
    });
  });

  describe("locateKimiSession", () => {
    it("locates existing session from session_index.jsonl and state.json", async () => {
      const sessionId = "session-123";
      const sessionDir = path.join(tempDir, "sessions", "ws-1", sessionId);
      await mkdir(path.join(sessionDir, "agents", "main"), { recursive: true });

      const indexContent = JSON.stringify({
        sessionId,
        sessionDir,
        workDir: tempDir,
      }) + "\n";
      await writeFile(path.join(tempDir, "session_index.jsonl"), indexContent, "utf8");

      const stateContent = JSON.stringify({
        id: sessionId,
        version: 2,
        cwd: tempDir,
        agents: {
          main: {
            homedir: path.join(sessionDir, "agents", "main"),
            type: "main",
          },
        },
      });
      await writeFile(path.join(sessionDir, "state.json"), stateContent, "utf8");

      const located = await locateKimiSession(sessionId, { kimiCodeHome: tempDir });
      expect(located).not.toBeNull();
      expect(located?.state.id).toBe(sessionId);
      expect(located?.sessionDir).toBe(sessionDir);
      expect(located?.mainHomeDir).toBe(path.join(sessionDir, "agents", "main"));
    });

    it("returns null when session is not in index", async () => {
      await writeFile(path.join(tempDir, "session_index.jsonl"), "", "utf8");
      const located = await locateKimiSession("nonexistent", { kimiCodeHome: tempDir });
      expect(located).toBeNull();
    });

    it("returns null when session is marked deleted", async () => {
      const sessionId = "deleted-session";
      const indexContent = JSON.stringify({
        sessionId,
        sessionDir: path.join(tempDir, "sessions", sessionId),
        deleted: true,
      }) + "\n";
      await writeFile(path.join(tempDir, "session_index.jsonl"), indexContent, "utf8");

      const located = await locateKimiSession(sessionId, { kimiCodeHome: tempDir });
      expect(located).toBeNull();
    });

    it("rejects path traversal outside kimi home", async () => {
      const sessionId = "traversal-session";
      const outsideDir = path.resolve(tempDir, "..", "outside-dir");
      const indexContent = JSON.stringify({
        sessionId,
        sessionDir: outsideDir,
      }) + "\n";
      await writeFile(path.join(tempDir, "session_index.jsonl"), indexContent, "utf8");

      await expect(locateKimiSession(sessionId, { kimiCodeHome: tempDir })).rejects.toThrow(
        /outside KIMI_CODE_HOME/,
      );
    });
  });

  describe("parseKimiWireLog", () => {
    it("parses completed turn with tool calls, text and file diff", async () => {
      const mainHomeDir = path.join(tempDir, "main");
      await mkdir(path.join(mainHomeDir, "file-history"), { recursive: true });

      const oldPath = path.join(mainHomeDir, "file-history", "old.txt");
      const newPath = path.join(mainHomeDir, "file-history", "new.txt");
      await writeFile(oldPath, "line 1\nline 2\n", "utf8");
      await writeFile(newPath, "line 1\nline 2 modified\nline 3 added\n", "utf8");

      const wireLines = [
        JSON.stringify({
          type: "turn.prompt",
          agentId: "main",
          turnId: 0,
          promptId: "msg-001",
          time: 1000,
          input: [{ type: "text", text: "Modify file" }],
        }),
        JSON.stringify({
          type: "usage.record",
          agentId: "main",
          turnId: 0,
          model: "relay",
        }),
        JSON.stringify({
          type: "file_history.tracked",
          agentId: "main",
          turnId: 0,
          path: "sample.txt",
          entry: { key: "file-history/old.txt", version: 1 },
        }),
        JSON.stringify({
          type: "context.append_loop_event",
          agentId: "main",
          event: {
            type: "tool.call",
            toolCallId: "tool-1",
            name: "Write",
            args: { path: "sample.txt", content: "..." },
          },
        }),
        JSON.stringify({
          type: "context.append_loop_event",
          agentId: "main",
          event: {
            type: "tool.result",
            toolCallId: "tool-1",
            result: { output: "Updated sample.txt" },
          },
        }),
        JSON.stringify({
          type: "context.append_loop_event",
          agentId: "main",
          event: {
            type: "content.part",
            turnId: 0,
            part: { type: "text", text: "File was updated successfully." },
          },
        }),
        JSON.stringify({
          type: "file_history.checkpoint",
          agentId: "main",
          turnId: 0,
          entries: {
            "sample.txt": { key: "file-history/new.txt", version: 2, size: 45 },
          },
        }),
        JSON.stringify({
          type: "turn.ended",
          agentId: "main",
          turnId: 0,
          reason: "completed",
          time: 5000,
        }),
      ].join("\n");

      const turns = await parseKimiWireLog(wireLines, "session-test", mainHomeDir);
      expect(turns).toHaveLength(1);

      const turn = turns[0]!;
      expect(turn.nativeTurnRef.nativeTurnKey).toBe("turn:0");
      expect(turn.outcome.status).toBe("succeeded");
      expect(turn.input).toEqual([{ type: "text", text: "Modify file" }]);
      expect(turn.startedAtMs).toBe(1000);
      expect(turn.completedAtMs).toBe(5000);

      // Check items: reasoning / agentMessage / tool / fileChange
      const agentMsg = turn.items.find((i) => i.item.type === "agentMessage");
      expect(agentMsg).toBeDefined();
      if (agentMsg && agentMsg.item.type === "agentMessage") {
        expect(agentMsg.item.text).toBe("File was updated successfully.");
      }

      const toolItem = turn.items.find((i) => i.item.type === "toolExecution");
      expect(toolItem).toBeDefined();
      if (toolItem && toolItem.item.type === "toolExecution") {
        expect(toolItem.item.toolName).toBe("Write");
      }

      const fileChangeItem = turn.items.find((i) => i.item.type === "fileChange");
      expect(fileChangeItem).toBeDefined();
      if (fileChangeItem && fileChangeItem.item.type === "fileChange") {
        expect(fileChangeItem.item.changes).toHaveLength(1);
        const change = fileChangeItem.item.changes[0]!;
        expect(change.path).toBe("sample.txt");
        expect(change.kind).toBe("update");
        expect(change.unifiedDiff).toContain("-line 2");
        expect(change.unifiedDiff).toContain("+line 2 modified");
        expect(change.unifiedDiff).toContain("+line 3 added");
      }
    });

    it("parses cancelled turn accurately", async () => {
      const wireLines = [
        JSON.stringify({
          type: "turn.prompt",
          agentId: "main",
          turnId: 0,
          input: [{ type: "text", text: "Long task" }],
        }),
        JSON.stringify({
          type: "turn.ended",
          agentId: "main",
          turnId: 0,
          reason: "cancelled",
        }),
      ].join("\n");

      const turns = await parseKimiWireLog(wireLines, "session-cancel");
      expect(turns).toHaveLength(1);
      const turn = turns[0]!;
      expect(turn.outcome.status).toBe("cancelled");
      if (turn.outcome.status === "cancelled") {
        expect(turn.outcome.reason).toContain("cancelled");
      }
    });

    it("handles multiple turns in sequence", async () => {
      const wireLines = [
        JSON.stringify({
          type: "turn.prompt",
          agentId: "main",
          turnId: 0,
          input: [{ type: "text", text: "Turn 1" }],
        }),
        JSON.stringify({
          type: "turn.ended",
          agentId: "main",
          turnId: 0,
          reason: "completed",
        }),
        JSON.stringify({
          type: "turn.prompt",
          agentId: "main",
          turnId: 1,
          input: [{ type: "text", text: "Turn 2" }],
        }),
        JSON.stringify({
          type: "turn.ended",
          agentId: "main",
          turnId: 1,
          reason: "completed",
        }),
      ].join("\n");

      const turns = await parseKimiWireLog(wireLines, "session-seq");
      expect(turns).toHaveLength(2);
      expect(turns[0]!.nativeTurnRef.nativeTurnKey).toBe("turn:0");
      expect(turns[1]!.nativeTurnRef.nativeTurnKey).toBe("turn:1");
    });
  });

  describe("readKimiSessionSnapshot", () => {
    it("reads snapshot using located directory", async () => {
      const sessionId = "session-snap";
      const sessionDir = path.join(tempDir, "sessions", sessionId);
      const mainHomeDir = path.join(sessionDir, "agents", "main");
      await mkdir(mainHomeDir, { recursive: true });

      await writeFile(
        path.join(tempDir, "session_index.jsonl"),
        JSON.stringify({ sessionId, sessionDir }) + "\n",
      );
      await writeFile(
        path.join(sessionDir, "state.json"),
        JSON.stringify({ id: sessionId, version: 2, cwd: tempDir }),
      );
      await writeFile(
        path.join(mainHomeDir, "wire.jsonl"),
        JSON.stringify({
          type: "turn.prompt",
          agentId: "main",
          turnId: 0,
          input: [{ type: "text", text: "Hello" }],
        }) +
          "\n" +
          JSON.stringify({
            type: "turn.ended",
            agentId: "main",
            turnId: 0,
            reason: "completed",
          }) +
          "\n",
      );

      const snapshot = await readKimiSessionSnapshot(sessionId, { kimiCodeHome: tempDir });
      expect(snapshot.turns).toHaveLength(1);
      expect(snapshot.turns[0]!.outcome.status).toBe("succeeded");
    });
  });
});
