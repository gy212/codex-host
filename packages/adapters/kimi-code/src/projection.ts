import { randomUUID } from "node:crypto";

import type {
  CreateElicitationRequest,
  CreateElicitationResponse,
  RequestPermissionRequest,
} from "@agentclientprotocol/sdk";
import type {
  HostApprovalAction,
  HostApprovalInteraction,
  HostChoiceQuestion,
  HostCommandExecutionItem,
  HostItem,
  HostQuestionInteraction,
  HostQuestionResponse,
  HostToolExecutionItem,
  HostUsage,
} from "@codexhost/harness-adapter";
import {
  hostInteractionIdSchema,
  hostItemIdSchema,
  type HostInteractionId,
  type HostItemId,
  type HostTurnId,
  type JsonObject,
} from "@codexhost/shared-contracts";

export interface ProjectedApproval {
  interaction: HostApprovalInteraction;
  optionIdByActionId: ReadonlyMap<string, string>;
}

export function projectKimiApprovalRequest(
  turnId: HostTurnId,
  request: RequestPermissionRequest,
): ProjectedApproval {
  const interactionId = hostInteractionIdSchema.parse(randomUUID());
  const optionIdByActionId = new Map<string, string>();
  const actions: HostApprovalAction[] = [];

  const effectMap: Record<string, HostApprovalAction["effect"]> = {
    allow_once: "allowOnce",
    allow_always: "allowForSession", // Native approve_always is session-scoped
    reject_once: "deny",
    reject_always: "deny",
  };

  const labelMap: Record<string, string> = {
    allow_once: "允许一次",
    allow_always: "本会话允许",
    reject_once: "拒绝",
    reject_always: "拒绝",
  };

  for (const option of request.options) {
    const effect = effectMap[option.kind] ?? (option.kind.startsWith("allow") ? "allowOnce" : "deny");
    const actionId = option.optionId;
    optionIdByActionId.set(actionId, option.optionId);

    actions.push({
      id: actionId,
      label: option.name || labelMap[option.kind] || actionId,
      effect,
    });
  }

  // Fallback if no actions
  if (actions.length === 0) {
    actions.push(
      { id: "allow_once", label: "允许一次", effect: "allowOnce" },
      { id: "reject", label: "拒绝", effect: "deny" },
    );
    optionIdByActionId.set("allow_once", "allow_once");
    optionIdByActionId.set("reject", "reject");
  }

  const interaction: HostApprovalInteraction = {
    type: "approval",
    interactionId,
    turnId,
    title: "Kimi Code 工具执行审批",
    ...(typeof (request as unknown as { description?: string }).description === "string"
      ? { description: (request as unknown as { description?: string }).description }
      : {}),
    subject: { type: "nativeAction" },
    actions,
  };

  return { interaction, optionIdByActionId };
}

export interface ProjectedElicitation {
  interaction: HostQuestionInteraction;
  schemaProperties: Record<string, { type: "string" | "array" }>;
}

export function projectKimiElicitationRequest(
  turnId: HostTurnId,
  request: CreateElicitationRequest,
): ProjectedElicitation {
  const interactionId = hostInteractionIdSchema.parse(randomUUID());
  const questions: HostChoiceQuestion[] = [];
  const schemaProperties: Record<string, { type: "string" | "array" }> = {};

  const req = request as Record<string, unknown>;
  const requestedSchema = req.requestedSchema as Record<string, unknown> | undefined;
  const properties = (requestedSchema?.properties && typeof requestedSchema.properties === "object")
    ? (requestedSchema.properties as Record<string, Record<string, unknown>>)
    : {};
  const requiredList = Array.isArray(requestedSchema?.required)
    ? (requestedSchema.required as string[])
    : [];

  for (const [key, prop] of Object.entries(properties)) {
    const isArray = prop.type === "array";
    schemaProperties[key] = { type: isArray ? "array" : "string" };

    const prompt = typeof prop.title === "string" ? prop.title : key;
    const options: Array<{ value: string; label: string; description?: string }> = [];

    if (isArray && typeof prop.items === "object" && prop.items !== null) {
      const items = prop.items as Record<string, unknown>;
      const anyOf = Array.isArray(items.anyOf) ? (items.anyOf as Array<Record<string, unknown>>) : [];
      for (const item of anyOf) {
        if (typeof item?.const === "string") {
          options.push({
            value: item.const,
            label: typeof item.title === "string" ? item.title : item.const,
          });
        }
      }
    } else if (Array.isArray(prop.oneOf)) {
      for (const item of prop.oneOf as Array<Record<string, unknown>>) {
        if (typeof item?.const === "string") {
          options.push({
            value: item.const,
            label: typeof item.title === "string" ? item.title : item.const,
          });
        }
      }
    }

    questions.push({
      id: key,
      type: "choice",
      prompt,
      options,
      multiple: isArray,
      allowOther: false,
      optional: !requiredList.includes(key),
    });
  }

  const interaction: HostQuestionInteraction = {
    type: "question",
    interactionId,
    turnId,
    ...(typeof requestedSchema?.title === "string" ? { title: requestedSchema.title } : {}),
    questions,
  };

  return { interaction, schemaProperties };
}

