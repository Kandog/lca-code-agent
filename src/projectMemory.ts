import * as fs from 'fs';
import * as path from 'path';

const AGENTS_FILENAME = 'AGENTS.md';
const MAX_BYTES = 20000;

export interface ProjectMemory {
  fileName: string;
  content: string;
}

/**
 * Reads AGENTS.md from the project root, if present. This is deliberately a
 * project-root file (not under ~/.lca) so it travels with the repo and can
 * be committed, shared, and edited by anyone on the project — the same idea
 * as CLAUDE.md/AGENTS.md conventions used by other coding agents. Read fresh
 * at the start of every new chat, so edits take effect on the next session
 * without reloading the extension.
 */
export function readProjectMemory(root: string): ProjectMemory | null {
  const filePath = path.join(root, AGENTS_FILENAME);
  try {
    const stat = fs.statSync(filePath);
    if (!stat.isFile()) return null;
    let content = fs.readFileSync(filePath, 'utf8');
    if (content.length > MAX_BYTES) {
      content = content.slice(0, MAX_BYTES) + '\n...(truncated)';
    }
    return { fileName: AGENTS_FILENAME, content };
  } catch {
    return null;
  }
}

const TEMPLATE = `# AGENTS.md

Project-wide instructions for AI coding agents working in this repository.
This file is read automatically at the start of every new chat.

## Project overview
<!-- What this project does, key technologies, architecture notes -->

## Conventions
<!-- Coding style, naming conventions, folder/module structure rules -->

## Build & test
<!-- Commands to build, run, and test this project, so the agent can validate its own changes -->

## Notes for the agent
<!-- Anything else the agent should always keep in mind for this project -->
`;

/** Creates AGENTS.md with a starter template if it doesn't already exist. Returns its path either way. */
export function ensureProjectMemoryTemplate(root: string): string {
  const filePath = path.join(root, AGENTS_FILENAME);
  if (!fs.existsSync(filePath)) {
    fs.writeFileSync(filePath, TEMPLATE, 'utf8');
  }
  return filePath;
}
