import { describe, expect, it } from "vitest";

import { projectKimiTextUpdate } from "../src/acp-transport.js";

describe("Kimi ACP transport projection", () => {
  it("reads agent message and thought text from ACP content blocks", () => {
    expect(projectKimiTextUpdate({
      sessionUpdate: "agent_message_chunk",
      content: { type: "text", text: "KIMI_PROBE_DONE" },
    })).toEqual({ type: "agent.text", text: "KIMI_PROBE_DONE" });

    expect(projectKimiTextUpdate({
      sessionUpdate: "agent_thought_chunk",
      content: { type: "text", text: "Checking the workspace" },
    })).toEqual({ type: "agent.thought", text: "Checking the workspace" });
  });
});
