import {
  calculateCost,
  createAssistantMessageEventStream,
  type AssistantMessage,
  type AssistantMessageEventStream,
  type Context,
  type Model,
  type SimpleStreamOptions,
  type Tool,
  type ToolCall,
  type ToolResultMessage,
  type UserMessage,
} from "@earendil-works/pi-ai";
import { createSessionHeaders } from "./headers.js";

const UPSTREAM_URL = "https://opencode.ai/zen/v1/chat/completions";

export type ParsedSseDelta =
  | { type: "text"; text: string }
  | { type: "thinking"; text: string }
  | { type: "tool_calls"; calls: any[] }
  | { type: "finish"; reason: string }
  | { type: "usage"; usage: any }
  | { type: "done" }
  | null;

export function parseSseLine(line: string): ParsedSseDelta {
  const trimmed = line.trim();
  if (!trimmed || !trimmed.startsWith("data:")) return null;
  const raw = trimmed.slice(5).trim();
  if (raw === "[DONE]") return { type: "done" };

  try {
    const json = JSON.parse(raw);
    const choice = json.choices?.[0];
    const delta = choice?.delta;
    if (delta?.reasoning_content) return { type: "thinking", text: delta.reasoning_content };
    if (delta?.content) return { type: "text", text: delta.content };
    if (delta?.tool_calls) return { type: "tool_calls", calls: delta.tool_calls };
    if (choice?.finish_reason) return { type: "finish", reason: choice.finish_reason };
    if (json.usage) return { type: "usage", usage: json.usage };
    return null;
  } catch {
    return null;
  }
}

interface ToolCallAccumulator {
  id: string;
  name: string;
  argsJson: string;
  contentIndex: number;
}

type OpenAiContentPart =
  | { type: "text"; text: string }
  | { type: "image_url"; image_url: { url: string } };

function userContentToOpenAi(content: UserMessage["content"]): string | OpenAiContentPart[] {
  if (typeof content === "string") return content;
  return content.map(block =>
    block.type === "image"
      ? { type: "image_url", image_url: { url: `data:${block.mimeType};base64,${block.data}` } }
      : { type: "text", text: block.text }
  );
}

function assistantToOpenAi(msg: AssistantMessage): Record<string, unknown> {
  const out: Record<string, unknown> = { role: "assistant" };
  const text: string[] = [];
  const thinking: string[] = [];
  const toolCalls: Array<{ id: string; type: "function"; function: { name: string; arguments: string } }> = [];

  for (const block of msg.content) {
    if (block.type === "text") text.push(block.text);
    else if (block.type === "thinking") thinking.push(block.thinking);
    else if (block.type === "toolCall") {
      toolCalls.push({
        id: block.id,
        type: "function",
        function: { name: block.name, arguments: JSON.stringify(block.arguments ?? {}) },
      });
    }
  }

  // Reasoning models (DeepSeek/Nemotron) require prior thinking to be replayed
  // in the root `reasoning_content` field for multi-turn/tool-call continuity.
  if (thinking.length > 0) out.reasoning_content = thinking.join("");
  out.content = text.join("");
  if (toolCalls.length > 0) out.tool_calls = toolCalls;
  return out;
}

function toolResultToOpenAi(msg: ToolResultMessage): Record<string, unknown> {
  const parts: OpenAiContentPart[] = msg.content.map(block =>
    block.type === "image"
      ? { type: "image_url", image_url: { url: `data:${block.mimeType};base64,${block.data}` } }
      : { type: "text", text: block.text }
  );
  const content = parts.length === 1 && parts[0].type === "text" ? parts[0].text : parts;
  return { role: "tool", tool_call_id: msg.toolCallId, content };
}

/**
 * Converts pi messages into the OpenAI chat-completions shape expected by the
 * OpenCode Zen API. The system prompt is injected as the first message, and
 * assistant thinking/tool-call blocks are hoisted to the message root fields
 * (`reasoning_content`, `tool_calls`) the upstream API requires.
 */
export function adaptMessages(context: Context): Record<string, unknown>[] {
  const messages: Record<string, unknown>[] = [];
  if (context.systemPrompt) {
    messages.push({ role: "system", content: context.systemPrompt });
  }
  for (const msg of context.messages) {
    if (msg.role === "user") messages.push({ role: "user", content: userContentToOpenAi(msg.content) });
    else if (msg.role === "assistant") messages.push(assistantToOpenAi(msg));
    else if (msg.role === "toolResult") messages.push(toolResultToOpenAi(msg));
  }
  return messages;
}

/**
 * Converts pi tools into the OpenAI `{ type: "function", function: {...} }`
 * shape required by the OpenCode Zen API.
 */
export function adaptTools(tools?: Tool[]): Record<string, unknown>[] | undefined {
  if (!tools || tools.length === 0) return undefined;
  return tools.map(t => ({
    type: "function",
    function: {
      name: t.name,
      description: t.description,
      parameters: t.parameters,
    },
  }));
}

