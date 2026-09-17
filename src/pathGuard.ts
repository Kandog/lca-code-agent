import * as path from 'path';
import * as fsp from 'fs/promises';
import * as vscode from 'vscode';

export class PathGuardError extends Error {}

/**
 * Returns the absolute path of the first (only supported) workspace folder.
 * This is treated as the sandbox root for every file operation the agent performs.
 */
export function getWorkspaceRoot(): string {
  const folders = vscode.workspace.workspaceFolders;
  if (!folders || folders.length === 0) {
    throw new PathGuardError(
      'No project folder is open in VS Code. Open a folder (File > Open Folder...) before using OpenAI Agent.'
    );
  }
  return path.normalize(folders[0].uri.fsPath);
}

function isContained(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  if (relative === '') return true; // candidate === root
  return !(relative.startsWith('..' + path.sep) || relative === '..' || path.isAbsolute(relative));
}

/**
 * Resolves a path supplied by the model (or user) against the workspace root
 * and guarantees the result cannot escape that root, whether the input was
 * relative, absolute, or contained ".." traversal segments.
 *
 * This is a purely string-based check — it does NOT protect against a
 * symlink inside the project pointing outside of it (see
 * resolveSafePathReal for that). Use this only where a symlink escape isn't
 * a concern (e.g. as the fast structural pre-check inside
 * resolveSafePathReal itself); every actual file read/write/delete should
 * go through resolveSafePathReal instead.
 *
 * Throws PathGuardError if the resolved path would land outside the root.
 */
export function resolveSafePath(inputPath: string): string {
  if (typeof inputPath !== 'string' || inputPath.length === 0) {
    throw new PathGuardError('A file path is required.');
  }

  const root = getWorkspaceRoot();

  // Treat every incoming path as relative to root unless it's already
  // absolute; either way we normalize and then verify containment.
  const candidate = path.isAbsolute(inputPath)
    ? path.normalize(inputPath)
    : path.normalize(path.join(root, inputPath));

  if (!isContained(root, candidate)) {
    throw new PathGuardError(
      `Access denied: "${inputPath}" resolves outside the project root (${root}). ` +
        'This extension can only read, write, or delete files inside the current project folder.'
    );
  }

  return candidate;
}

/** Same as getWorkspaceRoot(), but resolved through any symlinks. Useful for computing
 * display-relative paths consistently once resolveSafePathReal has already resolved a
 * starting directory through symlinks too. */
export async function getWorkspaceRootReal(): Promise<string> {
  const root = getWorkspaceRoot();
  try {
    return await fsp.realpath(root);
  } catch {
    return root;
  }
}

/**
 * Like resolveSafePath, but also resolves symlinks and re-checks containment
 * against the REAL (symlink-resolved) path, both for the target itself and
 * for the workspace root. Without this, a symlink inside the project that
 * points elsewhere on disk (e.g. `project/escape -> C:\Windows\System32` or
 * `project/escape -> /etc`) would pass the plain string check — the path
 * "looks" like it's inside the project — while the actual filesystem
 * operation follows the link and reads/writes/deletes outside the sandbox
 * entirely. This is the check every real file I/O operation should use.
 *
 * Handles paths that don't exist yet (e.g. a new file about to be created
 * by write_file) by walking up to the nearest existing ancestor, resolving
 * THAT, and re-appending the not-yet-existing remainder.
 */
export async function resolveSafePathReal(inputPath: string): Promise<string> {
  const candidate = resolveSafePath(inputPath);
  const root = getWorkspaceRoot();

  let realRoot: string;
  try {
    realRoot = await fsp.realpath(root);
  } catch (err: any) {
    throw new PathGuardError(`Could not resolve the project root (${root}): ${err.message}`);
  }

  let current = candidate;
  let remainder = '';

  for (let i = 0; i < 64; i++) {
    try {
      const real = await fsp.realpath(current);
      const finalReal = remainder ? path.join(real, remainder) : real;
      if (!isContained(realRoot, finalReal)) {
        throw new PathGuardError(
          `Access denied: "${inputPath}" resolves through a symlink to outside the project root (${root}). ` +
            'This extension can only read, write, or delete files inside the current project folder.'
        );
      }
      return finalReal;
    } catch (err: any) {
      if (err instanceof PathGuardError) throw err;
      if (err.code === 'ENOENT') {
        const parent = path.dirname(current);
        if (parent === current) {
          // Walked all the way up without finding an existing ancestor
          // (shouldn't normally happen since the root itself exists) -
          // fall back to the plain structural candidate.
          return candidate;
        }
        remainder = remainder ? path.join(path.basename(current), remainder) : path.basename(current);
        current = parent;
        continue;
      }
      throw err;
    }
  }

  // Pathological symlink chain depth - fail closed rather than loop forever.
  throw new PathGuardError(`Access denied: "${inputPath}" could not be safely resolved (too many path segments).`);
}
