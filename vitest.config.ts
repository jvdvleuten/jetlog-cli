import { readFileSync } from "node:fs";
import { defineConfig } from "vitest/config";

export default defineConfig({
  // Mirrors the esbuild text loader in scripts/build.mjs.
  plugins: [
    {
      name: "markdown-as-text",
      enforce: "pre",
      load(id) {
        if (id.endsWith(".md")) return `export default ${JSON.stringify(readFileSync(id, "utf8"))};`;
        return undefined;
      }
    }
  ],
  test: {
    environment: "node",
    include: ["test/**/*.test.ts"]
  }
});