export function formatElicitationResponse(
  response: HostQuestionResponse,
  schemaProperties: Record<string, { type: "string" | "array" }>,
): CreateElicitationResponse {
  if (response.cancelled) {
    return { action: "cancel" };
  }

  const content: Record<string, unknown> = {};
  for (const [key, spec] of Object.entries(schemaProperties)) {
    const answers = response.answers[key] || [];
    if (spec.type === "array") {
      content[key] = answers;
    } else {
      content[key] = answers[0] ?? "";
    }
  }

  return { action: "accept", content };
}

export interface ToolCallAccumulatorState {
  toolCallId: string;
  name: string;
  kind?: string;
  rawInput?: unknown;
  rawOutput?: unknown;
  contentAccumulator: string;
  status: "pending" | "in_progress" | "completed" | "failed";
  itemStartedEmitted: boolean;
  itemId: HostItemId;
}

export class KimiToolCallAccumulator {
  private readonly calls = new Map<string, ToolCallAccumulatorState>();

  getOrCreate(toolCallId: string, turnId: HostTurnId, name = "Tool", kind?: string): ToolCallAccumulatorState {
    let state = this.calls.get(toolCallId);
    if (!state) {
      const sanitizedId = toolCallId.replace(/[^A-Za-z0-9._~-]/g, "_");
      state = {
        toolCallId,
        name,
        ...(kind ? { kind } : {}),
        contentAccumulator: "",
        status: "pending",
        itemStartedEmitted: false,
        itemId: hostItemIdSchema.parse(`item:${turnId}:tool:${sanitizedId}`),
      };
      this.calls.set(toolCallId, state);
    }
    return state;
  }

  get(toolCallId: string): ToolCallAccumulatorState | undefined {
    return this.calls.get(toolCallId);
  }

  delete(toolCallId: string): boolean {
    return this.calls.delete(toolCallId);
  }
}

export function createHostItemFromToolState(
  state: ToolCallAccumulatorState,
  cwd?: string,
): HostItem {
  const isBash = state.kind === "execute" || state.name.toLowerCase() === "bash" || state.name.toLowerCase() === "shell" || state.name.toLowerCase() === "terminal";
  const rawInput = state.rawInput as Record<string, unknown> | undefined;

  if (isBash) {
    const commandText = typeof rawInput?.command === "string"
      ? rawInput.command
      : typeof rawInput?.cmd === "string"
        ? rawInput.cmd
        : state.contentAccumulator || "sh";

    const item: HostCommandExecutionItem = {
      type: "commandExecution",
      itemId: state.itemId,
      command: commandText,
      ...(cwd ? { cwd } : {}),
      ...(state.rawOutput !== undefined || state.contentAccumulator
        ? {
            output: typeof state.rawOutput === "string"
              ? state.rawOutput
              : (state.rawOutput ? JSON.stringify(state.rawOutput) : state.contentAccumulator),
          }
        : {}),
    };
    return item;
  }

  const toolItem: HostToolExecutionItem = {
    type: "toolExecution",
    itemId: state.itemId,
    toolName: state.name,
    arguments: (state.rawInput && typeof state.rawInput === "object" && !Array.isArray(state.rawInput)
      ? state.rawInput
      : {}) as JsonObject,
    ...(state.rawOutput !== undefined || state.contentAccumulator
      ? {
          output: {
            content: [
              {
                type: "text" as const,
                text: typeof state.rawOutput === "string"
                  ? state.rawOutput
                  : (state.rawOutput ? JSON.stringify(state.rawOutput) : state.contentAccumulator),
              },
            ],
          },
        }
      : {}),
  };
  return toolItem;
}

export function readAcpToolContentText(content: unknown): string {
  const parts = Array.isArray(content) ? content : [content];
  return parts.flatMap((part) => {
    if (!part || typeof part !== "object") return [];
    const block = part as Record<string, unknown>;
    const nested = block.type === "content" && block.content && typeof block.content === "object"
      ? block.content as Record<string, unknown>
      : block;
    return nested.type === "text" && typeof nested.text === "string" ? [nested.text] : [];
  }).join("\n");
}

export function parseKimiUsage(update: Record<string, unknown>): HostUsage | null {
  const used = typeof update.used === "number" ? update.used : undefined;
  const size = typeof update.size === "number" ? update.size : undefined;

  if (used === undefined && size === undefined) return null;

  return {
    ...(size !== undefined ? { contextWindowTokens: size } : {}),
    ...(used !== undefined ? { contextUsedTokens: used } : {}),
  };
}
