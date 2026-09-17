import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { ChatMessage } from './openaiClient';

export interface SessionMeta {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
}

export interface SessionData extends SessionMeta {
  history: ChatMessage[];
}

function getSessionsDir(): string {
  const dir = path.join(os.homedir(), '.lca', 'sessions');
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  return dir;
}

function sessionFilePath(id: string): string {
  return path.join(getSessionsDir(), `${id}.json`);
}

function generateId(): string {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

function deriveTitle(history: ChatMessage[]): string {
  const firstUser = history.find((m) => m.role === 'user' && typeof m.content === 'string' && m.content.trim());
  if (firstUser && typeof firstUser.content === 'string') {
    const t = firstUser.content.trim().replace(/\s+/g, ' ');
    return t.length > 60 ? t.slice(0, 57) + '...' : t;
  }
  return new Date().toLocaleString();
}

/**
 * Saves (creating or overwriting) a session. Pass an existing id to update
 * that session in place; omit it to create a new one. Returns the metadata
 * (including the id, which the caller should remember for future saves).
 */
export function saveSession(history: ChatMessage[], existingId?: string, title?: string): SessionMeta {
  const id = existingId || generateId();
  const filePath = sessionFilePath(id);

  let createdAt = Date.now();
  if (existingId && fs.existsSync(filePath)) {
    try {
      const prev = JSON.parse(fs.readFileSync(filePath, 'utf8'));
      if (typeof prev.createdAt === 'number') createdAt = prev.createdAt;
    } catch {
      // ignore, treat as new
    }
  }

  const data: SessionData = {
    id,
    title: title && title.trim() ? title.trim() : deriveTitle(history),
    createdAt,
    updatedAt: Date.now(),
    history,
  };

  fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf8');
  return { id: data.id, title: data.title, createdAt: data.createdAt, updatedAt: data.updatedAt };
}

export function listSessions(): SessionMeta[] {
  const dir = getSessionsDir();
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.json'));
  const sessions: SessionMeta[] = [];

  for (const f of files) {
    try {
      const raw = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
      sessions.push({ id: raw.id, title: raw.title, createdAt: raw.createdAt, updatedAt: raw.updatedAt });
    } catch {
      // skip corrupt files
    }
  }

  sessions.sort((a, b) => b.updatedAt - a.updatedAt);
  return sessions;
}

export function loadSession(id: string): SessionData | null {
  const filePath = sessionFilePath(id);
  if (!fs.existsSync(filePath)) return null;
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8')) as SessionData;
  } catch {
    return null;
  }
}

export function deleteSession(id: string): boolean {
  const filePath = sessionFilePath(id);
  if (fs.existsSync(filePath)) {
    fs.unlinkSync(filePath);
    return true;
  }
  return false;
}
