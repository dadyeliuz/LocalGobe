import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { getProjectRoot } from "../src/storage/paths.ts";

export async function buildDesktop(): Promise<void> {
  const root = getProjectRoot();
  const entry = join(root, "src", "desktop", "main.ts");
  const outDir = join(root, "dist-desktop");
  const outFile = join(outDir, "main.mjs");

  mkdirSync(outDir, { recursive: true });

  console.log(`Bundling desktop main process from ${entry} to ${outFile}...`);

  const esbuild = await import("esbuild");
  await esbuild.build({
    entryPoints: [entry],
    bundle: true,
    platform: "node",
    target: "node24",
    format: "esm",
    banner: {
      js: "import { createRequire as __createRequire } from 'node:module'; const require = __createRequire(import.meta.url);",
    },
    external: ["electron"],
    outfile: outFile,
  });

  console.log(`Desktop main process bundle created: ${outFile}`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  void buildDesktop().catch((err) => {
    console.error("Desktop build failed:", err);
    process.exit(1);
  });
}
