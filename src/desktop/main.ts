import { app, BrowserWindow, shell } from "electron";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { startProductionServer, type ProductionServerHandle } from "../server/production-server.ts";
import { getProjectRoot } from "../storage/paths.ts";
import { LocalGobeUpdater, setActiveUpdater } from "./updater.ts";

let serverHandle: ProductionServerHandle | null = null;
let mainWindow: BrowserWindow | null = null;

const isSmokeTest = process.argv.includes("--smoke-test");

function resolveUserDataDir(): string {
  if (process.env.LOCALGOBE_DATA_DIR) {
    return resolve(process.env.LOCALGOBE_DATA_DIR);
  }
  const localAppData = process.env.LOCALAPPDATA || (app ? app.getPath("userData") : tmpdir());
  return join(localAppData, "LocalGobe", "data");
}

function resolveBundledRuntimeDirs(): { ruffle: string; air: string; fonts: string } {
  const isPackaged = app ? app.isPackaged : false;
  const baseDir = isPackaged
    ? join(process.resourcesPath, "runtime")
    : join(getProjectRoot(), "data", "runtime");

  return {
    ruffle: process.env.LOCALGOBE_RUFFLE_DIST || join(baseDir, "ruffle"),
    air: process.env.LOCALGOBE_AIR_SHIMS_DIR || join(baseDir, "air"),
    fonts: process.env.LOCALGOBE_FONTS_DIR || join(baseDir, "fonts"),
  };
}

function resolveDistDir(): string {
  if (app && app.isPackaged) {
    const asarDist = join(app.getAppPath(), "dist");
    if (existsSync(asarDist)) return asarDist;
    return join(process.resourcesPath, "dist");
  }
  return join(getProjectRoot(), "dist");
}

export async function runSmokeTest(): Promise<number> {
  const tempDir = mkdtempSync(join(tmpdir(), "localgobe-smoke-"));
  console.log(`[smoke-test] Temporary data directory: ${tempDir}`);

  const runtimeDirs = resolveBundledRuntimeDirs();
  console.log(`[smoke-test] Ruffle runtime dir: ${runtimeDirs.ruffle}`);
  console.log(`[smoke-test] AIR shims dir: ${runtimeDirs.air}`);

  // 1. Verify bundled Ruffle
  const ruffleJs = join(runtimeDirs.ruffle, "ruffle.js");
  if (!existsSync(ruffleJs)) {
    console.error(`[smoke-test] FAIL: bundled ruffle.js not found at ${ruffleJs}`);
    return 1;
  }
  const ruffleFiles = readdirSync(runtimeDirs.ruffle);
  const hasWasm = ruffleFiles.some((f) => f.endsWith(".wasm"));
  if (!hasWasm) {
    console.error(`[smoke-test] FAIL: bundled Ruffle wasm not found in ${runtimeDirs.ruffle}`);
    return 1;
  }
  console.log("[smoke-test] PASS: bundled Ruffle verified.");

  // 2. Verify bundled AIR shims
  const requiredAirShims = [
    "AirBootstrap.swf",
    "stage_text_shim.swf",
    "stage_text_init_options_shim.swf",
    "air_network_info_shim.swf",
  ];
  for (const shim of requiredAirShims) {
    const shimPath = join(runtimeDirs.air, shim);
    if (!existsSync(shimPath)) {
      console.error(`[smoke-test] FAIL: required AIR shim not found: ${shimPath}`);
      return 1;
    }
  }
  console.log("[smoke-test] PASS: bundled AIR shims verified.");

  // 3. Start production HTTP server & SmartFox runtime
  process.env.LOCALGOBE_DATA_DIR = tempDir;
  process.env.LOCALGOBE_RUFFLE_DIST = runtimeDirs.ruffle;
  process.env.LOCALGOBE_AIR_SHIMS_DIR = runtimeDirs.air;
  process.env.LOCALGOBE_FONTS_DIR = runtimeDirs.fonts;

  const handle = await startProductionServer({
    host: "127.0.0.1",
    port: 0,
    dataDir: tempDir,
    distDir: resolveDistDir(),
    startSmartFox: true,
  });

  try {
    console.log(`[smoke-test] Production server listening on ${handle.origin}`);
    console.log(`[smoke-test] SmartFox ready: ${handle.smartFoxReady}`);

    // 4. Probe API endpoint: /api/builds
    const res = await fetch(`${handle.origin}/api/builds`);
    if (res.status !== 200) {
      console.error(`[smoke-test] FAIL: /api/builds returned status ${res.status}`);
      return 1;
    }
    const data = await res.json();
    if (!data || !Array.isArray(data.installed) || !Array.isArray(data.supported)) {
      console.error("[smoke-test] FAIL: unexpected response shape from /api/builds");
      return 1;
    }
    if (data.installed.length !== 0) {
      console.error(`[smoke-test] FAIL: fresh data dir should have 0 installed builds, got ${data.installed.length}`);
      return 1;
    }
    console.log("[smoke-test] PASS: API probe successful, 0 installed builds in fresh state.");

    // 5. Probe root index.html
    const rootRes = await fetch(`${handle.origin}/`);
    if (rootRes.status !== 200) {
      console.error(`[smoke-test] FAIL: root / returned status ${rootRes.status}`);
      return 1;
    }
    console.log("[smoke-test] PASS: root index.html served cleanly.");
  } finally {
    await handle.close();
    try {
      rmSync(tempDir, { recursive: true, force: true });
    } catch {}
  }

  console.log("[smoke-test] All smoke test assertions passed successfully.");
  return 0;
}

