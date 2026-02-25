import { describe, expect, it } from "vitest";
import { parseSubagentOutput } from "./subagent-announce.js";

// NOTE: buildResponseFormatInstructions is NOT exported from subagent-announce.ts.
// It is a module-private function. Tests for it are described below but commented out.
// To test it, export the function or use an internal test harness.

describe("parseSubagentOutput", () => {
  // ── responseFormat = undefined ──

  describe("responseFormat = undefined", () => {
    it("returns raw text unchanged", () => {
      const result = parseSubagentOutput("hello world", undefined);
      expect(result).toEqual({ text: "hello world" });
    });
  });

  // ── responseFormat = "text" ──

  describe('responseFormat = "text"', () => {
    it("returns raw text unchanged", () => {
      const result = parseSubagentOutput("hello world", "text");
      expect(result).toEqual({ text: "hello world" });
    });
  });

  // ── responseFormat = "json" ──

  describe('responseFormat = "json"', () => {
    it("parses valid JSON and returns pretty-printed text", () => {
      const raw = '{"key":"value","num":42}';
      const result = parseSubagentOutput(raw, "json");
      expect(result.parsed).toEqual({ key: "value", num: 42 });
      expect(result.text).toBe(JSON.stringify({ key: "value", num: 42 }, null, 2));
      expect(result.parseError).toBeUndefined();
    });

    it("strips markdown fenced JSON and parses correctly", () => {
      const raw = '```json\n{"status":"ok"}\n```';
      const result = parseSubagentOutput(raw, "json");
      expect(result.parsed).toEqual({ status: "ok" });
      expect(result.text).toBe(JSON.stringify({ status: "ok" }, null, 2));
      expect(result.parseError).toBeUndefined();
    });

    it("strips fences without json label", () => {
      const raw = '```\n{"a":1}\n```';
      const result = parseSubagentOutput(raw, "json");
      expect(result.parsed).toEqual({ a: 1 });
      expect(result.parseError).toBeUndefined();
    });

    it("falls back to raw text with parseError on invalid JSON", () => {
      const raw = "this is not json";
      const result = parseSubagentOutput(raw, "json");
      expect(result.text).toBe(raw);
      expect(result.parsed).toBeUndefined();
      expect(result.parseError).toMatch(/JSON parse failed/);
    });
  });

  // ── responseFormat = "structured" ──

  describe('responseFormat = "structured"', () => {
    it("extracts meta and body from valid structured JSON", () => {
      const raw = JSON.stringify({ meta: { status: "ok", count: 3 }, body: "Found 3 items" });
      const result = parseSubagentOutput(raw, "structured");
      expect(result.parsed).toEqual({ meta: { status: "ok", count: 3 }, body: "Found 3 items" });
      expect(result.text).toContain("[meta]");
      expect(result.text).toContain("Found 3 items");
      expect(result.parseError).toBeUndefined();
    });

    it("strips markdown fences before parsing structured JSON", () => {
      const obj = { meta: { level: "info" }, body: "All good" };
      const raw = `\`\`\`json\n${JSON.stringify(obj)}\n\`\`\``;
      const result = parseSubagentOutput(raw, "structured");
      expect(result.parsed).toEqual(obj);
      expect(result.text).toContain("[meta]");
      expect(result.text).toContain("All good");
      expect(result.parseError).toBeUndefined();
    });

    it("handles body-only structured response (no meta)", () => {
      const raw = JSON.stringify({ body: "Just a body" });
      const result = parseSubagentOutput(raw, "structured");
      expect(result.text).toBe("Just a body");
      expect(result.parseError).toBeUndefined();
    });

    it("handles meta-only structured response (no body)", () => {
      const raw = JSON.stringify({ meta: { key: "val" } });
      const result = parseSubagentOutput(raw, "structured");
      expect(result.text).toContain("[meta]");
      expect(result.text).toContain('"key"');
      expect(result.parseError).toBeUndefined();
    });

    it("falls back when JSON is valid but missing meta/body keys", () => {
      const raw = JSON.stringify({ something: "else" });
      const result = parseSubagentOutput(raw, "structured");
      expect(result.text).toBe(raw);
      expect(result.parsed).toEqual({ something: "else" });
      expect(result.parseError).toMatch(/Missing meta\/body/);
    });

    it("falls back to raw text with parseError on malformed input", () => {
      const raw = "not json at all {{{";
      const result = parseSubagentOutput(raw, "structured");
      expect(result.text).toBe(raw);
      expect(result.parsed).toBeUndefined();
      expect(result.parseError).toMatch(/Structured JSON parse failed/);
    });
  });

  // ── Edge cases ──

  describe("edge cases", () => {
    it("returns empty string for empty string input", () => {
      const result = parseSubagentOutput("", "json");
      expect(result.text).toBe("");
      expect(result.parsed).toBeUndefined();
      expect(result.parseError).toBeUndefined();
    });

    it("returns whitespace-only input as-is (treated as empty by trim check)", () => {
      // The function checks !raw?.trim() — whitespace passes the guard
      // but returns the original raw value (not trimmed), with no parse attempt.
      const result = parseSubagentOutput("   ", "structured");
      expect(result.text).toBe("   ");
      expect(result.parsed).toBeUndefined();
      expect(result.parseError).toBeUndefined();
    });

    it("returns empty string when raw is undefined", () => {
      const result = parseSubagentOutput(undefined, "json");
      expect(result.text).toBe("");
      expect(result.parsed).toBeUndefined();
    });

    it("returns empty string when raw is undefined and format is undefined", () => {
      const result = parseSubagentOutput(undefined, undefined);
      expect(result.text).toBe("");
    });
  });
});

