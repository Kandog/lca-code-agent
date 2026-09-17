import * as fs from 'fs/promises';
import * as path from 'path';
import { exec } from 'child_process';
import { resolveSafePathReal, getWorkspaceRoot, getWorkspaceRootReal } from './pathGuard';
import { detectShell } from './platform';

export interface ToolResult {
  ok: boolean;
  output: string;
}

const DEFAULT_IGNORE = new Set(['node_modules', '.git', 'out', 'dist', '.vscode-test', '.venv', '__pycache__']);
const MAX_FILE_BYTES = 2_000_000;
const MAX_LIST_DEPTH = 8;

export async function listFiles(relDir: string = '.', recursive = false): Promise<ToolResult> {
  try {
    const dir = await resolveSafePathReal(relDir);
    const root = await getWorkspaceRootReal();
    const results: string[] = [];

    async function walk(current: string, depth: number) {
      const entries = await fs.readdir(current, { withFileTypes: true });
      for (const entry of entries) {
        if (DEFAULT_IGNORE.has(entry.name)) continue;
        const full = path.join(current, entry.name);
        const rel = path.relative(root, full) || entry.name;
        results.push(entry.isDirectory() ? rel + '/' : rel);
        if (recursive && entry.isDirectory() && depth < MAX_LIST_DEPTH) {
          await walk(full, depth + 1);
        }
      }
    }

    await walk(dir, 0);
    return { ok: true, output: results.sort().join('\n') || '(empty directory)' };
  } catch (err: any) {
    return { ok: false, output: `Error: ${err.message}` };
  }
}

export async function readFile(relPath: string): Promise<ToolResult> {
  try {
    const filePath = await resolveSafePathReal(relPath);
    const stat = await fs.stat(filePath);
    if (stat.isDirectory()) {
      return { ok: false, output: `Error: "${relPath}" is a directory, not a file. Use list_files instead.` };
    }
    if (stat.size > MAX_FILE_BYTES) {
      return { ok: false, output: `Error: file too large (${stat.size} bytes). Limit is ${MAX_FILE_BYTES} bytes.` };
    }
    const content = await fs.readFile(filePath, 'utf8');
    return { ok: true, output: content };
  } catch (err: any) {
    return { ok: false, output: `Error: ${err.message}` };
  }
}

/** Reads a file's current content for diff-preview purposes; returns null if it doesn't exist or can't be read. */
export async function peekFile(relPath: string): Promise<string | null> {
  try {
    const filePath = await resolveSafePathReal(relPath);
    const stat = await fs.stat(filePath);
    if (stat.isDirectory() || stat.size > MAX_FILE_BYTES) return null;
    return await fs.readFile(filePath, 'utf8');
  } catch {
    return null;
  }
}

/** Normalizes CRLF to LF so search/replace isn't defeated by line-ending differences (common on Windows). */
function toLF(s: string): string {
  return s.replace(/\r\n/g, '\n');
}

/**
 * 1-for-1 character substitutions only (never expands/collapses length), so
 * the normalized string stays perfectly index-aligned with its input. Lets
 * us match through common "close but not byte-identical" text - smart
 * quotes, en/em dashes, non-breaking spaces - a frequent source of
 * otherwise-correct search text failing to match, especially when a model
 * retypes a snippet from memory instead of copying it byte-for-byte.
 */
const CHAR_NORMALIZE_MAP: Record<string, string> = {
  '\u2018': "'",
  '\u2019': "'",
  '\u201c': '"',
  '\u201d': '"',
  '\u2013': '-',
  '\u2014': '-',
  '\u00a0': ' ',
};

function normalizeChars(s: string): string {
  let out = '';
  for (const ch of s) out += CHAR_NORMALIZE_MAP[ch] ?? ch;
  return out;
}

/**
 * Finds where `needle` occurs in `haystack`, trying an exact match first and
 * only falling back to the character-normalized comparison if that fails.
 * Because normalizeChars() is strictly 1-for-1, the returned index is valid
 * against the ORIGINAL (non-normalized) haystack too.
 */
function findMatchIndex(haystack: string, needle: string): number {
  const exact = haystack.indexOf(needle);
  if (exact !== -1) return exact;
  return normalizeChars(haystack).indexOf(normalizeChars(needle));
}

const NOT_FOUND_HINT =
  'checked with normalized line endings and common smart-quote/dash/non-breaking-space variants too. ' +
  'Re-read the file and copy a shorter, more distinctive snippet exactly as it appears.';

export interface ReplacePreview {
  ok: boolean;
  original?: string;
  updated?: string;
  error?: string;
}

