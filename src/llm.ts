import type { ExtensionContext, ToolDefinition } from "@earendil-works/pi-coding-agent";

const DEFAULT_TIMEOUT_MS = 60_000;
/** Rounds of tool execution allowed after the initial reply (the extraction
 *  tool loop was measured at ~10 tool calls; the timeout is the real backstop). */
const MAX_TOOL_ROUNDS = 10;

type LlmTool = ToolDefinition<any, any>;
type ToolCallBlock = {
  type: "toolCall";
  id: string;
  name: string;
  arguments: Record<string, unknown>;
};

/**
 * LLM text completion through the in-process model registry. Returns
 * undefined on any failure (older pi hosts without `complete`, thrown errors,
 * empty replies) so callers can fall back to a local result. The resolved
 * model is passed in; each caller decides which model to use.
 *
 * When `options.tools` is given, the model may call them (read-only project
 * tools such as grep): each call is executed locally and the results are fed
 * back, up to MAX_TOOL_ROUNDS rounds.
 */
export async function completeText(
  ctx: ExtensionContext,
  model: Parameters<ExtensionContext["modelRegistry"]["complete"]>[0],
  systemPrompt: string,
  userText: string,
  options?: { signal?: AbortSignal; timeoutMs?: number; tools?: LlmTool[] },
): Promise<string | undefined> {
  if (typeof ctx.modelRegistry?.complete !== "function") return undefined;
  if (options?.signal?.aborted) return undefined;
  const tools = options?.tools?.map((tool) => ({
    name: tool.name,
    description: tool.description,
    parameters: tool.parameters,
  }));
  const messages: Parameters<ExtensionContext["modelRegistry"]["complete"]>[1]["messages"] = [
    {
      role: "user",
      content: [{ type: "text", text: userText }],
      timestamp: Date.now(),
    },
  ];

  try {
    // One deadline for the whole operation (all tool rounds), not per call.
    const deadline = AbortSignal.timeout(options?.timeoutMs ?? DEFAULT_TIMEOUT_MS);
    const signal = options?.signal ? AbortSignal.any([options.signal, deadline]) : deadline;
    for (let rounds = 0; ; ) {
      const response = await ctx.modelRegistry.complete(model, { systemPrompt, messages, tools }, { signal });
      const text = response.content
        .filter((block): block is { type: "text"; text: string } => block.type === "text")
        .map((block) => block.text)
        .join("\n");
      const toolCalls = response.content.filter(
        (block): block is ToolCallBlock => block.type === "toolCall",
      );
      if (toolCalls.length === 0 || !options?.tools) {
        return text.length > 0 ? text : undefined;
      }
      // Tool-execution budget spent: keep any answer the model produced
      // alongside its tool calls instead of discarding it into undefined.
      if (rounds >= MAX_TOOL_ROUNDS) return text.length > 0 ? text : undefined;
      rounds += 1;

      messages.push(response); // assistant reply containing the tool calls
      for (const call of toolCalls) {
        const tool = options.tools.find((candidate) => candidate.name === call.name);
        let content: Awaited<ReturnType<LlmTool["execute"]>>["content"];
        let isError = false;
        try {
          if (!tool) throw new Error(`Unknown tool: ${call.name}`);
          const result = await tool.execute(call.id, call.arguments, signal, undefined, ctx);
          content = result.content;
        } catch (error) {
          isError = true;
          content = [
            {
              type: "text",
              text: `Error: ${error instanceof Error ? error.message : String(error)}`,
            },
          ];
        }
        messages.push({
          role: "toolResult",
          toolCallId: call.id,
          toolName: call.name,
          content,
          isError,
          timestamp: Date.now(),
        });
      }
    }
    return undefined;
  } catch {
    return undefined;
  }
}
