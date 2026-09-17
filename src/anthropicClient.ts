import { ChatMessage, ToolDefinition, CompletionResult } from './types';
import { SetupConfig, getSetupFilePath } from './setupConfig';
import { log, logError } from './logger';

const REQUEST_TIMEOUT_MS = 120_000;
const ANTHROPIC_VERSION = '2023-06-01';
const DEFAULT_ANTHROPIC_BASE_URL = 'https://api.anthropic.com';

/**
 * Converts our internal OpenAI-shaped history into Anthropic's Messages API
 * shape: system is a separate top-level field (not a message), tool results
 * become tool_result content blocks inside a user turn, and assistant tool
 * calls become tool_use content blocks.
 */
function toAnthropicMessages(history: ChatMessage[]): { system: string | undefined; messages: any[] } {
  let system: string | undefined;
  const messages: any[] = [];
  let openToolResultGroup: any = null;

  for (const msg of history) {
    if (msg.role === 'system') {
      system = system ? `${system}\n\n${msg.content || ''}` : msg.content || '';
      openToolResultGroup = null;
      continue;
    }

    if (msg.role === 'user') {
      messages.push({ role: 'user', content: msg.content || '' });
      openToolResultGroup = null;
      continue;
    }

    if (msg.role === 'assistant') {
      const blocks: any[] = [];
      if (msg.content) blocks.push({ type: 'text', text: msg.content });

      const calls = (msg as any).tool_calls as any[] | undefined;
      if (calls) {
        for (const call of calls) {
          let input: any = {};
          try {
            input = call.function?.arguments ? JSON.parse(call.function.arguments) : {};
          } catch {
            input = {};
          }
          blocks.push({ type: 'tool_use', id: call.id, name: call.function?.name, input });
        }
      }

      messages.push({ role: 'assistant', content: blocks.length ? blocks : '' });
      openToolResultGroup = null;
      continue;
    }

    if (msg.role === 'tool') {
      // Anthropic expects all tool results from one assistant turn to arrive
      // together as multiple tool_result blocks inside a single user turn -
      // so consecutive tool messages get folded into one message here.
      const block = { type: 'tool_result', tool_use_id: msg.tool_call_id, content: msg.content || '' };
      if (openToolResultGroup) {
        openToolResultGroup.content.push(block);
      } else {
        openToolResultGroup = { role: 'user', content: [block] };
        messages.push(openToolResultGroup);
      }
      continue;
    }
  }

  return { system, messages: coalesceConsecutiveRoles(messages) };
}

/**
 * Anthropic's Messages API requires strict user/assistant alternation - two
 * messages with the same role back to back are rejected outright by some
 * backends. Our internal history doesn't guarantee that (e.g. hitting the
 * step limit mid-turn, then the user sending a new message, can produce two
 * consecutive "user" turns: one from folded tool results, one from the new
 * message). OpenAI-compatible APIs don't care about this, so it went
 * unnoticed there; Anthropic does care, so merge any adjacent same-role
 * messages into one before sending.
 */
function coalesceConsecutiveRoles(messages: any[]): any[] {
  const toBlocks = (content: any): any[] =>
    Array.isArray(content) ? content : content ? [{ type: 'text', text: content }] : [];

  const result: any[] = [];
  for (const msg of messages) {
    const prev = result[result.length - 1];
    if (prev && prev.role === msg.role) {
      prev.content = [...toBlocks(prev.content), ...toBlocks(msg.content)];
    } else {
      result.push({ role: msg.role, content: msg.content });
    }
  }
  return result;
}

function toAnthropicTools(tools: ToolDefinition[]): any[] {
  return tools.map((t) => ({
    name: t.function.name,
    description: t.function.description,
    input_schema: t.function.parameters,
  }));
}

function fromAnthropicResponse(data: any): ChatMessage {
  const blocks: any[] = Array.isArray(data.content) ? data.content : [];
  let text = '';
  const toolCalls: any[] = [];

  for (const block of blocks) {
    if (block.type === 'text' && typeof block.text === 'string') {
      text += (text ? '\n' : '') + block.text;
    } else if (block.type === 'tool_use') {
      toolCalls.push({
        id: block.id,
        type: 'function',
        function: { name: block.name, arguments: JSON.stringify(block.input || {}) },
      });
    }
  }

  return { role: 'assistant', content: text || null, tool_calls: toolCalls.length ? toolCalls : undefined };
}

