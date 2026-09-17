import * as fs from 'fs';
import * as path from 'path';

export interface ShellInfo {
  /** Path to pass as child_process.exec's `shell` option; undefined = let Node use the OS default. */
  shellPath: string | undefined;
  /** Human-readable description of the shell/OS, embedded in the tool description and system prompt. */
  label: string;
  isPosix: boolean;
}

let cached: ShellInfo | undefined;

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
  }

  for (const candidate of candidates) {
    try {
      if (fs.existsSync(candidate)) return candidate;
    } catch {
      // ignore and try the next candidate
    }
  }
  return undefined;
}

/**
 * Figures out, once per session, what execute_command should actually run
 * through. On macOS/Linux this is trivial (the OS default shell already has
 * every standard Unix tool). On Windows, cmd.exe (Node's default there) has
 * none of them - so if Git Bash is installed (extremely common on Windows
 * dev machines, since Git itself is near-universal), we use it as the shell
 * instead. This makes head/tail/wc/find/grep/cat/ls/sed/awk etc. just work,
 * rather than relying on the model guessing the right OS-specific command
 * every time. Falls back to cmd.exe with much more specific guidance
 * (including concrete PowerShell one-liners) when Git Bash isn't found.
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

  const gitBash = findGitBash();
  if (gitBash) {
    cached = {
      shellPath: gitBash,
      isPosix: true,
      label:
        'Windows — execute_command runs through Git Bash, a real POSIX shell, so standard Unix tools ' +
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
      'Windows (cmd.exe — Git Bash was not found, so Unix tools like head, tail, wc, find, grep, cat, ls, sed, awk ' +
      'are NOT available and will fail with "is not recognized"). Use native cmd commands (dir, type, copy, del, ' +
      'findstr) or PowerShell one-liners for anything more advanced, e.g.: ' +
      'count lines -> powershell -Command "(Get-Content file).Count"; ' +
      'list files by extension -> powershell -Command "Get-ChildItem -Recurse -Filter *.js | Select-Object -First 20 FullName"; ' +
      'search text in files -> powershell -Command "Select-String -Path *.js -Pattern \'text\'"; ' +
      'show first N lines -> powershell -Command "Get-Content file -TotalCount 20".',
  };
  return cached;
}
