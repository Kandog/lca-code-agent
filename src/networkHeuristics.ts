/**
 * Heuristics for spotting shell commands that likely reach the network.
 * Not exhaustive and not meant to be — this is a best-effort tripwire that
 * makes the approval prompt loud and explicit for the common cases (curl,
 * wget, git push, package installs, etc.), not a sandbox. execute_command is
 * a general-purpose shell tool by design; this just ensures a human always
 * sees and confirms the specific network-shaped command before it runs,
 * even if "autoApprove" is on for everything else.
 */
const NETWORK_COMMAND_PATTERNS: RegExp[] = [
  /\bcurl\b/i,
  /\bwget\b/i,
  /\bInvoke-WebRequest\b/i,
  /\bInvoke-RestMethod\b/i,
  /\biwr\b/i,
  /\bnc\b|\bncat\b|\bnetcat\b/i,
  /\bssh\b|\bscp\b|\bsftp\b/i,
  /\bftp\b/i,
  /\btelnet\b/i,
  /\bping\b/i,
  /https?:\/\//i,
  /\bNet\.WebClient\b/i,
  /\bDownloadString\b|\bDownloadFile\b/i,
  /\brequests\.(get|post|put|patch|delete)\s*\(/i,
  /\bfetch\s*\(/i,
  /\baxios\b/i,
  /\bnpm\s+(install|i|publish)\b/i,
  /\byarn\s+add\b/i,
  /\bpnpm\s+(add|install)\b/i,
  /\bpip3?\s+install\b/i,
  /\bgit\s+(push|pull|fetch|clone)\b/i,
  /\bdocker\s+pull\b/i,
];

export function looksLikeNetworkCommand(command: string): boolean {
  if (!command) return false;
  return NETWORK_COMMAND_PATTERNS.some((re) => re.test(command));
}
