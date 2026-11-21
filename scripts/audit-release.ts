import { createHash } from "node:crypto";
import { closeSync, existsSync, openSync, readdirSync, readFileSync, readSync, statSync } from "node:fs";
import { basename, extname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { getProjectRoot } from "../src/storage/paths.ts";

export type ReleaseAuditResult = {
  packagedMogobeOriginalFiles: number;
  packagedRuntimeUserDataFiles: number;
  packagedSecrets: number;
  packagedResearchPathLeaks: number;
  violations: Array<{ rule: string; path: string; detail: string }>;
  verifiedLicenses: string[];
};

const ALLOWED_SWF_NAMES = new Set([
  "airbootstrap.swf",
  "stage_text_shim.swf",
  "stage_text_init_options_shim.swf",
  "air_network_info_shim.swf",
]);

const FORBIDDEN_EXTENSIONS = new Set([
  ".apk",
  ".ipa",
  ".flv",
  ".fla",
  ".sol",
  ".mp3",
  ".ane",
]);

const FORBIDDEN_GAME_BASENAMES = new Set([
  "mogobetabil.swf",
  "logingr.swf",
  "serverslistgr.swf",
  "registgr.swf",
  "controlpanel.swf",
  "controlpanelpetsm.swf",
  "avatarsgr.swf",
  "brandawardgr.swf",
  "popups.swf",
  "mogowall.swf",
  "friendcard.swf",
  "mogowall.txt",
  "lang.aspx",
]);

const FORBIDDEN_USER_DATA_BASENAMES = new Set([
  "localgobe-accounts.json",
  "leaderboards.json",
]);

const SECRET_PATTERNS: ReadonlyArray<{ name: string; regex: RegExp }> = [
  { name: "private-key-header", regex: /-----BEGIN [A-Z ]*PRIVATE KEY-----/ },
  { name: "generic-secret-token", regex: /(api[_-]?key|secret[_-]?token|auth[_-]?token)["']?\s*[:=]\s*["'][A-Za-z0-9_\-]{24,}["']/i },
];

const RESEARCH_PATH_PATTERNS: ReadonlyArray<{ name: string; regex: RegExp }> = [
  { name: "legacy-repo-root", regex: new RegExp(["C:", "Projects", "localgobe"].join("[/\\\\]{1,2}"), "i") },
  { name: "legacy-corpus-dir", regex: new RegExp(["arch" + "ive", "cor" + "pus"].join("-"), "i") },
  { name: "legacy-decompiled-dir", regex: new RegExp(["decomp" + "iled", "te" + "mp"].join("-"), "i") },
  { name: "legacy-reference-dir", regex: new RegExp(["refer" + "ence", "bui" + "lds"].join("-"), "i") },
  { name: "legacy-registration-dir", regex: new RegExp(["regist" + "ration", "bui" + "lds"].join("-"), "i") },
  { name: "legacy-harness-dir", regex: new RegExp(["Te" + "mp", "har" + "ness"].join("[/\\\\]{1,2}"), "i") },
];

const TEXT_EXTS = new Set([".js", ".mjs", ".cjs", ".html", ".css", ".json", ".txt", ".xml", ".yml", ".yaml"]);

function readAsarFileList(asarPath: string): string[] {
  const fd = openSync(asarPath, "r");
  try {
    const headerBuf = Buffer.alloc(16);
    readSync(fd, headerBuf, 0, 16, 0);
    const jsonSize = headerBuf.readUInt32LE(12);
    const jsonBuf = Buffer.alloc(jsonSize);
    readSync(fd, jsonBuf, 0, jsonSize, 16);
    const tree = JSON.parse(jsonBuf.toString("utf8")) as { files?: Record<string, { files?: Record<string, unknown> }> };
    const files: string[] = [];

    function traverse(node: { files?: Record<string, unknown> }, prefix: string): void {
      if (!node || !node.files) return;
      for (const [name, entry] of Object.entries(node.files)) {
        const full = prefix ? `${prefix}/${name}` : name;
        const entryObj = entry as { files?: Record<string, unknown> };
        if (entryObj && entryObj.files) {
          traverse(entryObj, full);
        } else {
          files.push(full);
        }
      }
    }

    traverse(tree, "");
    return files;
  } finally {
    closeSync(fd);
  }
}

const IGNORED_BUILDER_FILES = new Set([
  "builder-debug.yml",
  "builder-effective-config.yaml",
]);

export function auditPackagedRelease(releaseDir: string): ReleaseAuditResult {
  const result: ReleaseAuditResult = {
    packagedMogobeOriginalFiles: 0,
    packagedRuntimeUserDataFiles: 0,
    packagedSecrets: 0,
    packagedResearchPathLeaks: 0,
    violations: [],
    verifiedLicenses: [],
  };

  const absRelease = resolve(releaseDir);
  if (!existsSync(absRelease)) {
    throw new Error(`Release directory does not exist: ${absRelease}`);
  }

  function checkFile(relPath: string, fullPath: string): void {
    const lowerName = basename(relPath).toLowerCase();
    if (IGNORED_BUILDER_FILES.has(lowerName)) return;
    const ext = extname(lowerName);

    // 1. Forbidden game asset extensions
    if (FORBIDDEN_EXTENSIONS.has(ext)) {
      result.packagedMogobeOriginalFiles++;
      result.violations.push({
        rule: "forbidden-game-extension",
        path: relPath,
        detail: `Found forbidden binary asset extension (${ext})`,
      });
    }

    // 2. SWF check: only allow verified LocalGobe-owned AIR shims
    if (ext === ".swf") {
      if (!ALLOWED_SWF_NAMES.has(lowerName)) {
        result.packagedMogobeOriginalFiles++;
        result.violations.push({
          rule: "unauthorized-swf",
          path: relPath,
          detail: `Found unauthorized SWF binary (${lowerName}); only LocalGobe clean-room AIR shims are permitted`,
        });
      }
    }

    // 3. Mogobe historical basenames or room patterns
    if (FORBIDDEN_GAME_BASENAMES.has(lowerName) || /^room_\d+\.(swf|txt)$/i.test(lowerName) || /^popup_\d+\.swf$/i.test(lowerName)) {
      result.packagedMogobeOriginalFiles++;
      result.violations.push({
        rule: "forbidden-game-basename",
        path: relPath,
        detail: `Found forbidden Mogobe game basename (${lowerName})`,
      });
    }

    // 4. User data files
    if (FORBIDDEN_USER_DATA_BASENAMES.has(lowerName) || ext === ".ndjson" || relPath.includes("/data/builds/")) {
      result.packagedRuntimeUserDataFiles++;
      result.violations.push({
        rule: "forbidden-user-data-file",
        path: relPath,
        detail: `Found user runtime data file (${lowerName})`,
      });
    }

    // 5. Secrets check
    if (/^\.env/i.test(lowerName) || ext === ".pem" || ext === ".key" || ext === ".pfx" || ext === ".p12") {
      result.packagedSecrets++;
      result.violations.push({
        rule: "forbidden-secret-file",
        path: relPath,
        detail: `Found secret/key file (${lowerName})`,
      });
    }

    // 6. Text content scan
    if (existsSync(fullPath) && TEXT_EXTS.has(ext)) {
      try {
        const stats = statSync(fullPath);
        if (stats.size < 5 * 1024 * 1024) {
          const content = readFileSync(fullPath, "utf8");
          for (const sp of SECRET_PATTERNS) {
            if (sp.regex.test(content)) {
              result.packagedSecrets++;
              result.violations.push({
                rule: sp.name,
                path: relPath,
                detail: `Matched secret pattern ${sp.name}`,
              });
            }
          }
          for (const rp of RESEARCH_PATH_PATTERNS) {
            if (rp.regex.test(content)) {
              result.packagedResearchPathLeaks++;
              result.violations.push({
                rule: rp.name,
                path: relPath,
                detail: `Matched research path leak pattern ${rp.name}`,
              });
            }
          }
        }
      } catch {
        // skip unreadable
      }
    }
  }

  function walkDir(dir: string, base: string): void {
    for (const ent of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, ent.name);
      const rel = relative(base, full).replace(/\\/g, "/");

      if (ent.isDirectory()) {
        walkDir(full, base);
      } else if (ent.isFile()) {
        checkFile(rel, full);
      }
    }
  }

  walkDir(absRelease, absRelease);

  // Check inside app.asar if present
  const asarCandidates = [
    join(absRelease, "win-unpacked", "resources", "app.asar"),
    join(absRelease, "win-arm64-unpacked", "resources", "app.asar"),
  ];

  for (const asarPath of asarCandidates) {
    if (existsSync(asarPath)) {
      try {
        const asarFiles = readAsarFileList(asarPath);
        for (const entryPath of asarFiles) {
          checkFile(`asar:${entryPath}`, "");
        }
      } catch (err) {
        console.warn(`Could not inspect ${asarPath}:`, err);
      }
    }
  }

  // Verify bundled licenses in resources and unpacked root
  const unpackedRootDirs = [
    join(absRelease, "win-unpacked"),
    join(absRelease, "win-arm64-unpacked"),
  ];

  for (const rootDir of unpackedRootDirs) {
    if (existsSync(rootDir)) {
      const resDir = join(rootDir, "resources");
      const requiredLicenses = [
        "LICENSE",
        "THIRD_PARTY_NOTICES.md",
        "LICENSE_MIT_RUFFLE",
        "LICENSE_APACHE_RUFFLE",
        join("runtime", "fonts", "OFL.txt"),
      ];
      for (const reqLic of requiredLicenses) {
        const fullLic = join(resDir, reqLic);
        if (existsSync(fullLic)) {
          result.verifiedLicenses.push(reqLic);
        } else {
          result.violations.push({
            rule: "missing-required-license",
            path: join(relative(absRelease, resDir), reqLic),
            detail: `Missing required license notice: ${reqLic}`,
          });
        }
      }

      const rootLicenses = [
        "LICENSE.electron.txt",
        "LICENSES.chromium.html",
      ];
      for (const rootLic of rootLicenses) {
        const fullRootLic = join(rootDir, rootLic);
        if (existsSync(fullRootLic)) {
          result.verifiedLicenses.push(rootLic);
        } else {
          result.violations.push({
            rule: "missing-runtime-license",
            path: join(relative(absRelease, rootDir), rootLic),
            detail: `Missing runtime license notice: ${rootLic}`,
          });
        }
      }
    }
  }

  auditOtaMetadata(absRelease, result);

  return result;
}