export function streamOpenCodeDirect(
  model: Model<any>,
  context: Context,
  options?: SimpleStreamOptions
): AssistantMessageEventStream {
  const stream = createAssistantMessageEventStream();

  (async () => {
    const output: AssistantMessage = {
      role: "assistant",
      content: [],
      api: model.api,
      provider: model.provider,
      model: model.id,
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: "pending",
      timestamp: Date.now(),
    };

    try {
      stream.push({ type: "start", partial: output });
      const headers = createSessionHeaders(context.messages);
      const payload: Record<string, unknown> = {
        model: model.id.replace(/^opencode\//, ""),
        messages: adaptMessages(context),
        tools: adaptTools(context.tools),
        stream: true,
      };
      if (options?.reasoning !== undefined) payload.reasoning = options.reasoning;

      const res = await fetch(UPSTREAM_URL, {
        method: "POST",
        headers,
        body: JSON.stringify(payload),
        signal: options?.signal,
      });

      if (!res.ok) throw new Error(`OpenCode Zen HTTP error ${res.status}: ${await res.text()}`);
      if (!res.body) throw new Error("No response body received from OpenCode Zen");

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let finishReason: string | undefined;
      let textIndex = -1;
      let thinkingIndex = -1;
      const toolCalls = new Map<number, ToolCallAccumulator>();

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";

        for (const line of lines) {
          const parsed = parseSseLine(line);
          if (!parsed) continue;

          if (parsed.type === "thinking") {
            let idx = thinkingIndex;
            if (idx < 0) {
              output.content.push({ type: "thinking", thinking: "" });
              thinkingIndex = output.content.length - 1;
              idx = thinkingIndex;
              stream.push({ type: "thinking_start", contentIndex: idx, partial: output });
            }
            const block = output.content[idx] as Extract<AssistantMessage["content"][number], { type: "thinking" }>;
            block.thinking += parsed.text;
            stream.push({ type: "thinking_delta", contentIndex: idx, delta: parsed.text, partial: output });
          } else if (parsed.type === "text") {
            let idx = textIndex;
            if (idx < 0) {
              output.content.push({ type: "text", text: "" });
              textIndex = output.content.length - 1;
              idx = textIndex;
              stream.push({ type: "text_start", contentIndex: idx, partial: output });
            }
            const block = output.content[idx] as Extract<AssistantMessage["content"][number], { type: "text" }>;
            block.text += parsed.text;
            stream.push({ type: "text_delta", contentIndex: idx, delta: parsed.text, partial: output });
          } else if (parsed.type === "tool_calls") {
            for (const call of parsed.calls) {
              const idx = call.index ?? 0;
              let acc = toolCalls.get(idx);
              if (!acc) {
                const id = call.id ?? `call_${idx}`;
                const name = call.function?.name ?? "";
                output.content.push({ type: "toolCall", id, name, arguments: {} });
                acc = { id, name, argsJson: "", contentIndex: output.content.length - 1 };
                toolCalls.set(idx, acc);
                stream.push({ type: "toolcall_start", contentIndex: acc.contentIndex, partial: output });
              }
              if (call.function?.name) acc.name = call.function.name;
              if (call.function?.arguments) {
                acc.argsJson += call.function.arguments;
                const block = output.content[acc.contentIndex] as ToolCall;
                block.name = acc.name;
                try {
                  block.arguments = JSON.parse(acc.argsJson);
                } catch {
                  /* keep last valid partial args */
                }
                stream.push({ type: "toolcall_delta", contentIndex: acc.contentIndex, delta: call.function.arguments, partial: output });
              }
            }
          } else if (parsed.type === "finish") {
            finishReason = parsed.reason;
          } else if (parsed.type === "usage") {
            const u = parsed.usage;
            output.usage.input = u?.prompt_tokens ?? u?.input_tokens ?? 0;
            output.usage.output = u?.completion_tokens ?? u?.output_tokens ?? 0;
            output.usage.cacheRead = u?.prompt_cache_hit_tokens ?? u?.cache_read_tokens ?? 0;
            output.usage.cacheWrite = u?.prompt_cache_miss_tokens ?? u?.cache_write_tokens ?? 0;
            output.usage.totalTokens = output.usage.input + output.usage.output + output.usage.cacheRead + output.usage.cacheWrite;
            calculateCost(model, output.usage);
          }
        }
      }

      // Emit end events for any open blocks.
      for (let i = 0; i < output.content.length; i++) {
        const block = output.content[i];
        if (block.type === "text") stream.push({ type: "text_end", contentIndex: i, content: block.text, partial: output });
        else if (block.type === "thinking") stream.push({ type: "thinking_end", contentIndex: i, content: block.thinking, partial: output });
        else if (block.type === "toolCall") stream.push({ type: "toolcall_end", contentIndex: i, toolCall: block, partial: output });
      }

      if (output.stopReason === "pending") {
        output.stopReason = finishReason === "tool_calls" ? "toolUse" : finishReason === "length" ? "length" : "stop";
        output.rawStopReason = finishReason;
      }
      if (output.stopReason === "error" || output.stopReason === "aborted") throw new Error(output.errorMessage || "An unknown error occurred");

      stream.push({ type: "done", reason: output.stopReason, message: output });
      stream.end();
    } catch (err: any) {
      output.stopReason = options?.signal?.aborted ? "aborted" : "error";
      output.errorMessage = err?.message ?? String(err);
      stream.push({ type: "error", reason: output.stopReason, error: output });
      stream.end();
    }
  })();

  return stream;
}