if (!isSmokeTest) {
  const gotLock = app.requestSingleInstanceLock();
  if (!gotLock) {
    app.quit();
    process.exit(0);
  }

  app.on("second-instance", () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });
}

async function createWindow(): Promise<void> {
  const dataDir = resolveUserDataDir();
  mkdirSync(dataDir, { recursive: true });

  const runtimeDirs = resolveBundledRuntimeDirs();
  process.env.LOCALGOBE_DATA_DIR = dataDir;
  process.env.LOCALGOBE_RUFFLE_DIST = runtimeDirs.ruffle;
  process.env.LOCALGOBE_AIR_SHIMS_DIR = runtimeDirs.air;
  process.env.LOCALGOBE_FONTS_DIR = runtimeDirs.fonts;

  const distDir = resolveDistDir();

  const updater = new LocalGobeUpdater({
    currentVersion: app ? app.getVersion() : "0.1.0-preview.2",
    autoCheck: true,
    autoCheckDelayMs: 4000,
    onBeforeQuitAndInstall: async () => {
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.destroy();
        mainWindow = null;
      }
      if (serverHandle) {
        const handle = serverHandle;
        serverHandle = null;
        await handle.close();
      }
    },
  });
  setActiveUpdater(updater);

  serverHandle = await startProductionServer({
    host: "127.0.0.1",
    port: 0,
    dataDir,
    distDir,
    startSmartFox: true,
    updater,
  });

  const serverOrigin = serverHandle.origin;

  mainWindow = new BrowserWindow({
    width: 1040,
    height: 740,
    minWidth: 800,
    minHeight: 560,
    title: "LocalGobe",
    autoHideMenuBar: true,
    backgroundColor: "#0f172a",
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
    },
  });

  mainWindow.setMenuBarVisibility(false);

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith("http://") || url.startsWith("https://")) {
      if (!url.startsWith(serverOrigin)) {
        void shell.openExternal(url);
        return { action: "deny" };
      }
    }
    return { action: "deny" };
  });

  mainWindow.webContents.on("will-navigate", (event, navigationUrl) => {
    if (!navigationUrl.startsWith(serverOrigin)) {
      event.preventDefault();
      void shell.openExternal(navigationUrl);
    }
  });

  await mainWindow.loadURL(serverOrigin);

  mainWindow.on("closed", () => {
    mainWindow = null;
  });
}

if (typeof app !== "undefined" && app.whenReady) {
  app.whenReady().then(async () => {
    if (isSmokeTest) {
      const code = await runSmokeTest();
      app.exit(code);
      return;
    }
    await createWindow();
  });

  app.on("window-all-closed", () => {
    app.quit();
  });

  app.on("before-quit", async () => {
    if (serverHandle) {
      const handle = serverHandle;
      serverHandle = null;
      await handle.close();
    }
  });
}