function auditOtaMetadata(releaseDir: string, result: ReleaseAuditResult): void {
  const root = getProjectRoot();
  const pkgJsonPath = join(root, "package.json");
  const pkg = JSON.parse(readFileSync(pkgJsonPath, "utf8")) as {
    version?: string;
    build?: {
      publish?: {
        provider?: string;
        owner?: string;
        repo?: string;
      };
    };
  };

  const publish = pkg.build?.publish;
  if (!publish || publish.provider !== "github" || publish.owner !== "dadyeliuz" || publish.repo !== "LocalGobe") {
    result.violations.push({
      rule: "invalid-update-provider",
      path: "package.json",
      detail: `Expected build.publish to be configured as github: dadyeliuz/LocalGobe, got ${JSON.stringify(publish)}`,
    });
  }

  const latestYmlPath = join(releaseDir, "latest.yml");
  if (!existsSync(latestYmlPath)) {
    if (process.env.REQUIRE_OTA_METADATA === "true") {
      result.violations.push({
        rule: "missing-latest-yml",
        path: "release/latest.yml",
        detail: "latest.yml update metadata is missing in release directory",
      });
    }
    return;
  }

  const ymlContent = readFileSync(latestYmlPath, "utf8");

  // Check no tokens embedded in metadata
  if (/ghp_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,}|token:\s*["'][A-Za-z0-9_]{16,}["']/i.test(ymlContent)) {
    result.packagedSecrets++;
    result.violations.push({
      rule: "embedded-token-in-metadata",
      path: "release/latest.yml",
      detail: "Secret GitHub token found embedded in latest.yml update metadata",
    });
  }

  // Parse fields from latest.yml
  const pathMatch = ymlContent.match(/^path:\s*(.+)$/m);
  const sha512Match = ymlContent.match(/^sha512:\s*(.+)$/m);

  if (!pathMatch) {
    result.violations.push({
      rule: "invalid-latest-yml",
      path: "release/latest.yml",
      detail: "latest.yml does not specify 'path'",
    });
    return;
  }

  const installerRel = pathMatch[1].trim();
  const installerPath = join(releaseDir, installerRel);
  if (!existsSync(installerPath)) {
    result.violations.push({
      rule: "missing-installer-for-metadata",
      path: `release/${installerRel}`,
      detail: `Installer referenced in latest.yml does not exist: ${installerRel}`,
    });
    return;
  }

  // Verify blockmap exists
  const blockmapPath = join(releaseDir, `${installerRel}.blockmap`);
  if (!existsSync(blockmapPath)) {
    result.violations.push({
      rule: "missing-blockmap",
      path: `release/${installerRel}.blockmap`,
      detail: `Blockmap file for installer does not exist: ${installerRel}.blockmap`,
    });
  }

  // Verify file size and SHA-512
  const installerBuf = readFileSync(installerPath);
  if (sha512Match) {
    const expectedSha512 = sha512Match[1].trim();
    const actualSha512 = createHash("sha512").update(installerBuf).digest("base64");
    if (actualSha512 !== expectedSha512) {
      result.violations.push({
        rule: "sha512-mismatch",
        path: `release/${installerRel}`,
        detail: `Installer SHA-512 (${actualSha512}) does not match latest.yml (${expectedSha512})`,
      });
    }
  }

  // Audit RELEASE-MANIFEST.json if present
  const manifestPath = join(releaseDir, "RELEASE-MANIFEST.json");
  if (existsSync(manifestPath)) {
    try {
      const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as Record<string, unknown>;
      if (manifest.installerFilename !== installerRel) {
        result.violations.push({
          rule: "manifest-installer-mismatch",
          path: "release/RELEASE-MANIFEST.json",
          detail: `Manifest installerFilename (${manifest.installerFilename}) does not match latest.yml (${installerRel})`,
        });
      }
      if (typeof manifest.installerSha256 !== "string" || manifest.installerSha256.length !== 64) {
        result.violations.push({
          rule: "manifest-invalid-sha256",
          path: "release/RELEASE-MANIFEST.json",
          detail: "Manifest installerSha256 is missing or invalid",
        });
      }
    } catch (err) {
      result.violations.push({
        rule: "invalid-manifest-json",
        path: "release/RELEASE-MANIFEST.json",
        detail: `Failed to parse RELEASE-MANIFEST.json: ${err instanceof Error ? err.message : String(err)}`,
      });
    }
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = getProjectRoot();
  const releaseDir = join(root, "release");

  if (!existsSync(releaseDir)) {
    console.error(`FAIL: Release directory does not exist: ${releaseDir}`);
    console.error("Run packaging first: npm run package:dir or npm run package:win");
    process.exit(1);
  }

  const result = auditPackagedRelease(releaseDir);

  console.log("Release Package Audit Results:");
  console.log("------------------------------");
  console.log(`PACKAGED_MOGOBE_ORIGINAL_FILES:   ${result.packagedMogobeOriginalFiles}`);
  console.log(`PACKAGED_RUNTIME_USER_DATA_FILES: ${result.packagedRuntimeUserDataFiles}`);
  console.log(`PACKAGED_SECRETS:                 ${result.packagedSecrets}`);
  console.log(`PACKAGED_RESEARCH_PATH_LEAKS:     ${result.packagedResearchPathLeaks}`);
  console.log(`Verified Licenses:                ${result.verifiedLicenses.length}`);

  if (result.violations.length > 0) {
    console.error(`\nFAIL: Release audit failed with ${result.violations.length} violation(s):`);
    for (const v of result.violations) {
      console.error(`  [${v.rule}] ${v.path}: ${v.detail}`);
    }
    process.exit(1);
  }

  console.log("\nPASS: All release packaging audits passed cleanly.");
}
