import type { AvailableCommand } from "@agentclientprotocol/sdk";
import type {
  HarnessCommandInvocation,
  HarnessResult,
} from "@codexhost/harness-adapter";
import {
  harnessCommandCatalogSchema,
  type HarnessCommandCatalog,
  type HarnessCommandDescriptor,
} from "@codexhost/shared-contracts";

/**
 * Builds a validated HarnessCommandCatalog from native ACP AvailableCommands.
 * Strips leading slash from names if present, deduplicates command IDs,
 * maps input to argumentMode, and bounds descriptions to schema limits.
 */
export function buildKimiCommandCatalog(
  availableCommands: readonly AvailableCommand[],
): HarnessCommandCatalog {
  const seenIds = new Set<string>();
  const descriptors: HarnessCommandDescriptor[] = [];

  for (const command of availableCommands) {
    const rawName = typeof command.name === "string" ? command.name.trim() : "";
    const cleanId = rawName.replace(/^\/+/, "");
    if (!cleanId || seenIds.has(cleanId)) continue;
    if (!/^[A-Za-z0-9._:-]{1,127}$/u.test(cleanId)) continue;
    seenIds.add(cleanId);

    const argumentMode = command.input ? "text" : "none";
    const rawDesc = typeof command.description === "string" ? command.description.trim() : "";
    const description = rawDesc.length > 0 ? rawDesc.slice(0, 512) : undefined;

    descriptors.push({
      id: cleanId as HarnessCommandDescriptor["id"],
      invocation: `/${cleanId}`,
      label: cleanId,
      argumentMode,
      ...(description ? { description } : {}),
    });
  }

  return harnessCommandCatalogSchema.parse({ commands: descriptors });
}

export const KIMI_DEFAULT_COMMANDS: readonly AvailableCommand[] = [
  {
    name: "compact",
    description: "Compact the conversation context",
    input: { hint: "prompt" },
  },
  {
    name: "status",
    description: "Show current session status",
  },
  {
    name: "usage",
    description: "Show session token usage",
  },
  {
    name: "mcp",
    description: "Show MCP server status",
  },
  {
    name: "tasks",
    description: "List background tasks",
  },
  {
    name: "help",
    description: "Show available ACP commands",
  },
];

export const KIMI_DEFAULT_COMMAND_CATALOG: HarnessCommandCatalog =
  buildKimiCommandCatalog(KIMI_DEFAULT_COMMANDS);

/**
 * Formats a command invocation into a prompt string for Kimi ACP.
 * Formats `/commandName` or `/commandName <args>`.
 */
export function formatKimiCommandPrompt(
  invocation: HarnessCommandInvocation,
): HarnessResult<string> {
  const rawId = typeof invocation.commandId === "string" ? invocation.commandId.trim() : "";
  const cleanId = rawId.replace(/^\/+/, "");
  if (!cleanId) {
    return {
      ok: false,
      error: {
        code: "invalidRequest",
        message: "Command ID cannot be empty",
        retryable: false,
      },
    };
  }

  const base = `/${cleanId}`;
  const text =
    invocation.arguments && typeof invocation.arguments.text === "string"
      ? invocation.arguments.text.trim()
      : "";

  const prompt = text.length > 0 ? `${base} ${text}` : base;
  return { ok: true, value: prompt };
}
