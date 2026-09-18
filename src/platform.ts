import * as fs from 'fs';
import * as path from 'path';
import { execSync } from 'child_process';
import * as vscode from 'vscode';

export interface ShellInfo {
  /** Path to pass as child_process.exec's `shell` option; undefined = let Node use the OS default. */
  shellPath: string | undefined;
  /** Human-readable description of the shell/OS, embedded in the tool description and system prompt. */
  label: string;
  isPosix: boolean;
}

let cached: ShellInfo | undefined;

/**
 * If VS Code's own integrated terminal is configured to default to Git Bash
 * or WSL, use that same shell here too. This is very likely why tools that
 * drive the *integrated terminal* (rather than spawning their own child
 * process) don't hit this problem on the same machine — they inherit
 * whatever shell the user already has set up and working.
 */
function findVscodeTerminalBash(): string | undefined {
  try {
    const config = vscode.workspace.getConfiguration('terminal.integrated');
    const defaultProfileName = config.get<string>('defaultProfile.windows');
    if (!defaultProfileName) return undefined;

    const profiles = config.get<Record<string, any>>('profiles.windows') || {};
    const profile = profiles[defaultProfileName];
    if (!profile) return undefined;

    const rawPath = Array.isArray(profile.path) ? profile.path[0] : profile.path;
    if (typeof rawPath === 'string' && /bash\.exe$/i.test(rawPath) && fs.existsSync(rawPath)) {
      return rawPath;
    }
  } catch {
    // vscode's config API surface can vary across versions - fall through to other detection.
  }
  return undefined;
}

function findGitBash(): string | undefined {
  const candidates: string[] = [];
  const add = (base: string | undefined) => {
    if (base) candidates.push(path.join(base, 'Git', 'bin', 'bash.exe'));
  };
  add(process.env['ProgramFiles']);
  add(process.env['ProgramFiles(x86)']);
  add(process.env['ProgramW6432']);
  if (process.env['LocalAppData']) {
    candidates.push(path.join(process.env['LocalAppData']!, 'Programs', 'Git', 'bin', 'bash.exe'));
    candidates.push(path.join(process.env['LocalAppData']!, 'GitHubDesktop', 'app-*', 'resources', 'app', 'git', 'bin', 'bash.exe'));
  }

  for (const candidate of candidates) {
    try {
      if (candidate.includes('*')) continue; // skip glob-y candidates, not worth resolving here
      if (fs.existsSync(candidate)) return candidate;
    } catch {
      // ignore and try the next candidate
    }
  }
  return undefined;
}

/** Last resort: ask Windows itself whether `bash` resolves on PATH at all — covers
 * portable/scoop/chocolatey Git installs, and WSL's own bash.exe shim in System32. */
function findBashOnPath(): string | undefined {
  try {
    const output = execSync('where bash', { timeout: 3000, windowsHide: true }).toString();
    const first = output.split(/\r?\n/).find((line) => line.trim());
    if (first && fs.existsSync(first.trim())) return first.trim();
  } catch {
    // `where` failed or bash isn't on PATH - fine, just means this path found nothing.
  }
  return undefined;
}

/**
 * Figures out, once per session, what execute_command should actually run
 * through. On macOS/Linux this is trivial (the OS default shell already has
 * every standard Unix tool). On Windows, cmd.exe (Node's default there) has
 * none of them - so this checks, in order: the shell VS Code's own
 * integrated terminal is configured to use, common Git-for-Windows install
 * locations, and finally whatever `bash` resolves to on PATH (covers
 * portable/scoop/choco installs and WSL's bash.exe shim). If any of those
 * find a real POSIX bash, we use it, making head/tail/wc/find/grep/cat/ls
 * etc. just work rather than relying on the model guessing the right
 * OS-specific command every time. Falls back to cmd.exe with much more
 * specific guidance (including concrete PowerShell one-liners) only if none
 * of that turns up a shell.
 */
export function detectShell(): ShellInfo {
  if (cached) return cached;

  if (process.platform !== 'win32') {
    cached = {
      shellPath: undefined,
      isPosix: true,
      label:
        process.platform === 'darwin'
          ? 'macOS (bash/zsh) — standard Unix tools (ls, grep, cat, rm, head, tail, wc, find, sed, awk, etc.) are available.'
          : 'Linux (bash/sh) — standard Unix tools (ls, grep, cat, rm, head, tail, wc, find, sed, awk, etc.) are available.',
    };
    return cached;
  }

  const bash = findVscodeTerminalBash() || findGitBash() || findBashOnPath();
  if (bash) {
    cached = {
      shellPath: bash,
      isPosix: true,
      label:
        `Windows — execute_command runs through a real POSIX shell (${bash}), so standard Unix tools ` +
        '(head, tail, wc, find, grep, cat, ls, sed, awk, cut, sort, uniq, xargs, etc.) all work normally, the same ' +
        'as on macOS/Linux. Windows-only commands (dir, findstr, type, copy, del) are NOT available here — use ' +
        'their Unix equivalents instead (ls, grep, cat, cp, rm).',
    };
    return cached;
  }

  cached = {
    shellPath: undefined,
    isPosix: false,
    label:
      'Windows (cmd.exe — no POSIX shell was found, so Unix tools like head, tail, wc, find, grep, cat, ls, sed, awk ' +
      'are NOT available and will fail with "is not recognized"). Use native cmd commands (dir, type, copy, del, ' +
      'findstr) or PowerShell one-liners for anything more advanced, e.g.: ' +
      'count lines -> powershell -Command "(Get-Content file).Count"; ' +
      'list files by extension -> powershell -Command "Get-ChildItem -Recurse -Filter *.js | Select-Object -First 20 FullName"; ' +
      'search text in files -> powershell -Command "Select-String -Path *.js -Pattern \'text\'"; ' +
      'show first N lines -> powershell -Command "Get-Content file -TotalCount 20".',
  };
  return cached;
}

