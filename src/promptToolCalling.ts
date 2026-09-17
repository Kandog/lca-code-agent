import { ToolDefinition } from './types';

export interface PromptToolCall {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}

export interface ParsedPromptResponse {
  cleanText: string | null;
  toolCalls: PromptToolCall[];
}

const TOOL_CALL_REGEX = /<tool_call\s+name="([^"]+)"\s*>([\s\S]*?)<\/tool_call>/g;

let counter = 0;

/**
 * Extracts <tool_call name="..."> ... </tool_call> blocks from a model's
 * plain-text reply and converts them into the same {id, type, function}
 * shape native tool_calls use, so the rest of the agent loop (approval,
 * diff preview, MCP dispatch, plan tracking) doesn't need to know or care
 * whether a call came from native function-calling or this text fallback.
 */
export function parsePromptToolCalls(text: string): ParsedPromptResponse {
  const toolCalls: PromptToolCall[] = [];

  for (const match of text.matchAll(TOOL_CALL_REGEX)) {
    const name = match[1];
    const rawArgs = match[2].trim();
    let argsJson = '{}';
    try {
      argsJson = JSON.stringify(rawArgs ? JSON.parse(rawArgs) : {});
    } catch {
      // Keep the raw text as a best-effort fallback; downstream JSON.parse
      // will fail gracefully and the tool will just report empty args
      // rather than the whole turn crashing.
      argsJson = rawArgs || '{}';
    }
    counter++;
    toolCalls.push({
      id: `prompt_call_${Date.now()}_${counter}`,
      type: 'function',
      function: { name, arguments: argsJson },
    });
  }

  const cleanText = text.replace(TOOL_CALL_REGEX, '').trim();
  return { cleanText: cleanText || null, toolCalls };
}

/**
 * Describes the available tools and the exact text format to use for
 * calling them, appended to the system prompt for this turn only (never
 * persisted into the saved conversation history).
 */
export function buildPromptToolInstructions(tools: ToolDefinition[]): string {
  if (!tools.length) return '';

  const toolDocs = tools
    .map((t) => `- ${t.function.name}: ${t.function.description}\n  Parameters (JSON Schema): ${JSON.stringify(t.function.parameters)}`)
    .join('\n');

  return (
    '\n\n## Tool calling (text format)\n' +
    "This server doesn't reliably support native function-calling, so tools must be invoked using this exact " +
    'text format instead of any API-level tool mechanism:\n\n' +
    '<tool_call name="TOOL_NAME">\n{"param1": "value1", "param2": "value2"}\n</tool_call>\n\n' +
    'Rules:\n' +
    "- The content between the tags must be a single valid JSON object matching that tool's parameters exactly.\n" +
    '- You can include multiple <tool_call> blocks in one reply to call several tools at once.\n' +
    '- Only use this format when you actually want to call a tool — for a normal reply, just write plain text ' +
    'with no <tool_call> tags at all.\n' +
    '- Never invent a tool name that is not listed below, and never wrap the JSON in markdown code fences.\n\n' +
    `Available tools:\n${toolDocs}`
  );
}
