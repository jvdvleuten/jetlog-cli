// Bundles the CLI into dist/.
// All runtime dependencies are bundled, so the published package has none.
import { build } from "esbuild";
import { chmodSync, readFileSync, rmSync } from "node:fs";

const { version } = JSON.parse(readFileSync("package.json", "utf8"));

rmSync("dist", { recursive: true, force: true });

const common = {
  bundle: true,
  platform: "node",
  target: "node20",
  format: "esm",
  minify: true,
  legalComments: "none",
  // One source for the version: package.json. src/version.ts falls back to reading it when run from source.
  define: { __JETLOG_VERSION__: JSON.stringify(version) },
  loader: { ".md": "text" },
  // Bundled CommonJS dependencies call require() for node builtins.
  banner: { js: 'import { createRequire as __cr } from "node:module"; const require = __cr(import.meta.url);' }
};

await build({
  ...common,
  entryPoints: { cli: "src/cli.ts" },
  outdir: "dist",
  splitting: true,
  chunkNames: "chunks/[name]-[hash]"
});

// esbuild keeps the shebang from src/cli.ts on the first line.
chmodSync("dist/cli.js", 0o755);