// ─────────────────────────────────────────────────────────────
// buildResponseFormatInstructions — NOT exported, cannot test directly.
// If exported, the following tests should be enabled:
// ─────────────────────────────────────────────────────────────
//
// describe("buildResponseFormatInstructions", () => {
//   describe("responseFormat = undefined", () => {
//     it("returns default instructions (text-style)", () => {
//       const result = buildResponseFormatInstructions({
//         parentLabel: "main agent",
//       });
//       expect(result.length).toBeGreaterThan(0);
//       expect(result.some((l) => l.includes("accomplished"))).toBe(true);
//     });
//   });
//
//   describe('responseFormat = "text"', () => {
//     it("returns default instructions", () => {
//       const result = buildResponseFormatInstructions({
//         responseFormat: "text",
//         parentLabel: "main agent",
//       });
//       expect(result.length).toBeGreaterThan(0);
//       expect(result.some((l) => l.includes("accomplished"))).toBe(true);
//     });
//   });
//
//   describe('responseFormat = "json"', () => {
//     it('includes "JSON" related instructions', () => {
//       const result = buildResponseFormatInstructions({
//         responseFormat: "json",
//         parentLabel: "main agent",
//       });
//       expect(result.some((l) => l.includes("JSON"))).toBe(true);
//     });
//
//     it("includes stringified schema when responseSchema is provided", () => {
//       const schema = { type: "object", properties: { status: { type: "string" } } };
//       const result = buildResponseFormatInstructions({
//         responseFormat: "json",
//         responseSchema: schema,
//         parentLabel: "main agent",
//       });
//       expect(result.some((l) => l.includes(JSON.stringify(schema)))).toBe(true);
//     });
//   });
//
//   describe('responseFormat = "structured"', () => {
//     it('includes "meta" and "body" related instructions', () => {
//       const result = buildResponseFormatInstructions({
//         responseFormat: "structured",
//         parentLabel: "main agent",
//       });
//       expect(result.some((l) => l.includes("meta"))).toBe(true);
//       expect(result.some((l) => l.includes("body"))).toBe(true);
//     });
//   });
// });
