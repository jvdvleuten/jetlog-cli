import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  configDir,
  credentialsPath,
  deleteProfile,
  getProfile,
  listProfiles,
  resolveBaseUrl,
  resolveToken,
  saveProfile
} from "../../src/auth/credentials.js";

describe("credentials", () => {
  let dir: string;
  const originalXdg = process.env.XDG_CONFIG_HOME;
  const originalToken = process.env.JETLOG_TOKEN;
  const originalBaseUrl = process.env.JETLOG_BASE_URL;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "jetlog-cli-test-"));
    process.env.XDG_CONFIG_HOME = dir;
    delete process.env.JETLOG_TOKEN;
    delete process.env.JETLOG_BASE_URL;
  });

  afterEach(async () => {
    if (originalXdg === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = originalXdg;
    if (originalToken === undefined) delete process.env.JETLOG_TOKEN;
    else process.env.JETLOG_TOKEN = originalToken;
    if (originalBaseUrl === undefined) delete process.env.JETLOG_BASE_URL;
    else process.env.JETLOG_BASE_URL = originalBaseUrl;
    await rm(dir, { recursive: true, force: true });
  });

  it("respects XDG_CONFIG_HOME", () => {
    expect(configDir()).toBe(join(dir, "jetlog"));
  });

  it("returns undefined for a profile that was never saved", async () => {
    expect(await getProfile("default")).toBeUndefined();
    expect(await resolveToken("default")).toBeUndefined();
  });

  it("saves a profile with restrictive file and directory permissions", async () => {
    await saveProfile("default", { token: "jlp_abc", scope: "read" });

    const fileStat = await stat(credentialsPath());
    const dirStat = await stat(configDir());
    // Mask to the permission bits; only check owner-only (no group/other bits).
    expect(fileStat.mode & 0o777).toBe(0o600);
    expect(dirStat.mode & 0o777).toBe(0o700);
  });

  it("round-trips a saved profile", async () => {
    await saveProfile("default", { token: "jlp_abc", scope: "read", email: "a@example.com" });
    const profile = await getProfile("default");
    expect(profile).toMatchObject({ token: "jlp_abc", scope: "read", email: "a@example.com" });
  });

  it("supports multiple named profiles independently", async () => {
    await saveProfile("work", { token: "jlp_work" });
    await saveProfile("personal", { token: "jlp_personal" });

    expect(await resolveToken("work")).toBe("jlp_work");
    expect(await resolveToken("personal")).toBe("jlp_personal");
    expect((await listProfiles()).sort()).toEqual(["personal", "work"]);
  });

  it("JETLOG_TOKEN overrides the stored token for any profile", async () => {
    await saveProfile("default", { token: "jlp_stored" });
    process.env.JETLOG_TOKEN = "jlp_env_override";
    expect(await resolveToken("default")).toBe("jlp_env_override");
  });

  it("JETLOG_BASE_URL overrides the stored base url", async () => {
    await saveProfile("default", { token: "jlp_abc", baseUrl: "https://stored.example" });
    process.env.JETLOG_BASE_URL = "http://localhost:4000";
    expect(await resolveBaseUrl("default")).toBe("http://localhost:4000");
  });

  it("deleteProfile removes only the named profile", async () => {
    await saveProfile("default", { token: "jlp_default" });
    await saveProfile("other", { token: "jlp_other" });

    expect(await deleteProfile("default")).toBe(true);
    expect(await getProfile("default")).toBeUndefined();
    expect(await getProfile("other")).toBeDefined();
    expect(await deleteProfile("default")).toBe(false);
  });
});