/**
 * Sends one request to Anthropic's Messages API (POST {baseUrl}/v1/messages).
 * `cfg` is the already-read setup.json config (with env-var fallbacks for
 * the anthropic* fields already applied by readSetupConfig).
 */
export async function anthropicChatCompletion(
  messages: ChatMessage[],
  tools: ToolDefinition[],
  cfg: SetupConfig
): Promise<CompletionResult> {
  const baseUrl = (cfg.anthropicBaseUrl || DEFAULT_ANTHROPIC_BASE_URL).replace(/\/+$/, '');
  const model = cfg.anthropicModel;
  const apiKey = cfg.anthropicApiKey;
  const authToken = cfg.anthropicAuthToken;

  if (!apiKey && !authToken) {
    const msg =
      `No Anthropic credentials configured. Set "anthropicApiKey" or "anthropicAuthToken" in ${getSetupFilePath()} ` +
      '(or the ANTHROPIC_API_KEY / ANTHROPIC_AUTH_TOKEN environment variables).';
    logError(msg);
    throw new Error(msg);
  }
  if (!model) {
    const msg =
      `No Anthropic model configured. Set "anthropicModel" in ${getSetupFilePath()} (or the ANTHROPIC_MODEL ` +
      'environment variable), e.g. "claude-sonnet-4-5".';
    logError(msg);
    throw new Error(msg);
  }

  const url = `${baseUrl}/v1/messages`;
  const { system, messages: anthropicMessages } = toAnthropicMessages(messages);

  if (cfg.maxTokens > 100000) {
    log(
      `Warning: "maxTokens" is ${cfg.maxTokens}, which is unusually high for a max OUTPUT token limit (not a context ` +
        'window size) - most models/providers cap this far lower and will reject the request outright if exceeded. ' +
        'If this request fails with a 400, try lowering "maxTokens" in setup.json (e.g. to 4096 or 8192).'
    );
  }

  const headers: Record<string, string> = {
    'content-type': 'application/json',
    'anthropic-version': ANTHROPIC_VERSION,
  };
  if (authToken) {
    headers['authorization'] = `Bearer ${authToken}`;
  } else {
    headers['x-api-key'] = apiKey;
  }

  const body: Record<string, any> = {
    model,
    max_tokens: cfg.maxTokens,
    temperature: cfg.temperature,
    messages: anthropicMessages,
  };
  if (system) body.system = system;
  if (tools.length) body.tools = toAnthropicTools(tools);

  log(`POST ${url} | model=${model} | messages=${anthropicMessages.length} | tools=${tools.length} | provider=anthropic`);
  const bodyText = JSON.stringify(body);
  log(`Request body: ${bodyText.slice(0, 4000)}${bodyText.length > 4000 ? ' ...(truncated)' : ''}`);

  const controller = new AbortController();
  const timeoutHandle = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  let response: Response;
  try {
    response = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body), signal: controller.signal });
  } catch (err: any) {
    const isTimeout = err?.name === 'AbortError';
    const message = isTimeout
      ? `Request to ${url} timed out after ${REQUEST_TIMEOUT_MS / 1000}s with no response from the server.`
      : `Could not reach ${url}. Check "anthropicBaseUrl" in ${getSetupFilePath()} and your network. (${err.message})`;
    logError('anthropicChatCompletion: fetch failed', err);
    throw new Error(message);
  } finally {
    clearTimeout(timeoutHandle);
  }

  const rawText = await response.text();
  log(`Response: ${response.status} ${response.statusText}, ${rawText.length} bytes`);
  log(`Response body: ${rawText.slice(0, 4000)}${rawText.length > 4000 ? ' ...(truncated)' : ''}`);

  if (!response.ok) {
    logError(`Anthropic API request failed (${response.status} ${response.statusText})`, rawText.slice(0, 2000));
    throw new Error(`Anthropic API request failed (${response.status} ${response.statusText}): ${rawText.slice(0, 800)}`);
  }

  let data: any;
  try {
    data = JSON.parse(rawText);
  } catch {
    logError('Anthropic response body was not valid JSON', rawText.slice(0, 2000));
    throw new Error(`Anthropic API returned a response that isn't valid JSON: ${rawText.slice(0, 300)}`);
  }

  if (data.type === 'error') {
    const errMsg = data.error?.message || 'unknown error';
    logError('Anthropic API returned an error object', JSON.stringify(data));
    throw new Error(`Anthropic API error: ${errMsg}`);
  }

  return { message: fromAnthropicResponse(data) };
}
