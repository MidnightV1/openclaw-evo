/**
 * Multi-provider LLM abstraction.
 *
 * Thin wrapper — each provider implements the same interface.
 * Provider selection via CRYSTALLIZER_PROVIDER env var.
 */

// ---------------------------------------------------------------------------
// Interface
// ---------------------------------------------------------------------------

export type LLMRequest = {
  model: string;
  system: string;
  userContent: string;
  maxTokens?: number;
  /**
   * Thinking/reasoning mode.
   * - Gemini 3.x: thinkingLevel — "low" | "medium" | "high"
   * - Gemini 2.x: thinkingBudget — number (token count)
   * - true defaults to "medium" for 3.x, 8192 for 2.x
   */
  thinking?: boolean | number | "low" | "medium" | "high";
};

export type LLMProvider = {
  name: string;
  complete(req: LLMRequest): Promise<string>;
};

// ---------------------------------------------------------------------------
// Anthropic
// ---------------------------------------------------------------------------

function createAnthropic(apiKey: string, baseUrl?: string): LLMProvider {
  const url = baseUrl || "https://api.anthropic.com/v1/messages";
  return {
    name: "anthropic",
    async complete(req) {
      const response = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": apiKey,
          "anthropic-version": "2023-06-01",
        },
        body: JSON.stringify({
          model: req.model,
          max_tokens: req.maxTokens ?? 4096,
          system: req.system,
          messages: [{ role: "user", content: req.userContent }],
        }),
      });
      if (!response.ok) {
        throw new Error(`Anthropic ${response.status}: ${await response.text()}`);
      }
      const result = (await response.json()) as {
        content: { type: string; text: string }[];
      };
      return result.content
        .filter((b) => b.type === "text")
        .map((b) => b.text)
        .join("\n");
    },
  };
}

// ---------------------------------------------------------------------------
// Google Gemini
// ---------------------------------------------------------------------------

function createGemini(apiKey: string, baseUrl?: string): LLMProvider {
  return {
    name: "gemini",
    async complete(req) {
      const url =
        baseUrl ||
        `https://generativelanguage.googleapis.com/v1beta/models/${req.model}:generateContent?key=${apiKey}`;

      const generationConfig: Record<string, unknown> = {
        maxOutputTokens: req.maxTokens ?? 4096,
      };

      // Thinking mode:
      //   Gemini 3.x → thinkingLevel: "low" | "medium" | "high"
      //   Gemini 2.x → thinkingBudget: number
      //   Cannot mix thinkingLevel and thinkingBudget in the same request.
      if (req.thinking) {
        const isGemini3 = req.model.includes("gemini-3");
        if (typeof req.thinking === "string") {
          // Explicit level: "low" | "medium" | "high"
          generationConfig.thinkingConfig = { thinkingLevel: req.thinking };
        } else if (typeof req.thinking === "number") {
          // Explicit budget (2.x style)
          generationConfig.thinkingConfig = { thinkingBudget: req.thinking };
        } else {
          // true → pick sensible default by model generation
          generationConfig.thinkingConfig = isGemini3
            ? { thinkingLevel: "medium" }
            : { thinkingBudget: 8192 };
        }
      }

      const response = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          system_instruction: { parts: [{ text: req.system }] },
          contents: [{ role: "user", parts: [{ text: req.userContent }] }],
          generationConfig,
        }),
      });
      if (!response.ok) {
        throw new Error(`Gemini ${response.status}: ${await response.text()}`);
      }
      const result = (await response.json()) as {
        candidates: { content: { parts: { text?: string; thought?: boolean }[] } }[];
      };
      // Filter out thinking parts, only return final output
      return (
        result.candidates[0]?.content.parts
          .filter((p) => !p.thought && p.text)
          .map((p) => p.text!)
          .join("\n") ?? ""
      );
    },
  };
}

// ---------------------------------------------------------------------------
// OpenAI-compatible (OpenAI, DeepSeek, etc.)
// ---------------------------------------------------------------------------

function createOpenAI(apiKey: string, baseUrl?: string): LLMProvider {
  const url = baseUrl || "https://api.openai.com/v1/chat/completions";
  return {
    name: "openai",
    async complete(req) {
      const response = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          model: req.model,
          max_tokens: req.maxTokens ?? 4096,
          messages: [
            { role: "system", content: req.system },
            { role: "user", content: req.userContent },
          ],
        }),
      });
      if (!response.ok) {
        throw new Error(`OpenAI ${response.status}: ${await response.text()}`);
      }
      const result = (await response.json()) as {
        choices: { message: { content: string } }[];
      };
      return result.choices[0]?.message.content ?? "";
    },
  };
}

// ---------------------------------------------------------------------------
// OpenRouter (unified gateway for any model)
// ---------------------------------------------------------------------------

function createOpenRouter(apiKey: string): LLMProvider {
  return {
    name: "openrouter",
    async complete(req) {
      const response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          model: req.model,
          max_tokens: req.maxTokens ?? 4096,
          messages: [
            { role: "system", content: req.system },
            { role: "user", content: req.userContent },
          ],
        }),
      });
      if (!response.ok) {
        throw new Error(`OpenRouter ${response.status}: ${await response.text()}`);
      }
      const result = (await response.json()) as {
        choices: { message: { content: string } }[];
      };
      return result.choices[0]?.message.content ?? "";
    },
  };
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export type ProviderConfig = {
  provider: string;
  apiKey: string;
  baseUrl?: string;
};

export function createProvider(config: ProviderConfig): LLMProvider {
  switch (config.provider) {
    case "anthropic":
      return createAnthropic(config.apiKey, config.baseUrl);
    case "gemini":
      return createGemini(config.apiKey, config.baseUrl);
    case "openai":
    case "deepseek":
      return createOpenAI(config.apiKey, config.baseUrl);
    case "openrouter":
      return createOpenRouter(config.apiKey);
    default:
      throw new Error(
        `Unknown provider: ${config.provider}. Supported: anthropic, gemini, openai, deepseek, openrouter`,
      );
  }
}
