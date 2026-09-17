import { readSetupConfig, getSetupFilePath, SetupConfig } from './setupConfig';
import { log, logError } from './logger';
import { anthropicChatCompletion } from './anthropicClient';
import { ChatMessage, ToolDefinition, CompletionResult } from './types';

export type { ChatMessage, ToolDefinition, CompletionResult } from './types';

const REQUEST_TIMEOUT_MS = 120_000;

/**
 * Sends a single chat completion request. This is the ONLY network call this
 * extension ever makes (aside from any MCP servers you've configured), and
 * it only ever goes to the base URL read from ~/.lca/setup.json. No
 * telemetry, no update checks, no other endpoints of any kind.
 *
 * Routes to the OpenAI-compatible or Anthropic implementation based on
 * "provider" in setup.json — the rest of the extension (agentLoop, tool
 * dispatch, UI) works with the same ChatMessage/ToolDefinition shape
 * regardless of which provider is active.
 */
export async function chatCompletion(messages: ChatMessage[], tools: ToolDefinition[]): Promise<CompletionResult> {
  const cfg = readSetupConfig();
  const effectiveTools = cfg.toolsEnabled ? tools : [];

  if (cfg.provider === 'anthropic') {
    return anthropicChatCompletion(messages, effectiveTools, cfg);
  }
  return openaiCompatibleChatCompletion(messages, effectiveTools, cfg);
}

async function openaiCompatibleChatCompletion(
  messages: ChatMessage[],
  effectiveTools: ToolDefinition[],
  cfg: SetupConfig
): Promise<CompletionResult> {
  const { baseUrl, apiKey, model, temperature, maxTokens, toolsEnabled } = cfg;

  if (!baseUrl) {
    const message = `No API base URL configured. Edit ${getSetupFilePath()} and set "baseUrl" to your OpenAI-compatible endpoint, e.g. http://localhost:1234/v1 for a local server.`;
    logError(message);
    throw new Error(message);
  }

  const url = `${baseUrl}/chat/completions`;

  if (maxTokens > 100000) {
    log(
      `Warning: "maxTokens" is ${maxTokens}, which is unusually high for a max OUTPUT token limit - most servers ` +
        'cap this far lower and will reject the request outright if exceeded. If this request fails, try lowering ' +
        '"maxTokens" in setup.json (e.g. to 4096 or 8192).'
    );
  }

  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (apiKey) {
    headers['Authorization'] = `Bearer ${apiKey}`;
  }

  const body = {
    model,
    messages,
    tools: effectiveTools.length ? effectiveTools : undefined,
    tool_choice: effectiveTools.length ? 'auto' : undefined,
    temperature,
    max_tokens: maxTokens,
    stream: false,
  };

  log(
    `POST ${url} | model=${model} | messages=${messages.length} | tools=${effectiveTools.length}${toolsEnabled ? '' : ' (tools disabled in setup.json)'} | provider=openai`
  );
  const bodyText = JSON.stringify(body);
  log(`Request body: ${bodyText.slice(0, 4000)}${bodyText.length > 4000 ? ' ...(truncated)' : ''}`);

  const controller = new AbortController();
  const timeoutHandle = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  let response: Response;
  try {
    response = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: controller.signal,
    });
  } catch (err: any) {
    const isTimeout = err?.name === 'AbortError';
    const message = isTimeout
      ? `Request to ${url} timed out after ${REQUEST_TIMEOUT_MS / 1000}s with no response from the server.`
      : `Could not reach ${url}. Check that "baseUrl" in ${getSetupFilePath()} is correct and the server is running. (${err.message})`;
    logError('chatCompletion: fetch failed', err);
    throw new Error(message);
  } finally {
    clearTimeout(timeoutHandle);
  }

  const rawText = await response.text();
  log(`Response: ${response.status} ${response.statusText}, ${rawText.length} bytes`);
  log(`Response body: ${rawText.slice(0, 4000)}${rawText.length > 4000 ? ' ...(truncated)' : ''}`);

  if (!response.ok) {
    logError(`API request failed (${response.status} ${response.statusText})`, rawText.slice(0, 2000));
    throw new Error(`API request failed (${response.status} ${response.statusText}): ${rawText.slice(0, 800)}`);
  }

  let data: any;
  try {
    data = JSON.parse(rawText);
  } catch {
    // Some OpenAI-compatible servers stream Server-Sent Events even when
    // "stream": false is requested. Fall back to parsing that format instead
    // of failing outright.
    if (rawText.trim().startsWith('data:')) {
      log('Response was SSE-formatted despite stream:false; reassembling.');
      return { message: parseSSEToMessage(rawText) };
    }
    logError('Response body was not valid JSON', rawText.slice(0, 2000));
    throw new Error(`API returned a response that isn't valid JSON: ${rawText.slice(0, 300)}`);
  }

  const choice = data.choices?.[0];
  if (!choice || !choice.message) {
    logError('Response JSON had no choices[0].message', rawText.slice(0, 2000));
    throw new Error('API response did not contain a valid choice/message.');
  }
  return { message: choice.message };
}

/**
 * Reconstructs a full chat message from a stream of SSE "data: {...}" chunks
 * in the standard OpenAI chat.completion.chunk shape, accumulating streamed
 * content and (possibly fragmented) tool_calls into one final message.
 */
function parseSSEToMessage(text: string): ChatMessage {
  let content = '';
  let role = 'assistant';
  const toolCalls = new Map<number, { id?: string; type?: string; name: string; args: string }>();

  for (const rawLine of text.split('\n')) {
    const line = rawLine.trim();
    if (!line.startsWith('data:')) continue;
    const payload = line.slice(5).trim();
    if (!payload || payload === '[DONE]') continue;

    let json: any;
    try {
      json = JSON.parse(payload);
    } catch {
      continue;
    }

    const delta = json.choices?.[0]?.delta;
    if (!delta) continue;

    if (delta.role) role = delta.role;
    if (typeof delta.content === 'string') content += delta.content;

    if (Array.isArray(delta.tool_calls)) {
      for (const tc of delta.tool_calls) {
        const idx = typeof tc.index === 'number' ? tc.index : 0;
        const existing = toolCalls.get(idx) || { name: '', args: '' };
        if (tc.id) existing.id = tc.id;
        if (tc.type) existing.type = tc.type;
        if (tc.function?.name) existing.name += tc.function.name;
        if (tc.function?.arguments) existing.args += tc.function.arguments;
        toolCalls.set(idx, existing);
      }
    }
  }

  const tool_calls = toolCalls.size
    ? Array.from(toolCalls.entries())
        .sort((a, b) => a[0] - b[0])
        .map(([, v]) => ({
          id: v.id || '',
          type: v.type || 'function',
          function: { name: v.name, arguments: v.args },
        }))
    : undefined;

  return { role: role as ChatMessage['role'], content: content || null, tool_calls };
}
