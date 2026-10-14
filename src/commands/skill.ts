import { mkdir, readFile, rm, rmdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import skillText from "../../skills/jetlog/SKILL.md";

export type SkillAgent = "claude" | "codex";

export interface SkillOptions {
  claude?: boolean;
  codex?: boolean;
  /** Install in the current project instead of the home folder. */
  project?: boolean;
  /** The project folder for --project. Defaults to the working directory. */
  cwd?: string;
}

/**
 * Where each agent looks for skills.
 * Claude Code: ~/.claude/skills/<name>/SKILL.md and <project>/.claude/skills/<name>/SKILL.md.
 * Codex: $HOME/.agents/skills and <repo>/.agents/skills (https://developers.openai.com/codex/skills).
 */
const SKILL_ROOTS: Record<SkillAgent, string> = { claude: ".claude/skills", codex: ".agents/skills" };

function home(): string {
  return process.env.HOME || homedir();
}

export function skillDirs(opts: SkillOptions): { agent: SkillAgent; dir: string }[] {
  const agents: SkillAgent[] = opts.claude || opts.codex ? [...(opts.claude ? (["claude"] as const) : []), ...(opts.codex ? (["codex"] as const) : [])] : ["claude", "codex"];
  const base = opts.project ? (opts.cwd ?? process.cwd()) : home();
  return agents.map((agent) => ({ agent, dir: join(base, SKILL_ROOTS[agent], "jetlog") }));
}

export async function skillInstall(opts: SkillOptions): Promise<void> {
  for (const { agent, dir } of skillDirs(opts)) {
    const file = join(dir, "SKILL.md");
    await mkdir(dir, { recursive: true });
    await writeFile(file, skillText);
    console.log(`${agent}: wrote ${file}`);
  }
}

export async function skillUninstall(opts: SkillOptions): Promise<void> {
  for (const { agent, dir } of skillDirs(opts)) {
    const file = join(dir, "SKILL.md");
    let existing: string;
    try {
      existing = await readFile(file, "utf8");
    } catch {
      console.log(`${agent}: no Jetlog skill at ${file}`);
      continue;
    }
    if (!/^name:\s*jetlog\s*$/m.test(existing)) {
      console.log(`${agent}: ${file} is not the Jetlog skill, left alone`);
      continue;
    }
    await rm(file);
    await rmdir(dir).catch(() => undefined); // only when empty
    console.log(`${agent}: removed ${file}`);
  }
}
