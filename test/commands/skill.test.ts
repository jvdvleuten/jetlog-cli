import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { skillInstall, skillUninstall } from "../../src/commands/skill.js";
import { agentGuide } from "../../src/commands/guide.js";

describe("skill install", () => {
  let home: string;
  let project: string;
  const originalHome = process.env.HOME;

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), "jetlog-cli-home-"));
    project = await mkdtemp(join(tmpdir(), "jetlog-cli-project-"));
    process.env.HOME = home;
    vi.spyOn(console, "log").mockImplementation(() => undefined);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
    await rm(home, { recursive: true, force: true });
    await rm(project, { recursive: true, force: true });
  });

  const exists = (p: string) => stat(p).then(() => true, () => false);

  it("installs for Claude Code and Codex in the home folder by default", async () => {
    await skillInstall({});
    const claude = await readFile(join(home, ".claude/skills/jetlog/SKILL.md"), "utf8");
    const codex = await readFile(join(home, ".agents/skills/jetlog/SKILL.md"), "utf8");
    expect(claude).toMatch(/^---\nname: jetlog\ndescription: .*pilot logbook/s);
    expect(codex).toBe(claude);
  });

  it("installs only the chosen agent", async () => {
    await skillInstall({ codex: true });
    expect(await exists(join(home, ".agents/skills/jetlog/SKILL.md"))).toBe(true);
    expect(await exists(join(home, ".claude"))).toBe(false);
  });

  it("installs in the project with --project", async () => {
    await skillInstall({ project: true, cwd: project });
    expect(await exists(join(project, ".claude/skills/jetlog/SKILL.md"))).toBe(true);
    expect(await exists(join(project, ".agents/skills/jetlog/SKILL.md"))).toBe(true);
    expect(await exists(join(home, ".claude"))).toBe(false);
  });

  it("overwrites an older Jetlog skill and is idempotent", async () => {
    const dir = join(home, ".claude/skills/jetlog");
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "SKILL.md"), "---\nname: jetlog\ndescription: old\n---\nold");
    await skillInstall({ claude: true });
    const first = await readFile(join(dir, "SKILL.md"), "utf8");
    expect(first).not.toContain("old\n---");
    await skillInstall({ claude: true });
    expect(await readFile(join(dir, "SKILL.md"), "utf8")).toBe(first);
  });

  it("uninstalls the Jetlog skill and leaves other files alone", async () => {
    await skillInstall({});
    await skillUninstall({ claude: true });
    expect(await exists(join(home, ".claude/skills/jetlog"))).toBe(false);
    expect(await exists(join(home, ".agents/skills/jetlog/SKILL.md"))).toBe(true);

    const other = join(home, ".agents/skills/jetlog/SKILL.md");
    await writeFile(other, "---\nname: something-else\n---\n");
    await skillUninstall({ codex: true });
    expect(await exists(other)).toBe(true);
  });
});

describe("guide", () => {
  it("covers the confirm-first rules and the undo location", () => {
    const guide = agentGuide();
    for (const needle of ["jetlog whoami", "--dry-run", "jetlog changes propose", "jetlog changes apply", "UTC", "Settings > Connected Apps & CLI > Logbook Changes"]) {
      expect(guide).toContain(needle);
    }
    expect(guide).not.toContain("—");
  });
});
