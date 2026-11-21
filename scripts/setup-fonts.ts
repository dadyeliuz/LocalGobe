import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { getRuntimeFontsDir } from "../src/storage/paths.ts";

const ARIMO_TTF_URL = "https://raw.githubusercontent.com/googlefonts/arimo/main/fonts/ttf/Arimo-Regular.ttf";
const ARIMO_OFL_URL = "https://raw.githubusercontent.com/googlefonts/arimo/main/OFL.txt";

export async function setupFonts(targetDir?: string): Promise<{ ttfPath: string; oflPath: string }> {
  const fontsDir = targetDir ? resolve(targetDir) : getRuntimeFontsDir();
  mkdirSync(fontsDir, { recursive: true });

  const ttfPath = join(fontsDir, "arimo.ttf");
  const oflPath = join(fontsDir, "OFL.txt");

  if (!existsSync(ttfPath)) {
    console.log(`Downloading open-source Hebrew/Latin font Arimo from ${ARIMO_TTF_URL}...`);
    const res = await fetch(ARIMO_TTF_URL);
    if (!res.ok) throw new Error(`Failed to download Arimo font: ${res.status} ${res.statusText}`);
    const buf = Buffer.from(await res.arrayBuffer());
    writeFileSync(ttfPath, buf);
    console.log(`Saved ${ttfPath} (${buf.length} bytes)`);
  } else {
    console.log(`Arimo font already present at ${ttfPath}`);
  }

  if (!existsSync(oflPath)) {
    console.log(`Downloading Arimo SIL Open Font License from ${ARIMO_OFL_URL}...`);
    const res = await fetch(ARIMO_OFL_URL);
    if (!res.ok) throw new Error(`Failed to download Arimo OFL: ${res.status} ${res.statusText}`);
    const text = await res.text();
    writeFileSync(oflPath, text, "utf8");
    console.log(`Saved ${oflPath}`);
  }

  return { ttfPath, oflPath };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  void setupFonts().catch((err) => {
    console.error("Font setup failed:", err);
    process.exit(1);
  });
}
