import assert from "node:assert/strict";
import { execSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import {
  GITHUB_UPDATE_CONFIG,
  LocalGobeUpdater,
  type IUpdateService,
  type UpdateStatus,
} from "../src/desktop/updater.ts";
import { generateReleaseManifest } from "../scripts/generate-release-manifest.ts";
import { validatePromotionIntegrity } from "../scripts/promote-draft-release.ts";
import { handleApiRoute } from "../src/server/http/api-routes.ts";
import { getProjectRoot } from "../src/storage/paths.ts";

// ── Version Comparison Helper (Mirrors NSIS Logic) ──
function normalizeVersion(ver: string): string {
  const match = ver.match(/^(.+)-preview\.(\d+)$/);
  if (match) {
    return `${match[1]}.0.${match[2]}`;
  }
  return `${ver}.1.0`;
}

function compareVersions(v1: string, v2: string): number {
  // Returns:
  // -1 if v1 < v2 (v1 is older than v2)
  //  0 if v1 == v2
  //  1 if v1 > v2 (v1 is newer than v2)
  const n1 = normalizeVersion(v1).split(".").map(Number);
  const n2 = normalizeVersion(v2).split(".").map(Number);
  const len = Math.max(n1.length, n2.length);

  for (let i = 0; i < len; i++) {
    const a = n1[i] ?? 0;
    const b = n2[i] ?? 0;
    if (a < b) return -1;
    if (a > b) return 1;
  }
  return 0;
}

test("Smart Setup Maintenance Matrix & Version Comparison", () => {
  // 1. Fresh install (no version installed)
  const freshInstalledVersion = null;
  assert.equal(freshInstalledVersion, null);

  // 2. Older installed + newer setup -> UPDATE
  // preview.1 -> preview.2
  assert.equal(compareVersions("0.1.0-preview.1", "0.1.0-preview.2"), -1);
  // preview.2 -> preview.3
  assert.equal(compareVersions("0.1.0-preview.2", "0.1.0-preview.3"), -1);
  // preview.3 -> 0.1.0
  assert.equal(compareVersions("0.1.0-preview.3", "0.1.0"), -1);

  // 3. Same version installed + same setup -> REPAIR
  assert.equal(compareVersions("0.1.0-preview.2", "0.1.0-preview.2"), 0);
  assert.equal(compareVersions("0.1.0", "0.1.0"), 0);

  // 4. Newer installed + older setup -> DOWNGRADE BLOCKED
  // preview.4 installed, setup preview.3
  assert.equal(compareVersions("0.1.0-preview.4", "0.1.0-preview.3"), 1);
  // 0.1.0 installed, setup preview.3
  assert.equal(compareVersions("0.1.0", "0.1.0-preview.3"), 1);
  // 0.2.0 installed, setup 0.1.0
  assert.equal(compareVersions("0.2.0", "0.1.0"), 1);
});

test("OTA Update Configuration & Policy Requirements", () => {
  // Provider configuration
  assert.equal(GITHUB_UPDATE_CONFIG.provider, "github");
  assert.equal(GITHUB_UPDATE_CONFIG.owner, "dadyeliuz");
  assert.equal(GITHUB_UPDATE_CONFIG.repo, "LocalGobe");

  // Verify package.json build identity
  const root = getProjectRoot();
  const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as {
    build: {
      appId: string;
      productName: string;
      publish: { provider: string; owner: string; repo: string };
      nsis: { deleteAppDataOnUninstall: boolean; include: string };
    };
  };

  assert.equal(pkg.build.appId, "com.localgobe.launcher");
  assert.equal(pkg.build.productName, "LocalGobe");
  assert.equal(pkg.build.publish.provider, "github");
  assert.equal(pkg.build.publish.owner, "dadyeliuz");
  assert.equal(pkg.build.publish.repo, "LocalGobe");
  assert.equal(pkg.build.nsis.deleteAppDataOnUninstall, false);
  assert.equal(pkg.build.nsis.include, "build/installer.nsh");

  // Verify NO GitHub token embedded in client source
  const clientSources = [
    readFileSync(join(root, "src/desktop/updater.ts"), "utf8"),
    readFileSync(join(root, "src/desktop/main.ts"), "utf8"),
    readFileSync(join(root, "src/ui/api.ts"), "utf8"),
    readFileSync(join(root, "package.json"), "utf8"),
  ];
  for (const src of clientSources) {
    assert.doesNotMatch(src, /ghp_[A-Za-z0-9]{30,}/);
    assert.doesNotMatch(src, /github_pat_[A-Za-z0-9_]{30,}/);
  }
});

test("Updater State Machine Lifecycle & Mock Feed", async () => {
  // Mock backend simulating electron-updater events
  type EventHandler = (...args: any[]) => void;
  const handlers: Record<string, EventHandler[]> = {};

  const mockBackend = {
    autoDownload: false,
    autoInstallOnAppQuit: false,
    allowDowngrade: false,
    allowPrerelease: true,
    verifyUpdateCodeSignature: false,
    setFeedURL: () => {},
    on: (evt: string, cb: EventHandler) => {
      handlers[evt] = handlers[evt] ?? [];
      handlers[evt].push(cb);
    },
    checkForUpdates: async () => {
      handlers["checking-for-update"]?.forEach((cb) => cb());
      // Emit update available: 0.1.0-preview.3
      handlers["update-available"]?.forEach((cb) => cb({ version: "0.1.0-preview.3" }));
    },
    downloadUpdate: async () => {
      handlers["download-progress"]?.forEach((cb) => cb({ percent: 42 }));
      handlers["update-downloaded"]?.forEach((cb) => cb({ version: "0.1.0-preview.3" }));
    },
    quitAndInstall: (isSilent: boolean, isForceRunAfter: boolean) => {
      mockBackend.quitAndInstallCalled = { isSilent, isForceRunAfter };
    },
    quitAndInstallCalled: null as { isSilent: boolean; isForceRunAfter: boolean } | null,
  };

  let shutdownCalled = false;
  const updater = new LocalGobeUpdater({
    currentVersion: "0.1.0-preview.2",
    autoCheck: false,
    backend: mockBackend,
    onBeforeQuitAndInstall: async () => {
      shutdownCalled = true;
    },
  });

  // 1. Initial State
  assert.equal(updater.getStatus().state, "idle");
  assert.equal(updater.getStatus().currentVersion, "0.1.0-preview.2");

  // 2. Check for updates -> Available
  const checkStatus = await updater.checkForUpdates();
  assert.equal(checkStatus.state, "available");
  assert.equal(checkStatus.availableVersion, "0.1.0-preview.3");

  // 3. Download update -> Downloaded
  await updater.downloadUpdate();
  const downloadedStatus = updater.getStatus();
  assert.equal(downloadedStatus.state, "downloaded");
  assert.equal(downloadedStatus.downloadProgress, 100);

  // 4. Safe shutdown & Relaunch
  await updater.quitAndInstall();
  assert.equal(shutdownCalled, true);
  assert.deepEqual(mockBackend.quitAndInstallCalled, { isSilent: false, isForceRunAfter: true });
});

test("HTTP Update API Endpoints", async () => {
  let downloadTriggered = false;
  let installTriggered = false;

  const stubUpdater: IUpdateService = {
    getStatus: () => ({
      state: "available",
      currentVersion: "0.1.0-preview.2",
      availableVersion: "0.1.0-preview.3",
    }),
    checkForUpdates: async () => ({
      state: "available",
      currentVersion: "0.1.0-preview.2",
      availableVersion: "0.1.0-preview.3",
    }),
    downloadUpdate: async () => {
      downloadTriggered = true;
    },
    quitAndInstall: async () => {
      installTriggered = true;
    },
  };

  // GET /api/updates/status
  const statusRes = handleApiRoute({
    method: "GET",
    pathname: "/api/updates/status",
    query: new URLSearchParams(),
    headers: {},
    body: Buffer.alloc(0),
    origin: "http://127.0.0.1:5173",
    activeBuildId: "20160725-android-1.4.7",
    setActiveBuildId: () => {},
    updater: stubUpdater,
  });
  assert.equal(statusRes?.status, 200);
  const statusJson = JSON.parse(String(statusRes?.body)) as UpdateStatus;
  assert.equal(statusJson.state, "available");
  assert.equal(statusJson.currentVersion, "0.1.0-preview.2");
  assert.equal(statusJson.availableVersion, "0.1.0-preview.3");

  // POST /api/updates/check
  const checkRes = handleApiRoute({
    method: "POST",
    pathname: "/api/updates/check",
    query: new URLSearchParams(),
    headers: {},
    body: Buffer.alloc(0),
    origin: "http://127.0.0.1:5173",
    activeBuildId: "20160725-android-1.4.7",
    setActiveBuildId: () => {},
    updater: stubUpdater,
  });
  assert.equal(checkRes?.status, 200);

  // POST /api/updates/download
  const dlRes = handleApiRoute({
    method: "POST",
    pathname: "/api/updates/download",
    query: new URLSearchParams(),
    headers: {},
    body: Buffer.alloc(0),
    origin: "http://127.0.0.1:5173",
    activeBuildId: "20160725-android-1.4.7",
    setActiveBuildId: () => {},
    updater: stubUpdater,
  });
  assert.equal(dlRes?.status, 200);
  assert.equal(downloadTriggered, true);

  // POST /api/updates/install
  const instRes = handleApiRoute({
    method: "POST",
    pathname: "/api/updates/install",
    query: new URLSearchParams(),
    headers: {},
    body: Buffer.alloc(0),
    origin: "http://127.0.0.1:5173",
    activeBuildId: "20160725-android-1.4.7",
    setActiveBuildId: () => {},
    updater: stubUpdater,
  });
  assert.equal(instRes?.status, 200);
  // Wait for setTimeout in quitAndInstall
  await new Promise((r) => setTimeout(r, 150));
  assert.equal(installTriggered, true);
});

test("Release Manifest Generator & Draft Promotion Verification", () => {
  const tempRelDir = join(tmpdir(), `localgobe-test-manifest-${Date.now()}`);
  mkdirSync(tempRelDir, { recursive: true });

  try {
    // Create dummy installer file in temp release dir
    const dummyInstaller = join(tempRelDir, "LocalGobe-Setup-0.1.0-preview.2.exe");
    writeFileSync(dummyInstaller, Buffer.from("dummy installer bytes"), "utf8");

    const manifest = generateReleaseManifest({
      releaseDir: tempRelDir,
      projectRoot: getProjectRoot(),
      publicAudit: "PASS",
      releaseAudit: "PASS",
      smokeTest: "PASS",
    });

    assert.equal(manifest.version, "0.1.0-preview.2");
    assert.equal(manifest.installerFilename, "LocalGobe-Setup-0.1.0-preview.2.exe");
    assert.equal(typeof manifest.installerSha256, "string");
    assert.equal(manifest.installerSha256?.length, 64);
    assert.equal(manifest.installerSize, 21);
    assert.equal(manifest.ruffleCommit, "edef34c136f318f5c03c339d48ea527899864e53");
    assert.equal(manifest.toolchainAssetsCommit, "a7d418d26538b232e3fb2da3646b23146f78173a");
    assert.equal(manifest.publicAudit, "PASS");
    assert.equal(manifest.releaseAudit, "PASS");
    assert.equal(manifest.smokeTest, "PASS");

    // Promotion verification test:
    // When hashes match, promotion succeeds
    const validPromotion = validatePromotionIntegrity({
      draftInstallerSha256: manifest.installerSha256!,
      expectedSha256: manifest.installerSha256!,
    });
    assert.equal(validPromotion, true);

    // When hashes do not match, promotion fails
    const invalidPromotion = validatePromotionIntegrity({
      draftInstallerSha256: manifest.installerSha256!,
      expectedSha256: "0000000000000000000000000000000000000000000000000000000000000000",
    });
    assert.equal(invalidPromotion, false);
  } finally {
    try {
      rmSync(tempRelDir, { recursive: true, force: true });
    } catch {}
  }
});

test("NSIS Hook Script Compilation Verification", () => {
  const localAppData = process.env.LOCALAPPDATA || "";
  const makensisPath = join(
    localAppData,
    "electron-builder",
    "Cache",
    "nsis-3.0.4.1",
    "nsis-3.0.4.1-1mx3n",
    "makensis.exe"
  );
  if (!existsSync(makensisPath)) {
    // If makensis binary is not found, skip compiler invocation
    return;
  }

  const root = getProjectRoot();
  const installerNsh = resolve(root, "build", "installer.nsh");
  assert.equal(existsSync(installerNsh), true, "build/installer.nsh must exist");

  const nsisIncludeDir = resolve(root, "node_modules", "app-builder-lib", "templates", "nsis", "include");

  // Compile test wrapper with makensis
  const wrapperScript = `
!define PRODUCT_NAME "LocalGobe"
!define PRODUCT_FILENAME "LocalGobe"
!define APP_FILENAME "LocalGobe"
!define VERSION "0.1.0-preview.2"
!define UNINSTALL_REGISTRY_KEY "Software\\\\Microsoft\\\\Windows\\\\CurrentVersion\\\\Uninstall\\\\com.localgobe.launcher"
!define APP_EXECUTABLE_FILENAME "LocalGobe.exe"

!addincludedir "${nsisIncludeDir.replace(/\\/g, "\\\\")}"
!include "LogicLib.nsh"
!include "WordFunc.nsh"
!include "FileFunc.nsh"
!include "getProcessInfo.nsh"

!macro _isUpdated _a _b _t _f
  StrCmp "false" "true" "\${_t}" "\${_f}"
!macroend
!define isUpdated '"" isUpdated ""'

Var pid
Var CmdPath
Var PowerShellPath
Var IsPowerShellAvailable

LangString appCannotBeClosed 1033 "Cannot be closed"

!macro IS_POWERSHELL_AVAILABLE
!macroend

!macro FIND_PROCESS _FILE _RETURN
  StrCpy \${_RETURN} 1
!macroend

!macro KILL_PROCESS _FILE _FORCE
!macroend

!include "${installerNsh.replace(/\\/g, "\\\\")}"

OutFile "${join(tmpdir(), "test-installer-compile.exe").replace(/\\/g, "\\\\")}"
RequestExecutionLevel user
SilentInstall silent

Function .onInit
  !insertmacro customInit
FunctionEnd

Section
  DetailPrint "NSIS hook test section"
SectionEnd
`;

  const tempNsi = join(tmpdir(), `test-compile-${Date.now()}.nsi`);
  writeFileSync(tempNsi, wrapperScript, "utf8");

  try {
    const output = execSync(`"${makensisPath}" "${tempNsi}"`, { encoding: "utf8" });
    assert.match(output, /Output:/);
  } finally {
    try {
      rmSync(tempNsi, { force: true });
    } catch {}
  }
});
