import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { readSetupConfig, McpServerConfig } from './setupConfig';
import { ToolDefinition } from './openaiClient';
import { log, logError } from './logger';

interface ConnectedServer {
  name: string;
  client: Client;
  tools: { name: string; description?: string; inputSchema?: any }[];
}

const servers = new Map<string, ConnectedServer>();
// Maps the combined "mcp__server__tool" function-call name back to the real
// server/tool names, so we never have to parse them back out of a string.
const toolNameMap = new Map<string, { serverName: string; toolName: string }>();

let initialized = false;

/**
 * Connects to every server listed in ~/.lca/setup.json's "mcpServers" (same
 * shape used by Claude Desktop / Claude Code: { name: { command, args, env } }).
 * Runs once per extension session; failures for one server don't block the
 * others or the rest of the extension.
 */
export async function initMcpServers(): Promise<void> {
  if (initialized) return;
  initialized = true;

  const { mcpServers } = readSetupConfig();
  const entries = Object.entries(mcpServers || {});
  if (entries.length === 0) return;

  await Promise.all(
    entries.map(([name, cfg]) =>
      connectServer(name, cfg).catch((err) => {
        logError(`MCP server "${name}" failed to connect`, err);
      })
    )
  );
}

async function connectServer(name: string, cfg: McpServerConfig): Promise<void> {
  if (!cfg?.command) {
    logError(`MCP server "${name}" has no "command" configured — skipping.`);
    return;
  }

  log(`Connecting to MCP server "${name}": ${cfg.command} ${(cfg.args || []).join(' ')}`);

  const transport = new StdioClientTransport({
    command: cfg.command,
    args: cfg.args || [],
    env: { ...(process.env as Record<string, string>), ...(cfg.env || {}) },
  });

  const client = new Client({ name: 'lca-code-agent', version: '0.2.0' }, { capabilities: {} });
  await client.connect(transport);

  const { tools } = await client.listTools();
  servers.set(name, { name, client, tools: tools as any });

  for (const tool of tools) {
    const combined = buildCombinedName(name, tool.name);
    toolNameMap.set(combined, { serverName: name, toolName: tool.name });
  }

  log(`MCP server "${name}" connected — ${tools.length} tool(s): ${tools.map((t) => t.name).join(', ') || '(none)'}`);
}

function sanitizeSegment(s: string): string {
  return s.replace(/[^a-zA-Z0-9_-]/g, '_');
}

function buildCombinedName(serverName: string, toolName: string): string {
  return `mcp__${sanitizeSegment(serverName)}__${sanitizeSegment(toolName)}`;
}

/** Tool definitions (OpenAI function-calling shape) for every tool on every connected MCP server. */
export function getMcpToolDefinitions(): ToolDefinition[] {
  const defs: ToolDefinition[] = [];
  for (const server of servers.values()) {
    for (const tool of server.tools) {
      defs.push({
        type: 'function',
        function: {
          name: buildCombinedName(server.name, tool.name),
          description: `[MCP: ${server.name}] ${tool.description || tool.name}`,
          parameters:
            tool.inputSchema && typeof tool.inputSchema === 'object' ? tool.inputSchema : { type: 'object', properties: {} },
        },
      });
    }
  }
  return defs;
}

export function isMcpTool(name: string): boolean {
  return toolNameMap.has(name);
}

/** A short "server: tool" label for display, given a combined tool-call name. */
export function describeMcpTool(name: string): string {
  const mapping = toolNameMap.get(name);
  return mapping ? `${mapping.serverName}: ${mapping.toolName}` : name;
}

function extractResultText(result: any): string {
  if (result && Array.isArray(result.content)) {
    const text = result.content
      .map((c: any) => (c.type === 'text' ? c.text : `[${c.type} content]`))
      .join('\n')
      .trim();
    if (text) return text;
  }
  try {
    return JSON.stringify(result ?? {});
  } catch {
    return String(result);
  }
}

export async function callMcpTool(name: string, args: any): Promise<{ ok: boolean; output: string }> {
  const mapping = toolNameMap.get(name);
  if (!mapping) {
    return { ok: false, output: `Error: unknown MCP tool "${name}".` };
  }
  const server = servers.get(mapping.serverName);
  if (!server) {
    return { ok: false, output: `Error: MCP server "${mapping.serverName}" is not connected.` };
  }
  try {
    const result: any = await server.client.callTool({ name: mapping.toolName, arguments: args || {} });
    return { ok: !result?.isError, output: extractResultText(result) };
  } catch (err: any) {
    logError(`MCP tool call failed: ${name}`, err);
    return { ok: false, output: `Error calling MCP tool "${mapping.toolName}" on "${mapping.serverName}": ${err.message}` };
  }
}

export async function shutdownMcpServers(): Promise<void> {
  for (const server of servers.values()) {
    try {
      await server.client.close();
    } catch {
      // best-effort cleanup
    }
  }
  servers.clear();
  toolNameMap.clear();
  initialized = false;
}
