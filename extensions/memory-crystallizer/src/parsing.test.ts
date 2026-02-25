/**
 * Unit tests for parsing.ts — pure function tests, zero external dependencies.
 * Run: npx tsx --test extensions/memory-crystallizer/src/parsing.test.ts
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  normalizeWinPath,
  extractText,
  buildSignalPairs,
  parseStage1Result,
  parseStage2Result,
  resolveRoutePath,
  type FileRoute,
} from "./parsing.js";

// ---------------------------------------------------------------------------
// normalizeWinPath
// ---------------------------------------------------------------------------

describe("normalizeWinPath", () => {
  it("strips leading / from Windows drive paths", () => {
    assert.equal(normalizeWinPath("/D:/foo/bar", "win32"), "D:/foo/bar");
    assert.equal(normalizeWinPath("/C:/Users/test", "win32"), "C:/Users/test");
  });

  it("handles lowercase drive letter", () => {
    assert.equal(normalizeWinPath("/d:/path", "win32"), "d:/path");
  });

  it("no-ops on non-Windows platforms", () => {
    assert.equal(normalizeWinPath("/D:/foo/bar", "linux"), "/D:/foo/bar");
    assert.equal(normalizeWinPath("/usr/local/bin", "linux"), "/usr/local/bin");
  });

  it("no-ops when path has no leading /drive: pattern", () => {
    assert.equal(normalizeWinPath("D:/foo/bar", "win32"), "D:/foo/bar");
    assert.equal(normalizeWinPath("relative/path", "win32"), "relative/path");
    assert.equal(normalizeWinPath("/usr/bin", "win32"), "/usr/bin");
  });
});

// ---------------------------------------------------------------------------
// extractText
// ---------------------------------------------------------------------------

describe("extractText", () => {
  it("returns string content as-is", () => {
    assert.equal(extractText("hello world"), "hello world");
  });

  it("extracts text from content block array", () => {
    const blocks = [
      { type: "text", text: "first" },
      { type: "tool_use", id: "123" },
      { type: "text", text: "second" },
    ];
    assert.equal(extractText(blocks), "first\nsecond");
  });

  it("returns empty string for non-text content", () => {
    assert.equal(extractText(null), "");
    assert.equal(extractText(undefined), "");
    assert.equal(extractText(42), "");
    assert.equal(extractText({}), "");
  });

  it("handles empty array", () => {
    assert.equal(extractText([]), "");
  });

  it("filters out null/undefined items in array", () => {
    const blocks = [null, { type: "text", text: "ok" }, undefined];
    assert.equal(extractText(blocks), "ok");
  });
});

// ---------------------------------------------------------------------------
// buildSignalPairs
// ---------------------------------------------------------------------------

describe("buildSignalPairs", () => {
  it("pairs user messages with preceding assistant context", () => {
    const messages = [
      { role: "assistant", content: "I can help with that" },
      { role: "user", content: "Fix the bug in auth.ts" },
    ];
    const { pairs, userCount } = buildSignalPairs(messages);
    assert.equal(userCount, 1);
    assert.ok(pairs.includes("[Context]: I can help with that"));
    assert.ok(pairs.includes("[User]: Fix the bug in auth.ts"));
  });

  it("handles user message without preceding assistant", () => {
    const messages = [{ role: "user", content: "Hello" }];
    const { pairs, userCount } = buildSignalPairs(messages);
    assert.equal(userCount, 1);
    assert.equal(pairs, "[User]: Hello");
    assert.ok(!pairs.includes("[Context]"));
  });

  it("truncates assistant context to 600 chars", () => {
    const longAssistant = "x".repeat(1000);
    const messages = [
      { role: "assistant", content: longAssistant },
      { role: "user", content: "ok" },
    ];
    const { pairs } = buildSignalPairs(messages);
    const contextMatch = pairs.match(/\[Context\]: (x+)/);
    assert.ok(contextMatch);
    assert.ok(contextMatch[1].length <= 600);
  });

  it("skips empty user messages", () => {
    const messages = [
      { role: "user", content: "" },
      { role: "user", content: "   " },
      { role: "user", content: "real message" },
    ];
    const { userCount } = buildSignalPairs(messages);
    assert.equal(userCount, 1);
  });

  it("skips non-object messages", () => {
    const messages = [null, undefined, "garbage", 42, { role: "user", content: "ok" }];
    const { userCount } = buildSignalPairs(messages);
    assert.equal(userCount, 1);
  });

  it("counts multiple user messages correctly", () => {
    const messages = [
      { role: "user", content: "first" },
      { role: "assistant", content: "response" },
      { role: "user", content: "second" },
      { role: "assistant", content: "response 2" },
      { role: "user", content: "third" },
    ];
    const { pairs, userCount } = buildSignalPairs(messages);
    assert.equal(userCount, 3);
    assert.equal(pairs.split("---").length, 3);
  });

  it("resets assistant context after pairing", () => {
    const messages = [
      { role: "assistant", content: "ctx1" },
      { role: "user", content: "msg1" },
      { role: "user", content: "msg2" },
    ];
    const { pairs } = buildSignalPairs(messages);
    const sections = pairs.split("---").map((s) => s.trim());
    assert.ok(sections[0].includes("[Context]: ctx1"));
    assert.ok(!sections[1].includes("[Context]"));
  });

  it("handles content block arrays in messages", () => {
    const messages = [
      { role: "user", content: [{ type: "text", text: "block content" }] },
    ];
    const { pairs, userCount } = buildSignalPairs(messages);
    assert.equal(userCount, 1);
    assert.ok(pairs.includes("block content"));
  });
});

// ---------------------------------------------------------------------------
// parseStage1Result
// ---------------------------------------------------------------------------

describe("parseStage1Result", () => {
  it("parses unchanged portrait", () => {
    const result = parseStage1Result('<portrait action="unchanged" />');
    assert.deepEqual(result, { action: "unchanged" });
  });

  it("parses updated portrait with content", () => {
    const xml = `<portrait action="updated">
# User Profile

Prefers direct communication. Senior engineer with systems background.
</portrait>`;
    const result = parseStage1Result(xml);
    assert.equal(result.action, "updated");
    assert.ok(result.content!.includes("Prefers direct communication"));
    assert.ok(result.content!.includes("Senior engineer"));
  });

  it("trims whitespace from portrait content", () => {
    const xml = '<portrait action="updated">\n\n  Some content  \n\n</portrait>';
    const result = parseStage1Result(xml);
    assert.equal(result.content, "Some content");
  });

  it("handles unchanged with extra whitespace", () => {
    const result = parseStage1Result('  <portrait   action="unchanged"  />  ');
    assert.deepEqual(result, { action: "unchanged" });
  });

  it("falls back to raw content when XML wrapper missing (>100 chars)", () => {
    const longContent = "This is a detailed portrait of the user. ".repeat(5);
    const result = parseStage1Result(longContent);
    assert.equal(result.action, "updated");
    assert.equal(result.content, longContent.trim());
  });

  it("returns unchanged for short non-XML output (<= 100 chars)", () => {
    const result = parseStage1Result("Sorry, I cannot process this.");
    assert.deepEqual(result, { action: "unchanged" });
  });

  it("prioritizes unchanged over updated when both present", () => {
    const xml = '<portrait action="unchanged" /><portrait action="updated">content</portrait>';
    const result = parseStage1Result(xml);
    assert.equal(result.action, "unchanged");
  });

  it("handles multiline markdown content", () => {
    const xml = `<portrait action="updated">
## Cognitive Patterns

- Top-down thinker
- Prefers entropy reduction

## Communication

- Direct, minimal words
- Chinese for discussion, English for code
</portrait>`;
    const result = parseStage1Result(xml);
    assert.equal(result.action, "updated");
    assert.ok(result.content!.includes("## Cognitive Patterns"));
    assert.ok(result.content!.includes("## Communication"));
  });
});

// ---------------------------------------------------------------------------
// parseStage2Result
// ---------------------------------------------------------------------------

describe("parseStage2Result", () => {
  it("parses single file output", () => {
    const xml = `<files>
  <file path="bootstrap/USER_COGNITION.md">
# User Cognition

Direct communication style.
  </file>
</files>`;
    const results = parseStage2Result(xml);
    assert.equal(results.length, 1);
    assert.equal(results[0].path, "bootstrap/USER_COGNITION.md");
    assert.ok(results[0].content.includes("Direct communication style"));
  });

  it("parses multiple file outputs", () => {
    const xml = `<files>
  <file path="bootstrap/COGNITION.md">Cognition content</file>
  <file path="bootstrap/PREFERENCES.md">Preferences content</file>
  <file path="bootstrap/BACKGROUND.md">Background content</file>
</files>`;
    const results = parseStage2Result(xml);
    assert.equal(results.length, 3);
    assert.equal(results[0].path, "bootstrap/COGNITION.md");
    assert.equal(results[1].path, "bootstrap/PREFERENCES.md");
    assert.equal(results[2].path, "bootstrap/BACKGROUND.md");
  });

  it("skips files with empty content", () => {
    const xml = `<files>
  <file path="a.md">Real content</file>
  <file path="b.md">   </file>
  <file path="c.md"></file>
</files>`;
    const results = parseStage2Result(xml);
    assert.equal(results.length, 1);
    assert.equal(results[0].path, "a.md");
  });

  it("returns empty array for no matches", () => {
    assert.deepEqual(parseStage2Result("no xml here"), []);
    assert.deepEqual(parseStage2Result(""), []);
  });

  it("handles multiline markdown in file content", () => {
    const xml = `<files>
  <file path="test.md">
# Title

Paragraph with **bold** and \`code\`.

- List item 1
- List item 2
  </file>
</files>`;
    const results = parseStage2Result(xml);
    assert.equal(results.length, 1);
    assert.ok(results[0].content.includes("# Title"));
    assert.ok(results[0].content.includes("- List item 1"));
  });
});

// ---------------------------------------------------------------------------
// resolveRoutePath
// ---------------------------------------------------------------------------

describe("resolveRoutePath", () => {
  const routes: FileRoute[] = [
    { path: "bootstrap/USER_COGNITION.md", purpose: "cognition" },
    { path: "bootstrap/PREFERENCES.md", purpose: "preferences" },
  ];

  it("exact match on configured path", () => {
    assert.equal(resolveRoutePath("bootstrap/USER_COGNITION.md", routes), "bootstrap/USER_COGNITION.md");
  });

  it("strips leading slashes before matching", () => {
    assert.equal(resolveRoutePath("/bootstrap/USER_COGNITION.md", routes), "bootstrap/USER_COGNITION.md");
    assert.equal(resolveRoutePath("///bootstrap/USER_COGNITION.md", routes), "bootstrap/USER_COGNITION.md");
  });

  it("normalizes backslashes to forward slashes", () => {
    assert.equal(resolveRoutePath("bootstrap\\USER_COGNITION.md", routes), "bootstrap/USER_COGNITION.md");
  });

  it("falls back to basename matching (case-insensitive)", () => {
    assert.equal(resolveRoutePath("some/other/path/user_cognition.md", routes), "bootstrap/USER_COGNITION.md");
    assert.equal(resolveRoutePath("USER_COGNITION.MD", routes), "bootstrap/USER_COGNITION.md");
  });

  it("returns undefined for unmatched paths", () => {
    assert.equal(resolveRoutePath("bootstrap/UNKNOWN.md", routes), undefined);
    assert.equal(resolveRoutePath("completely/different.txt", routes), undefined);
  });

  it("prefers exact match over basename match", () => {
    const overlappingRoutes: FileRoute[] = [
      { path: "a/file.md", purpose: "first" },
      { path: "b/file.md", purpose: "second" },
    ];
    assert.equal(resolveRoutePath("b/file.md", overlappingRoutes), "b/file.md");
  });

  it("handles empty routes array", () => {
    assert.equal(resolveRoutePath("anything.md", []), undefined);
  });
});
