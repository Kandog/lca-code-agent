import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

const SKILL_EXTENSIONS = ['.md', '.txt'];

export function getSkillsDir(): string {
  return path.join(os.homedir(), '.lca', 'skills');
}

/**
 * Creates ~/.lca/skills the first time the extension runs, seeded with one
 * example skill so users can see the expected format immediately. Never
 * overwrites existing files.
 */
export function ensureSkillsDir(): string {
  const dir = getSkillsDir();
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  const examplePath = path.join(dir, 'code-review.md');
  if (!fs.existsSync(examplePath)) {
    fs.writeFileSync(
      examplePath,
      [
        '# Code Review',
        '',
        'Review the relevant files in this project for:',
        '- Bugs and edge cases',
        '- Readability and naming',
        '- Obvious performance issues',
        '- Missing error handling',
        '',
        'For each issue found, point to the file and explain the problem and a suggested fix.',
        'Do not rewrite whole files unless asked - focus on a concise, actionable review.',
        '',
      ].join('\n'),
      'utf8'
    );
  }

  return dir;
}

export interface SkillInfo {
  name: string;
  filePath: string;
}

/** Lists available skills, alphabetically. Supports two layouts:
 *  - flat file:       ~/.lca/skills/<name>.md (or .txt)
 *  - folder-style:     ~/.lca/skills/<name>/SKILL.md  (case-insensitive filename)
 * Folder-style is the common convention for richer, multi-file skills — the
 * skill's name is the folder name, and SKILL.md is the entry point read.
 */
export function listSkills(): SkillInfo[] {
  const dir = getSkillsDir();
  if (!fs.existsSync(dir)) return [];

  const skills: SkillInfo[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isFile()) {
      const ext = path.extname(entry.name).toLowerCase();
      if (!SKILL_EXTENSIONS.includes(ext)) continue;
      skills.push({ name: path.basename(entry.name, ext), filePath: path.join(dir, entry.name) });
      continue;
    }

    if (entry.isDirectory()) {
      const subDir = path.join(dir, entry.name);
      let skillFile: string | undefined;
      try {
        for (const f of fs.readdirSync(subDir)) {
          if (f.toLowerCase() === 'skill.md') {
            skillFile = path.join(subDir, f);
            break;
          }
        }
      } catch {
        continue; // unreadable subdirectory, skip it
      }
      if (skillFile) {
        skills.push({ name: entry.name, filePath: skillFile });
      }
    }
  }

  skills.sort((a, b) => a.name.localeCompare(b.name));
  return skills;
}

/** Reads a skill's raw content by name (case-insensitive), or null if not found. */
export function readSkill(name: string): string | null {
  const skills = listSkills();
  const match = skills.find((s) => s.name.toLowerCase() === name.toLowerCase());
  if (!match) return null;
  try {
    return fs.readFileSync(match.filePath, 'utf8');
  } catch {
    return null;
  }
}
