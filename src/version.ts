import { readFileSync } from "node:fs";

/** Replaced by `scripts/build.mjs` with the version from package.json. */
declare const __JETLOG_VERSION__: string | undefined;

function readPackageVersion(): string {
  const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version: string };
  return pkg.version;
}

export const VERSION: string = typeof __JETLOG_VERSION__ === "string" ? __JETLOG_VERSION__ : readPackageVersion();
