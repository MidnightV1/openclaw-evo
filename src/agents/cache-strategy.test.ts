import { describe, expect, it } from "vitest";
import {
  computeHistoryBreakpointIndex,
  DEFAULT_CACHE_STRATEGY,
  flattenSystemPromptBlocks,
  resolveCacheStrategyConfig,
  type SystemPromptBlock,
} from "./cache-strategy.js";

// ---------------------------------------------------------------------------
// computeHistoryBreakpointIndex
// ---------------------------------------------------------------------------

describe("computeHistoryBreakpointIndex", () => {
  it("returns -1 when assistantTurnCount < minTurnsForCaching", () => {
    const result = computeHistoryBreakpointIndex({
      messages: [{ role: "user" }, { role: "assistant" }, { role: "user" }, { role: "assistant" }],
      assistantTurnCount: 2,
      slideInterval: 5,
      minTurnsForCaching: 4,
    });
    expect(result).toBe(-1);
  });

  it("returns correct index when assistantTurnCount === minTurnsForCaching", () => {
    // 4 assistant turns, slideInterval=5 → breakpointTurn = floor(3/5)*5 = 0 → -1
    // Actually with slideInterval=2: floor(3/2)*2 = 2 → find 2nd assistant
    const messages = [
      { role: "user" },
      { role: "assistant" }, // assistant #1, index 1
      { role: "user" },
      { role: "assistant" }, // assistant #2, index 3
      { role: "user" },
      { role: "assistant" }, // assistant #3, index 5
      { role: "user" },
      { role: "assistant" }, // assistant #4, index 7
    ];
    const result = computeHistoryBreakpointIndex({
      messages,
      assistantTurnCount: 4,
      slideInterval: 2,
      minTurnsForCaching: 4,
    });
    // breakpointTurn = floor((4-1)/2)*2 = floor(1.5)*2 = 1*2 = 2
    // Find the 2nd assistant message → index 3
    expect(result).toBe(3);
  });

  it("places breakpoint at expected assistant message position for 10+ turns", () => {
    // Build a clean alternating conversation with 12 assistant turns
    const messages: Array<{ role: string }> = [];
    for (let i = 0; i < 12; i++) {
      messages.push({ role: "user" });
      messages.push({ role: "assistant" });
    }
    // 12 assistant turns, slideInterval=5
    // breakpointTurn = floor(11/5)*5 = 2*5 = 10
    // 10th assistant is at index 19 (0-based: assistant #1 at 1, #2 at 3, ..., #10 at 19)
    const result = computeHistoryBreakpointIndex({
      messages,
      assistantTurnCount: 12,
      slideInterval: 5,
      minTurnsForCaching: 4,
    });
    expect(result).toBe(19);
  });

  it("correctly skips non-assistant messages (tool_use, tool_result) to find the actual index", () => {
    const messages = [
      { role: "user" },
      { role: "assistant" }, // assistant #1, index 1
      { role: "tool_use" },
      { role: "tool_result" },
      { role: "user" },
      { role: "assistant" }, // assistant #2, index 5
      { role: "tool_use" },
      { role: "tool_result" },
      { role: "user" },
      { role: "assistant" }, // assistant #3, index 9
      { role: "user" },
      { role: "assistant" }, // assistant #4, index 11
      { role: "user" },
      { role: "assistant" }, // assistant #5, index 13
    ];
    // 5 assistant turns, slideInterval=5, minTurnsForCaching=4
    // breakpointTurn = floor(4/5)*5 = 0 → returns -1
    // Use slideInterval=2 instead:
    // breakpointTurn = floor(4/2)*2 = 4
    // 4th assistant is at index 11
    const result = computeHistoryBreakpointIndex({
      messages,
      assistantTurnCount: 5,
      slideInterval: 2,
      minTurnsForCaching: 4,
    });
    expect(result).toBe(11);
  });

  it("slideInterval=5, assistantTurnCount=12 → breakpoint at 10th assistant position", () => {
    // Interleave user/assistant with some tool messages
    const messages: Array<{ role: string }> = [];
    for (let i = 0; i < 12; i++) {
      messages.push({ role: "user" });
      messages.push({ role: "assistant" });
      // Add tool messages every 3rd turn
      if (i % 3 === 0) {
        messages.push({ role: "tool_use" });
        messages.push({ role: "tool_result" });
      }
    }
    // breakpointTurn = floor(11/5)*5 = 10
    // Count to the 10th assistant in the actual messages array
    let assistantCount = 0;
    let expectedIndex = -1;
    for (let i = 0; i < messages.length; i++) {
      if (messages[i].role === "assistant") {
        assistantCount++;
        if (assistantCount === 10) {
          expectedIndex = i;
          break;
        }
      }
    }
    const result = computeHistoryBreakpointIndex({
      messages,
      assistantTurnCount: 12,
      slideInterval: 5,
      minTurnsForCaching: 4,
    });
    expect(result).toBe(expectedIndex);
  });

  it("slideInterval=2 (sub-agent), short conversation → more frequent sliding", () => {
    const messages = [
      { role: "user" },
      { role: "assistant" }, // #1, index 1
      { role: "user" },
      { role: "assistant" }, // #2, index 3
      { role: "user" },
      { role: "assistant" }, // #3, index 5
    ];
    // assistantTurnCount=3, slideInterval=2, minTurnsForCaching=2
    // breakpointTurn = floor(2/2)*2 = 2
    // 2nd assistant at index 3
    const result = computeHistoryBreakpointIndex({
      messages,
      assistantTurnCount: 3,
      slideInterval: 2,
      minTurnsForCaching: 2,
    });
    expect(result).toBe(3);
  });

  it("returns -1 for empty messages array", () => {
    const result = computeHistoryBreakpointIndex({
      messages: [],
      assistantTurnCount: 0,
      slideInterval: 5,
      minTurnsForCaching: 4,
    });
    expect(result).toBe(-1);
  });

  it("returns -1 when all messages are user (no assistant messages)", () => {
    const messages = [{ role: "user" }, { role: "user" }, { role: "user" }, { role: "user" }];
    // Even if assistantTurnCount is reported as 4, there are no assistant messages
    // so the walk finds nothing → -1
    const result = computeHistoryBreakpointIndex({
      messages,
      assistantTurnCount: 4,
      slideInterval: 2,
      minTurnsForCaching: 2,
    });
    expect(result).toBe(-1);
  });

  it("returns -1 when breakpointTurn computes to 0", () => {
    // assistantTurnCount=1, slideInterval=5 → floor(0/5)*5 = 0 → -1
    const result = computeHistoryBreakpointIndex({
      messages: [{ role: "user" }, { role: "assistant" }],
      assistantTurnCount: 1,
      slideInterval: 5,
      minTurnsForCaching: 1,
    });
    expect(result).toBe(-1);
  });
});

