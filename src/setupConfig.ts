import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

export interface McpServerConfig {
  command: string;
  args?: string[];
  env?: Record<string, string>;
}

export type Provider = 'openai' | 'anthropic';
export type ToolCallStyle = 'native' | 'prompt';

export interface SetupConfig {
  provider: Provider;
  baseUrl: string;
  apiKey: string;
  model: string;
  temperature: number;
  maxTokens: number;
  autoApprove: boolean;
  toolsEnabled: boolean;
  toolCallStyle: ToolCallStyle;
  executeCommandEnabled: boolean;
  maxAgentSteps: number;
  mcpServers: Record<string, McpServerConfig>;
  anthropicBaseUrl: string;
  anthropicApiKey: string;
  anthropicAuthToken: string;
  anthropicModel: string;
}

export const DEFAULT_SETUP_CONFIG: SetupConfig = {
  provider: 'openai',
  baseUrl: '',
  apiKey: '',
  model: 'gpt-4o-mini',
  temperature: 0.2,
  maxTokens: 4096,
  autoApprove: false,
  toolsEnabled: true,
  toolCallStyle: 'native',
  executeCommandEnabled: true,
  maxAgentSteps: 40,
  mcpServers: {},
  anthropicBaseUrl: '',
  anthropicApiKey: '',
  anthropicAuthToken: '',
  anthropicModel: '',
};

export function getSetupDir(): string {
  return path.join(os.homedir(), '.lca');
}

export function getSetupFilePath(): string {
  return path.join(getSetupDir(), 'setup.json');
}

/**
 * Creates ~/.lca/setup.json with default values the first time the
 * extension activates, if it doesn't already exist. Never overwrites an
 * existing file, so user edits persist across updates/reinstalls.
 *
 * The directory and file are locked down to owner-only permissions (0700 /
 * 0600) every time this runs, since setup.json holds API credentials in
 * plaintext — this matters on shared/multi-user machines where other local
 * accounts could otherwise read it. This is applied unconditionally (not
 * just on first creation) so it also retroactively tightens permissions for
 * installs from before this existed. It's a best-effort call: on Windows,
 * fs.chmod only has limited effect (no real POSIX-style ACL), so it's not a
 * hard guarantee there, but it's harmless to attempt.
 */
export function ensureSetupFile(): string {
  const dir = getSetupDir();
  const filePath = getSetupFilePath();

  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  }
  try {
    fs.chmodSync(dir, 0o700);
  } catch {
    // best effort - e.g. unsupported on this platform/filesystem
  }

  if (!fs.existsSync(filePath)) {
    fs.writeFileSync(filePath, JSON.stringify(DEFAULT_SETUP_CONFIG, null, 2) + '\n', { encoding: 'utf8', mode: 0o600 });
  }
  try {
    fs.chmodSync(filePath, 0o600);
  } catch {
    // best effort - e.g. unsupported on this platform/filesystem
  }

  return filePath;
}

/**
 * Reads ~/.lca/setup.json fresh every time (cheap, small file) so edits the
 * user makes take effect on the next request without needing a reload.
 * Missing fields fall back to defaults; a missing/corrupt file falls back
 * to defaults entirely.
 */
export function readSetupConfig(): SetupConfig {
  const filePath = getSetupFilePath();
  try {
    const raw = fs.readFileSync(filePath, 'utf8');
    const parsed = JSON.parse(raw);
    return {
      provider: parsed.provider === 'anthropic' ? 'anthropic' : 'openai',
      baseUrl: typeof parsed.baseUrl === 'string' ? parsed.baseUrl.trim().replace(/\/+$/, '') : DEFAULT_SETUP_CONFIG.baseUrl,
      apiKey: typeof parsed.apiKey === 'string' ? parsed.apiKey : DEFAULT_SETUP_CONFIG.apiKey,
      model: typeof parsed.model === 'string' && parsed.model ? parsed.model : DEFAULT_SETUP_CONFIG.model,
      temperature: typeof parsed.temperature === 'number' ? parsed.temperature : DEFAULT_SETUP_CONFIG.temperature,
      maxTokens: typeof parsed.maxTokens === 'number' ? parsed.maxTokens : DEFAULT_SETUP_CONFIG.maxTokens,
      autoApprove: typeof parsed.autoApprove === 'boolean' ? parsed.autoApprove : DEFAULT_SETUP_CONFIG.autoApprove,
      toolsEnabled: typeof parsed.toolsEnabled === 'boolean' ? parsed.toolsEnabled : DEFAULT_SETUP_CONFIG.toolsEnabled,
      toolCallStyle: parsed.toolCallStyle === 'prompt' ? 'prompt' : DEFAULT_SETUP_CONFIG.toolCallStyle,
      executeCommandEnabled:
        typeof parsed.executeCommandEnabled === 'boolean' ? parsed.executeCommandEnabled : DEFAULT_SETUP_CONFIG.executeCommandEnabled,
      maxAgentSteps:
        typeof parsed.maxAgentSteps === 'number' && parsed.maxAgentSteps > 0
          ? parsed.maxAgentSteps
          : DEFAULT_SETUP_CONFIG.maxAgentSteps,
      mcpServers: parsed.mcpServers && typeof parsed.mcpServers === 'object' ? parsed.mcpServers : DEFAULT_SETUP_CONFIG.mcpServers,
      // Anthropic fields: setup.json value wins, then the matching env var
      // (same names Claude Code/the Anthropic SDKs use), then empty.
      anthropicBaseUrl: pickString(parsed.anthropicBaseUrl, process.env.ANTHROPIC_BASE_URL).trim().replace(/\/+$/, ''),
      anthropicApiKey: pickString(parsed.anthropicApiKey, process.env.ANTHROPIC_API_KEY),
      anthropicAuthToken: pickString(parsed.anthropicAuthToken, process.env.ANTHROPIC_AUTH_TOKEN),
      anthropicModel: pickString(parsed.anthropicModel, process.env.ANTHROPIC_MODEL),
    };
  } catch {
    return { ...DEFAULT_SETUP_CONFIG };
  }
}

function pickString(...candidates: (string | undefined)[]): string {
  for (const c of candidates) {
    if (typeof c === 'string' && c.trim()) return c;
  }
  return '';
}