/** Computes what replace_in_file WOULD produce, without writing anything — used to render the diff for approval. */
export async function previewReplaceInFile(relPath: string, search: string, replace: string): Promise<ReplacePreview> {
  try {
    const filePath = await resolveSafePathReal(relPath);
    const raw = await fs.readFile(filePath, 'utf8');
    const usesCRLF = raw.includes('\r\n');
    const normalizedContent = toLF(raw);
    const normalizedSearch = toLF(search || '');

    if (!search) {
      return { ok: false, error: 'Exact "search" text not found (empty search string).' };
    }
    const idx = findMatchIndex(normalizedContent, normalizedSearch);
    if (idx === -1) {
      return { ok: false, error: `Exact "search" text not found in ${relPath} (${NOT_FOUND_HINT})` };
    }

    const normalizedUpdated =
      normalizedContent.slice(0, idx) + toLF(replace ?? '') + normalizedContent.slice(idx + normalizedSearch.length);
    const updated = usesCRLF ? normalizedUpdated.replace(/\n/g, '\r\n') : normalizedUpdated;
    return { ok: true, original: raw, updated };
  } catch (err: any) {
    return { ok: false, error: err.message };
  }
}

export async function writeFile(relPath: string, content: string): Promise<ToolResult> {
  try {
    const filePath = await resolveSafePathReal(relPath);
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, content ?? '', 'utf8');
    return { ok: true, output: `Wrote ${(content ?? '').length} characters to ${relPath}` };
  } catch (err: any) {
    return { ok: false, output: `Error: ${err.message}` };
  }
}

/**
 * Replaces an exact block of text in a file. Line endings are normalized to
 * LF before comparing (and the result is converted back to the file's
 * original convention before writing), so a search string copied with LF
 * still matches a CRLF file and vice versa — the single most common reason
 * an otherwise-correct "search" fails to match.
 */
export async function replaceInFile(relPath: string, search: string, replace: string): Promise<ToolResult> {
  try {
    if (!search) {
      return { ok: false, output: 'Error: "search" text must not be empty.' };
    }
    const filePath = await resolveSafePathReal(relPath);
    const raw = await fs.readFile(filePath, 'utf8');
    const usesCRLF = raw.includes('\r\n');
    const normalizedContent = toLF(raw);
    const normalizedSearch = toLF(search);

    const idx = findMatchIndex(normalizedContent, normalizedSearch);
    if (idx === -1) {
      return { ok: false, output: `Error: the exact "search" text was not found in ${relPath} (${NOT_FOUND_HINT})` };
    }

    const normalizedUpdated =
      normalizedContent.slice(0, idx) + toLF(replace ?? '') + normalizedContent.slice(idx + normalizedSearch.length);
    const updated = usesCRLF ? normalizedUpdated.replace(/\n/g, '\r\n') : normalizedUpdated;
    await fs.writeFile(filePath, updated, 'utf8');
    return { ok: true, output: `Replaced text in ${relPath}` };
  } catch (err: any) {
    return { ok: false, output: `Error: ${err.message}` };
  }
}

export async function deleteFile(relPath: string): Promise<ToolResult> {
  try {
    const filePath = await resolveSafePathReal(relPath);
    const root = await getWorkspaceRootReal();
    if (path.normalize(filePath) === root) {
      return { ok: false, output: 'Error: refusing to delete the project root itself.' };
    }
    const stat = await fs.stat(filePath);
    if (stat.isDirectory()) {
      await fs.rm(filePath, { recursive: true, force: true });
    } else {
      await fs.unlink(filePath);
    }
    return { ok: true, output: `Deleted ${relPath}` };
  } catch (err: any) {
    return { ok: false, output: `Error: ${err.message}` };
  }
}

/**
 * Runs a shell command with cwd pinned to the project root. This does not
 * itself grant network access from the extension, but a command like `curl`
 * or `npm install` invoked here can still reach the network the same way it
 * would from any terminal on this machine — that's outside what path
 * sandboxing can constrain. Off by default confirmation (autoApprove=false)
 * exists specifically so the user sees and approves each command.
 */
export function executeCommand(command: string, timeoutMs = 30000): Promise<ToolResult> {
  const root = getWorkspaceRoot();
  const { shellPath } = detectShell();
  return new Promise((resolve) => {
    exec(command, { cwd: root, timeout: timeoutMs, maxBuffer: 5 * 1024 * 1024, shell: shellPath }, (error, stdout, stderr) => {
      if (error) {
        resolve({ ok: false, output: `${stdout}\n${stderr}\nError: ${error.message}`.trim() });
      } else {
        resolve({ ok: true, output: (stdout + '\n' + stderr).trim() || '(no output)' });
      }
    });
  });
}