// ---------------------------------------------------------------------------
// flattenSystemPromptBlocks
// ---------------------------------------------------------------------------

describe("flattenSystemPromptBlocks", () => {
  it("returns the text of a single block", () => {
    const blocks: SystemPromptBlock[] = [{ text: "Hello world", volatility: "frozen" }];
    expect(flattenSystemPromptBlocks(blocks)).toBe("Hello world");
  });

  it("joins multiple blocks with newline separator", () => {
    const blocks: SystemPromptBlock[] = [
      { text: "Part 1", volatility: "frozen" },
      { text: "Part 2", volatility: "stable" },
      { text: "Part 3", volatility: "volatile" },
    ];
    expect(flattenSystemPromptBlocks(blocks)).toBe("Part 1\nPart 2\nPart 3");
  });

  it("returns empty string for empty array", () => {
    expect(flattenSystemPromptBlocks([])).toBe("");
  });

  it("includes all blocks regardless of volatility level", () => {
    const blocks: SystemPromptBlock[] = [
      { text: "frozen-content", volatility: "frozen", label: "safety" },
      { text: "stable-content", volatility: "stable", label: "project" },
      { text: "volatile-content", volatility: "volatile", label: "runtime" },
    ];
    const result = flattenSystemPromptBlocks(blocks);
    expect(result).toContain("frozen-content");
    expect(result).toContain("stable-content");
    expect(result).toContain("volatile-content");
  });

  it("preserves order of blocks", () => {
    const blocks: SystemPromptBlock[] = [
      { text: "A", volatility: "volatile" },
      { text: "B", volatility: "frozen" },
      { text: "C", volatility: "stable" },
    ];
    expect(flattenSystemPromptBlocks(blocks)).toBe("A\nB\nC");
  });
});

// ---------------------------------------------------------------------------
// resolveCacheStrategyConfig
// ---------------------------------------------------------------------------

describe("resolveCacheStrategyConfig", () => {
  it("returns defaults when no override is provided", () => {
    const config = resolveCacheStrategyConfig();
    expect(config).toEqual(DEFAULT_CACHE_STRATEGY);
  });

  it("returns defaults when undefined is passed explicitly", () => {
    const config = resolveCacheStrategyConfig(undefined);
    expect(config).toEqual(DEFAULT_CACHE_STRATEGY);
  });

  it("merges partial override with defaults", () => {
    const config = resolveCacheStrategyConfig({ windowSlideInterval: 10 });
    expect(config.windowSlideInterval).toBe(10);
    // Other fields retain defaults
    expect(config.systemPromptSegmentation).toBe(DEFAULT_CACHE_STRATEGY.systemPromptSegmentation);
    expect(config.historyWindowCaching).toBe(DEFAULT_CACHE_STRATEGY.historyWindowCaching);
    expect(config.subagentWindowSlideInterval).toBe(
      DEFAULT_CACHE_STRATEGY.subagentWindowSlideInterval,
    );
    expect(config.minTurnsForCaching).toBe(DEFAULT_CACHE_STRATEGY.minTurnsForCaching);
    expect(config.subagentMinTurnsForCaching).toBe(
      DEFAULT_CACHE_STRATEGY.subagentMinTurnsForCaching,
    );
  });

  it("uses full override when all fields are provided", () => {
    const fullOverride = {
      systemPromptSegmentation: false,
      historyWindowCaching: false,
      windowSlideInterval: 10,
      subagentWindowSlideInterval: 3,
      minTurnsForCaching: 8,
      subagentMinTurnsForCaching: 4,
    };
    const config = resolveCacheStrategyConfig(fullOverride);
    expect(config).toEqual(fullOverride);
  });

  it("returns a new object (no reference sharing with DEFAULT_CACHE_STRATEGY)", () => {
    const config = resolveCacheStrategyConfig();
    expect(config).not.toBe(DEFAULT_CACHE_STRATEGY);
  });
});
