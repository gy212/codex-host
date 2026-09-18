import { describe, expect, it } from "vitest";
import type { AvailableCommand } from "@agentclientprotocol/sdk";
import {
  harnessCommandCatalogSchema,
  hostTurnIdSchema,
} from "@codexhost/shared-contracts";

import {
  buildKimiCommandCatalog,
  formatKimiCommandPrompt,
} from "../src/slash-commands.js";

describe("slash-commands", () => {
  describe("buildKimiCommandCatalog", () => {
    it("returns empty catalog when availableCommands is empty", () => {
      const catalog = buildKimiCommandCatalog([]);
      expect(catalog).toEqual({ commands: [] });
      expect(harnessCommandCatalogSchema.parse(catalog)).toEqual({ commands: [] });
    });

    it("maps input presence to argumentMode 'text' vs 'none'", () => {
      const commands: AvailableCommand[] = [
        {
          name: "compact",
          description: "Compact history",
          input: { hint: "prompt" },
        },
        {
          name: "clear",
          description: "Clear terminal",
          input: undefined,
        },
        {
          name: "reset",
          description: "Reset state",
          input: null,
        },
      ];

      const catalog = buildKimiCommandCatalog(commands);
      expect(catalog.commands).toHaveLength(3);

      expect(catalog.commands[0]).toEqual({
        id: "compact",
        invocation: "/compact",
        label: "compact",
        description: "Compact history",
        argumentMode: "text",
      });

      expect(catalog.commands[1]).toEqual({
        id: "clear",
        invocation: "/clear",
        label: "clear",
        description: "Clear terminal",
        argumentMode: "none",
      });

      expect(catalog.commands[2]).toEqual({
        id: "reset",
        invocation: "/reset",
        label: "reset",
        description: "Reset state",
        argumentMode: "none",
      });
    });

    it("strips leading slashes and handles duplicate command IDs", () => {
      const commands: AvailableCommand[] = [
        {
          name: "/help",
          description: "Show help message",
        },
        {
          name: "///help",
          description: "Duplicate help",
        },
        {
          name: "help",
          description: "Duplicate help 2",
        },
        {
          name: "/doctor",
          description: "Run diagnostics",
        },
      ];

      const catalog = buildKimiCommandCatalog(commands);
      expect(catalog.commands).toHaveLength(2);
      expect(catalog.commands.map((c) => c.id)).toEqual(["help", "doctor"]);
      expect(catalog.commands[0].invocation).toBe("/help");
      expect(catalog.commands[1].invocation).toBe("/doctor");
    });

    it("trims and bounds description to 512 characters, omitting empty description", () => {
      const longDesc = "a".repeat(600);
      const commands: AvailableCommand[] = [
        {
          name: "long",
          description: `  ${longDesc}  `,
        },
        {
          name: "nodesc",
          description: "   ",
        },
      ];

      const catalog = buildKimiCommandCatalog(commands);
      expect(catalog.commands).toHaveLength(2);
      expect(catalog.commands[0].description).toBe("a".repeat(512));
      expect(catalog.commands[1].description).toBeUndefined();
    });

    it("ignores commands with empty or invalid names", () => {
      const commands: AvailableCommand[] = [
        {
          name: "/",
          description: "Empty after strip",
        },
        {
          name: "   ",
          description: "Whitespace",
        },
        {
          name: "valid-cmd.1:test",
          description: "Valid special characters",
        },
      ];

      const catalog = buildKimiCommandCatalog(commands);
      expect(catalog.commands).toHaveLength(1);
      expect(catalog.commands[0].id).toBe("valid-cmd.1:test");
    });
  });

  describe("formatKimiCommandPrompt", () => {
    const turnId = hostTurnIdSchema.parse("turn-test-1");

    it("formats command with no arguments", () => {
      const result = formatKimiCommandPrompt({
        commandId: "compact",
        turnId,
      });

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value).toBe("/compact");
      }
    });

    it("strips leading slash from commandId", () => {
      const result = formatKimiCommandPrompt({
        commandId: "///compact",
        turnId,
      });

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value).toBe("/compact");
      }
    });

    it("formats command with non-empty text argument", () => {
      const result = formatKimiCommandPrompt({
        commandId: "export",
        turnId,
        arguments: { text: "  session.json  " },
      });

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value).toBe("/export session.json");
      }
    });

    it("formats command with empty or whitespace-only argument as bare command", () => {
      const result = formatKimiCommandPrompt({
        commandId: "compact",
        turnId,
        arguments: { text: "   " },
      });

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value).toBe("/compact");
      }
    });

    it("returns invalidRequest error for empty commandId", () => {
      const result1 = formatKimiCommandPrompt({
        commandId: "",
        turnId,
      });
      expect(result1.ok).toBe(false);
      if (!result1.ok) {
        expect(result1.error.code).toBe("invalidRequest");
      }

      const result2 = formatKimiCommandPrompt({
        commandId: "///",
        turnId,
      });
      expect(result2.ok).toBe(false);
      if (!result2.ok) {
        expect(result2.error.code).toBe("invalidRequest");
      }
    });
  });
});
