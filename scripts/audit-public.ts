import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export type AuditFinding = {
  severity: "error" | "warning";
  file: string;
  rule: string;
  detail: string;
};

const FORBIDDEN_EXTENSIONS = new Set([
  ".apk",
  ".ipa",
  ".swf",
  ".flv",
  ".fla",
  ".sol",
  ".mp3",
  ".ane",
  ".wasm",
  ".ttf",
  ".otf",
]);

const FORBIDDEN_BASENAMES = new Set([
  "localgobe-accounts.json",
  "leaderboards.json",
  "mogobetabil.swf",
  "logingr.swf",
  "serverslistgr.swf",
  "registgr.swf",
  "controlpanel.swf",
  "avatarsgr.swf",
  "room_20.swf",
  "room_20.txt",
]);

const IGNORED_DIRS = new Set(["node_modules", "dist", "dist-desktop", "release", "data", ".git", ".vite"]);

const SUSPICIOUS_CONTENT_PATTERNS: ReadonlyArray<{ name: string; regex: RegExp }> = [
  { name: "absolute-windows-user-path", regex: /[A-Za-z]:[/\\]{1,2}Users[/\\]{1,2}[^\\/\s"'`]+/i },
  { name: "research-repo-root-path", regex: /C:[/\\]{1,2}Projects[/\\]{1,2}localgobe/i },
  { name: "research-temp-harness-ref", regex: /Temp[/\\]{1,2}harness/i },
  { name: "research-archive-corpus-ref", regex: /archive-corpus/i },
  { name: "research-decompiled-temp-ref", regex: /decompiled-temp/i },
  { name: "research-reference-builds-ref", regex: /reference-builds/i },
  { name: "research-registration-builds-ref", regex: /registration-builds/i },
  { name: "hardcoded-test-password", regex: /password123/i },
  { name: "mutable-toolchain-url", regex: /raw\.githubusercontent\.com\/[^/]+\/[^/]+\/toolchain-assets\//i },
  { name: "copied-mogobe-store-language", regex: /חלה שגיאה ברכישת|אין לכם מספיק מטבעות לרכוש/ },
];

const TEXT_EXTENSIONS = new Set([".ts", ".js", ".mjs", ".json", ".html", ".css", ".md", ".as", ".yml", ".yaml", ".patch", ".rs", ".txt", ".xml"]);

export function auditPublicTree(rootDir: string): AuditFinding[] {
  const findings: AuditFinding[] = [];
  const absRoot = resolve(rootDir);

  function walk(dir: string): void {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        if (IGNORED_DIRS.has(entry.name)) continue;
        walk(join(dir, entry.name));
        continue;
      }
      if (!entry.isFile()) continue;

      const fullPath = join(dir, entry.name);
      const relPath = relative(absRoot, fullPath).replace(/\\/g, "/");
      const lowerName = entry.name.toLowerCase();
      const dotIdx = lowerName.lastIndexOf(".");
      const ext = dotIdx >= 0 ? lowerName.slice(dotIdx) : "";

      if (FORBIDDEN_EXTENSIONS.has(ext)) {
        findings.push({
          severity: "error",
          file: relPath,
          rule: "forbidden-binary-extension",
          detail: `Forbidden binary/game asset extension (${ext}) in public source tree`,
        });
      }

      if (FORBIDDEN_BASENAMES.has(lowerName) || /^room_\d+\.(swf|txt)$/i.test(lowerName)) {
        findings.push({
          severity: "error",
          file: relPath,
          rule: "forbidden-game-or-runtime-file",
          detail: `Forbidden game asset or runtime account file (${entry.name})`,
        });
      }

      // Skip self-check on the audit script and its own test file
      if (relPath === "scripts/audit-public.ts" || relPath === "tests/public-audit.test.ts") {
        continue;
      }

      if (TEXT_EXTENSIONS.has(ext) && statSync(fullPath).size < 2 * 1024 * 1024) {
        const text = readFileSync(fullPath, "utf8");
        for (const pat of SUSPICIOUS_CONTENT_PATTERNS) {
          if (pat.regex.test(text)) {
            findings.push({
              severity: "error",
              file: relPath,
              rule: pat.name,
              detail: `Matched forbidden pattern "${pat.name}"`,
            });
          }
        }

        if (relPath.startsWith("src/")) {
          if (/TEST_FIXTURE|SPRING_2013_STORE_|createSpring2013TestInventory/.test(text)) {
            findings.push({
              severity: "error",
              file: relPath,
              rule: "production-test-fixture-leak",
              detail: `Found test fixture concept in production source file (${relPath})`,
            });
          }
          if (/\bhebrewName\b|RoomsNames/i.test(text)) {
            findings.push({
              severity: "error",
              file: relPath,
              rule: "room-navigation-research-annotation",
              detail: `Found research-only language/metadata annotation in production source (${relPath})`,
            });
          }
        }
      }
    }
  }

  if (existsSync(absRoot)) {
    walk(absRoot);
  }
  return findings;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const projectRoot = resolve(fileURLToPath(new URL("../", import.meta.url)));
  const findings = auditPublicTree(projectRoot);
  if (findings.length === 0) {
    console.log("PASS: Public tree audit found 0 copyrighted assets, 0 personal runtime data files, and 0 research path leaks.");
    process.exit(0);
  } else {
    console.error(`FAIL: Public tree audit found ${findings.length} issue(s):`);
    for (const f of findings) {
      console.error(`  [${f.severity.toUpperCase()}] ${f.file} (${f.rule}): ${f.detail}`);
    }
    process.exit(1);
  }
}
