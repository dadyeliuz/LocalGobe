import "@fontsource-variable/rubik";
import type { InstalledBuildManifest } from "../storage/manifest-generator.ts";
import {
  deleteBuild,
  fetchBuilds,
  fetchRuntimeConfig,
  fetchUpdateStatus,
  triggerCheckUpdates,
  triggerDownloadUpdate,
  triggerInstallUpdate,
  uploadApk,
  uploadExternalFile,
  type BuildsListResponse,
  type UpdateStatusResponse,
} from "./api.ts";
import { num } from "./html.ts";
import { he } from "./i18n/he.ts";
import {
  applyFileFailure,
  applyFileResult,
  beginImporting,
  createImportSession,
  finishSession,
  type ImportSession,
} from "./import-session.ts";
import {
  countsOf,
  deriveHomeModel,
  EMPTY_COUNTS,
  pickActiveBuild,
  routeDroppedFiles,
  classifyMissingAsset,
  type ContentContext,
  type ContentCounts,
  type MissingAssetEntry,
} from "./model.ts";
import { isBusy, sheetDismissible, sheetKey, type Sheet } from "./ui-state.ts";
import {
  renderDropOverlay,
  renderPlayError,
  renderPlayScreen,
  renderPortalTransition,
  renderToast,
  renderMissingAssetToast,
  type MissingToastState,
} from "./views/play.ts";
import { renderFirstRun, renderHome, renderLoading } from "./views/screens.ts";
import { importProgressParts, renderSheet, type SheetContext } from "./views/sheets.ts";

type RufflePlayerEl = HTMLElement & {
  ruffle(): {
    load(options: {
      url: string;
      parameters?: Record<string, string>;
      autoplay: string;
      allowScriptAccess: boolean;
      socketProxy?: Array<{ host: string; port: number; proxyUrl: string }>;
      urlRewriteRules?: Array<[string | RegExp, string]>;
      logLevel: string;
      playerRuntime?: "air" | "flashPlayer";
      deviceFontRenderer?: "embedded" | "canvas";
      fontSources?: readonly string[];
    }): Promise<void>;
  };
};

type RuffleWindow = Window & {
  RufflePlayer?: {
    config?: Record<string, unknown>;
    newest?(): { createPlayer(): RufflePlayerEl };
  };
};

type ViewMode = "loading" | "first-run" | "home" | "play";

interface AppState {
  mode: ViewMode;
  data: BuildsListResponse | null;
  activeBuildId: string | null;
  serviceError: boolean;
  sheet: Sheet | null;
  dragActive: boolean;
  portalTransition: boolean;
  playMenuOpen: boolean;
  toast: string | null;
  lastUnknownFiles: string[];
  preferFullscreen: boolean;
  diagnosticsEnabled: boolean;
  pendingContext: ContentContext;
  missingAssets: MissingAssetEntry[];
  missingToast: MissingToastState | null;
}

const state: AppState = {
  mode: "loading",
  data: null,
  activeBuildId: null,
  serviceError: false,
  sheet: null,
  dragActive: false,
  portalTransition: false,
  playMenuOpen: false,
  toast: null,
  lastUnknownFiles: [],
  preferFullscreen: localStorage.getItem("localgobe:fullscreen") === "true",
  diagnosticsEnabled: localStorage.getItem("localgobe:diagnostics") === "true",
  pendingContext: "all",
  missingAssets: [],
  missingToast: null,
};

// Previous counts for smooth count-up & bubble pop animations
let lastDisplayedCounts: ContentCounts = { ...EMPTY_COUNTS };
let lastScreenSignature = "";
let lastSheetSignature = "none";
let importRunId = 0;
let cancelImportRequested = false;
let apkAutoCloseTimer: number | null = null;
let toastTimer: number | null = null;
let missingToastTimer: number | null = null;
let toastBatchCount = 0;
let lastBatchResetTimer: number | null = null;
let dragDepth = 0;
let focusBeforeSheet: HTMLElement | null = null;

const app = document.getElementById("app")!;
app.innerHTML = `<div id="screen-layer"></div><div id="sheet-layer"></div><div id="overlay-layer"></div>`;
const screenLayer = document.getElementById("screen-layer")!;
const sheetLayer = document.getElementById("sheet-layer")!;
const overlayLayer = document.getElementById("overlay-layer")!;

// Hidden file inputs for non-drag selection
const apkInput = document.createElement("input");
apkInput.type = "file";
apkInput.accept = ".apk,application/vnd.android.package-archive";
apkInput.hidden = true;

const filesInput = document.createElement("input");
filesInput.type = "file";
filesInput.multiple = true;
filesInput.hidden = true;

const folderInput = document.createElement("input");
folderInput.type = "file";
folderInput.multiple = true;
folderInput.setAttribute("webkitdirectory", "");
folderInput.hidden = true;

document.body.append(apkInput, filesInput, folderInput);

apkInput.addEventListener("change", () => {
  const file = apkInput.files?.[0];
  apkInput.value = "";
  if (file) void handleApkImport(file);
});

filesInput.addEventListener("change", () => {
  const files = filesInput.files ? Array.from(filesInput.files) : [];
  filesInput.value = "";
  if (files.length > 0) {
    void handleExternalFilesImport(
      files.map((f) => ({ file: f, relativePath: f.name })),
      state.pendingContext,
    );
  }
});

folderInput.addEventListener("change", () => {
  const files = folderInput.files ? Array.from(folderInput.files) : [];
  folderInput.value = "";
  if (files.length > 0) {
    void handleExternalFilesImport(
      files.map((f) => ({
        file: f,
        relativePath: (f as File & { webkitRelativePath?: string }).webkitRelativePath || f.name,
      })),
      state.pendingContext,
    );
  }
});

// Expose minimal ExternalInterface hooks expected by Mogobe Flash client
const winAny = window as unknown as Record<string, unknown>;
winAny.onPageView = () => {};
winAny.onGemiusPageView = () => {};
winAny.onTrackEvent = () => {};
winAny.onSetVar = () => {};
winAny.reloadPage = () => window.location.reload();
winAny.logData = (msg?: string) => {
  if (state.diagnosticsEnabled) console.log("[mogobe]", msg);
};

function prefersReducedMotion(): boolean {
  return typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

let currentUpdateStatus: UpdateStatusResponse | null = null;
let updatePollTimer: number | null = null;

function activeBuild(): InstalledBuildManifest | null {
  return pickActiveBuild(state.data?.installed ?? [], state.activeBuildId);
}

function sheetContext(): SheetContext {
  const rt = state.data?.runtime;
  return {
    build: activeBuild(),
    runtime: rt
      ? {
          ruffleReady: rt.ruffle.ready,
          airShimsReady: rt.airShims.ready,
          smartFoxReady: rt.smartFoxReady,
          dataDir: rt.dataDir,
        }
      : null,
    prefs: {
      fullscreen: state.preferFullscreen,
      diagnostics: state.diagnosticsEnabled,
    },
    lastUnknownFiles: state.lastUnknownFiles,
    missingAssets: state.missingAssets,
    updateStatus: currentUpdateStatus,
  };
}

function showToast(text: string): void {
  state.toast = text;
  renderOverlays();
  if (toastTimer !== null) window.clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => {
    state.toast = null;
    toastTimer = null;
    renderOverlays();
  }, 3200);
}

function clearApkAutoClose(): void {
  if (apkAutoCloseTimer !== null) {
    window.clearTimeout(apkAutoCloseTimer);
    apkAutoCloseTimer = null;
  }
}

function openSheet(next: Sheet): void {
  if (!state.sheet && document.activeElement instanceof HTMLElement) {
    focusBeforeSheet = document.activeElement;
  }
  clearApkAutoClose();
  state.sheet = next;
  renderSheetLayer(true);
}

function closeSheet(): void {
  if (!sheetDismissible(state.sheet)) return;
  clearApkAutoClose();
  state.sheet = null;
  renderSheetLayer(true);
  if (focusBeforeSheet && document.contains(focusBeforeSheet)) {
    focusBeforeSheet.focus({ preventScroll: true });
  }
  focusBeforeSheet = null;
}

// ───────────────────────── Data & Import ─────────────────────────

async function refreshBuilds(animateGrowth = false): Promise<void> {
  const prevCounts = animateGrowth ? { ...lastDisplayedCounts } : null;
  try {
    const data = await fetchBuilds();
    state.data = data;
    state.serviceError = false;
    const active = pickActiveBuild(data.installed, state.activeBuildId);
    if (!active) {
      state.mode = "first-run";
      state.activeBuildId = null;
      lastDisplayedCounts = { ...EMPTY_COUNTS };
    } else {
      state.activeBuildId = active.buildId;
      if (state.mode !== "play") state.mode = "home";
    }
  } catch {
    state.serviceError = true;
    if (state.mode === "loading") state.mode = "first-run";
  }

  renderScreenLayer();
  if (state.sheet) renderSheetLayer(false);

  const nowCounts = countsOf(activeBuild());
  if (prevCounts && state.mode === "home") {
    animateHomeGrowth(prevCounts, nowCounts);
  }
  lastDisplayedCounts = nowCounts;
}

async function handleApkImport(file: File): Promise<void> {
  openSheet({ kind: "apk", phase: "checking" });
  try {
    const result = await uploadApk(file);
    if (result.ok) {
      state.activeBuildId = result.buildId;
      await refreshBuilds(false);
      openSheet({ kind: "apk", phase: "recognized", displayName: result.displayName });
      apkAutoCloseTimer = window.setTimeout(() => {
        if (state.sheet?.kind === "apk" && state.sheet.phase === "recognized") {
          closeSheet();
        }
      }, 2600);
    } else {
      openSheet({
        kind: "apk",
        phase: "error",
        code: result.code,
        technical: result.details?.technicalError ?? result.userMessage,
      });
    }
  } catch (err) {
    openSheet({
      kind: "apk",
      phase: "error",
      code: "INVALID_ARCHIVE",
      technical: err instanceof Error ? err.message : String(err),
    });
  }
}

async function handleExternalFilesImport(
  entries: Array<{ file: File; relativePath: string }>,
  context: ContentContext,
): Promise<void> {
  const build = activeBuild();
  if (!build) {
    openSheet({ kind: "need-apk" });
    return;
  }

  const runId = ++importRunId;
  cancelImportRequested = false;
  let session = createImportSession(context, build, entries.length);
  openSheet({ kind: "import", session, id: runId });

  const prevCounts = countsOf(build);
  let lastPatch = 0;

  for (let i = 0; i < entries.length; i++) {
    if (cancelImportRequested) break;
    const { file, relativePath } = entries[i];
    try {
      const summary = await uploadExternalFile(build.buildId, relativePath, file);
      session = applyFileResult(session, summary);
      // Keep the latest manifest in memory so Home reflects progress immediately
      if (state.data) {
        const idx = state.data.installed.findIndex((b) => b.buildId === build.buildId);
        if (idx >= 0) state.data.installed[idx] = summary.manifest;
      }
    } catch {
      session = applyFileFailure(session, relativePath);
    }

    const now = performance.now();
    if (i === 0 || i === entries.length - 1 || now - lastPatch > 70) {
      lastPatch = now;
      state.sheet = { kind: "import", session, id: runId };
      patchImportProgress(session);
    }
  }

  session = finishSession(session, cancelImportRequested);
  state.lastUnknownFiles = session.unknownFiles;
  state.sheet = { kind: "import", session, id: runId };

  // Refresh home behind the done sheet and animate any newly gained counts
  lastDisplayedCounts = prevCounts;
  await refreshBuilds(true);
  renderSheetLayer(true);
  animateResultCounts();
}

async function collectDroppedFiles(dataTransfer: DataTransfer): Promise<Array<{ file: File; relativePath: string }>> {
  const results: Array<{ file: File; relativePath: string }> = [];

  // CRITICAL: webkitGetAsEntry() MUST be called synchronously during the event dispatch turn!
  // In Chromium/WebKit, yielding to an `await` disarms dataTransfer.items, causing
  // subsequent items[i].webkitGetAsEntry() calls to return null and silently drop top-level folders 2..N.
  const rootEntries: FileSystemEntry[] = [];
  const rawItems = Array.from(dataTransfer.items ?? []);
  for (const item of rawItems) {
    if (item.kind === "file") {
      const entry = (item as DataTransferItem & { webkitGetAsEntry?: () => FileSystemEntry | null }).webkitGetAsEntry?.();
      if (entry) {
        rootEntries.push(entry);
      }
    }
  }

  async function walkEntry(entry: FileSystemEntry, prefix: string): Promise<void> {
    if (entry.isFile) {
      const file = await new Promise<File>((resolve, reject) =>
        (entry as FileSystemFileEntry).file(resolve, reject),
      );
      results.push({ file, relativePath: prefix ? `${prefix}/${file.name}` : file.name });
    } else if (entry.isDirectory) {
      const reader = (entry as FileSystemDirectoryEntry).createReader();
      const children: FileSystemEntry[] = [];
      while (true) {
        const batch = await new Promise<FileSystemEntry[]>((resolve, reject) =>
          reader.readEntries(resolve, reject),
        );
        if (batch.length === 0) break;
        children.push(...batch);
      }
      const nextPrefix = prefix ? `${prefix}/${entry.name}` : entry.name;
      for (const child of children) {
        await walkEntry(child, nextPrefix);
      }
    }
  }

  if (rootEntries.length > 0) {
    for (const entry of rootEntries) {
      await walkEntry(entry, "");
    }
  } else if (dataTransfer.files && dataTransfer.files.length > 0) {
    for (const file of Array.from(dataTransfer.files)) {
      results.push({ file, relativePath: file.name });
    }
  }

  return results;
}

// ───────────────────────── Missing Assets Interceptor & Logging ─────────────────────────

function isInternalUrl(urlStr: string): boolean {
  try {
    const url = new URL(urlStr, window.location.origin);
    const p = url.pathname.toLowerCase();
    if (
      p.startsWith("/api/") ||
      p.startsWith("/@") ||
      p.startsWith("/src/") ||
      p.startsWith("/node_modules/") ||
      p.startsWith("/ruffle/") ||
      p.startsWith("/local-fonts/") ||
      p === "/favicon.ico" ||
      p.endsWith(".map") ||
      p.endsWith("/0.swf")
    ) {
      return true;
    }
    return false;
  } catch {
    return true;
  }
}

function updatePlayMissingChip(): void {
  const chip = screenLayer.querySelector(".play-missing-chip");
  if (!chip) return;
  const count = state.missingAssets.length;
  if (count > 0) {
    chip.classList.add("has-missing");
    let badge = chip.querySelector(".play-chip-badge");
    if (!badge) {
      badge = document.createElement("span");
      badge.className = "play-chip-badge";
      chip.appendChild(badge);
    }
    badge.textContent = String(count);
  } else {
    chip.classList.remove("has-missing");
    chip.querySelector(".play-chip-badge")?.remove();
  }
}

function dismissMissingToast(): void {
  if (missingToastTimer !== null) {
    window.clearTimeout(missingToastTimer);
    missingToastTimer = null;
  }
  state.missingToast = null;
  renderOverlays();
}

function triggerMissingToast(filename: string, categoryLabel: string): void {
  if (state.mode !== "play" || state.sheet?.kind === "missing-log") return;

  toastBatchCount++;
  state.missingToast = {
    filename,
    categoryLabel,
    batchCount: toastBatchCount,
    timestamp: Date.now(),
  };
  renderOverlays();

  if (lastBatchResetTimer !== null) window.clearTimeout(lastBatchResetTimer);
  lastBatchResetTimer = window.setTimeout(() => {
    toastBatchCount = 0;
    lastBatchResetTimer = null;
  }, 2200);

  if (missingToastTimer !== null) window.clearTimeout(missingToastTimer);
  missingToastTimer = window.setTimeout(() => {
    dismissMissingToast();
  }, 4500);
}

function handleAsset404(rawUrl: string): void {
  try {
    if (isInternalUrl(rawUrl)) return;
    const urlObj = new URL(rawUrl, window.location.origin);
    const pathname = urlObj.pathname;
    const { category, categoryLabel, filename } = classifyMissingAsset(pathname);

    const now = Date.now();
    const timeFormatted = new Date(now).toLocaleTimeString("he-IL", {
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
    const existing = state.missingAssets.find((entry) => entry.path === pathname);

    if (existing) {
      existing.count++;
      existing.timestamp = now;
      existing.timeFormatted = timeFormatted;
    } else {
      state.missingAssets.unshift({
        id: `missing-${now}-${Math.random().toString(36).slice(2, 7)}`,
        url: rawUrl,
        path: pathname,
        filename,
        category,
        categoryLabel,
        timestamp: now,
        timeFormatted,
        count: 1,
      });
    }

    if (state.mode === "play") {
      updatePlayMissingChip();
    }

    triggerMissingToast(filename, categoryLabel);

    if (state.sheet?.kind === "missing-log") {
      renderSheetLayer(true);
    }
  } catch (err) {
    console.error("[missing-asset-interceptor] failed to process 404:", err);
  }
}

function setupMissingAssetInterceptor(): void {
  const originalFetch = window.fetch;
  window.fetch = async function (input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
    const response = await originalFetch.apply(this, [input, init] as [RequestInfo | URL, RequestInit?]);
    if (response.status === 404) {
      let rawUrl = "";
      if (typeof input === "string") {
        rawUrl = input;
      } else if (input instanceof URL) {
        rawUrl = input.href;
      } else if (input && typeof input === "object" && "url" in input) {
        rawUrl = (input as Request).url;
      }
      if (rawUrl) {
        handleAsset404(rawUrl);
      }
    }
    return response;
  };
}

// ───────────────────────── Play Mode ─────────────────────────

async function startPlayMode(build: InstalledBuildManifest, skipTransition = false): Promise<void> {
  clearApkAutoClose();
  state.sheet = null;
  state.playMenuOpen = false;
  renderSheetLayer(true);

  const reduced = prefersReducedMotion() || skipTransition;
  // Fetch runtime config + load Ruffle in parallel with the brief portal transition
  const runtimePromise = Promise.all([fetchRuntimeConfig(build.buildId), ensureRuffleLoaded()]);

  if (!reduced) {
    state.portalTransition = true;
    renderOverlays();
    await new Promise((r) => window.setTimeout(r, 320));
  }

  state.mode = "play";
  state.activeBuildId = build.buildId;
  renderScreenLayer(true);

  if (state.portalTransition) {
    state.portalTransition = false;
    renderOverlays();
  }

  const host = document.getElementById("player-host");
  if (!host) return;

  try {
    const [{ runtimeConfig }] = await runtimePromise;
    if (state.mode !== "play") return; // User clicked Back while loading

    const deviceFontRenderer = runtimeConfig.deviceFontRenderer ?? "embedded";
    const fontSources = runtimeConfig.fontSources ?? ["/local-fonts/arimo.ttf"];
    const win = window as RuffleWindow;
    win.RufflePlayer = win.RufflePlayer || {};
    win.RufflePlayer.config = {
      autoplay: "on",
      unmuteOverlay: "hidden",
      splashScreen: false,
      playerRuntime: runtimeConfig.playerRuntime,
      deviceFontRenderer,
      fontSources,
      allowScriptAccess: true,
    };

    const api = win.RufflePlayer;
    if (!api || typeof api.newest !== "function") {
      throw new Error("Ruffle runtime is not ready. Run `npm run setup:ruffle` to install it.");
    }

    host.innerHTML = "";
    const player = api.newest().createPlayer();
    player.style.width = "100%";
    player.style.height = "100%";
    host.appendChild(player);

    const rewriteRules: Array<[RegExp, string]> = runtimeConfig.urlRewriteRules.map(
      ([pattern, replacement]) => [new RegExp(pattern, "i"), replacement],
    );

    await player.ruffle().load({
      url: runtimeConfig.rootUrl,
      parameters: { ...runtimeConfig.defaultParameters },
      autoplay: "on",
      allowScriptAccess: true,
      playerRuntime: runtimeConfig.playerRuntime,
      deviceFontRenderer,
      fontSources,
      urlRewriteRules: rewriteRules.length > 0 ? rewriteRules : undefined,
      socketProxy: [
        { host: "127.0.0.1", port: 8001, proxyUrl: "ws://127.0.0.1:5174" },
        { host: "localhost", port: 8001, proxyUrl: "ws://127.0.0.1:5174" },
      ],
      logLevel: state.diagnosticsEnabled ? "info" : "warn",
    });

    if (state.preferFullscreen && host.requestFullscreen) {
      void host.requestFullscreen().catch(() => {});
    }
  } catch (err) {
    if (state.mode !== "play") return;
    host.innerHTML = renderPlayError(build.displayName, err instanceof Error ? err.message : String(err));
  }
}

function exitPlayMode(): void {
  if (document.fullscreenElement && document.exitFullscreen) {
    void document.exitFullscreen().catch(() => {});
  }
  dismissMissingToast();
  state.playMenuOpen = false;
  state.mode = activeBuild() ? "home" : "first-run";
  renderScreenLayer(true);
}

function ensureRuffleLoaded(): Promise<void> {
  const win = window as RuffleWindow;
  if (customElements.get("ruffle-player") && win.RufflePlayer?.newest) {
    return Promise.resolve();
  }
  return new Promise((resolve, reject) => {
    const existing = document.querySelector<HTMLScriptElement>('script[src="/ruffle/ruffle.js"]');
    if (existing) {
      existing.addEventListener("load", () => resolve(), { once: true });
      existing.addEventListener(
        "error",
        () => reject(new Error("Ruffle runtime files were not found in data/runtime/ruffle/.")),
        { once: true },
      );
      return;
    }
    const script = document.createElement("script");
    script.src = "/ruffle/ruffle.js";
    script.onload = () => resolve();
    script.onerror = () => reject(new Error("Ruffle runtime files were not found in data/runtime/ruffle/."));
    document.head.appendChild(script);
  });
}

// ───────────────────────── Rendering ─────────────────────────

function renderScreenLayer(force = false): void {
  const active = activeBuild();
  const model = deriveHomeModel(active);
  const sig =
    state.mode === "play"
      ? `play:${active?.buildId ?? ""}`
      : `${state.mode}:${model.stage}:${model.buildId}:${model.counts.rooms}:${model.counts.music}:${model.counts.items}:${model.counts.games}:${model.interfaceReady}:${model.bootstrapRoom.hasSwf}:${model.bootstrapRoom.hasTxt}:${state.serviceError}`;

  if (!force && sig === lastScreenSignature) return;
  const fresh = lastScreenSignature.split(":")[0] !== state.mode || lastScreenSignature.split(":")[1] !== model.stage;
  lastScreenSignature = sig;

  if (state.mode === "loading") {
    screenLayer.innerHTML = renderLoading();
    return;
  }
  if (state.mode === "first-run") {
    screenLayer.innerHTML = renderFirstRun({ serviceError: state.serviceError, fresh });
    return;
  }
  if (state.mode === "play") {
    screenLayer.innerHTML = renderPlayScreen({
      displayName: active?.displayName ?? he.gameName,
      menuOpen: state.playMenuOpen,
      entering: true,
      missingCount: state.missingAssets.length,
    });
    return;
  }
  screenLayer.innerHTML = renderHome(model, { serviceError: state.serviceError, fresh });
}

function renderSheetLayer(force = false): void {
  const key = sheetKey(state.sheet);
  if (!force && key === lastSheetSignature && state.sheet?.kind === "import") {
    return;
  }
  const changed = key !== lastSheetSignature;
  lastSheetSignature = key;
  sheetLayer.innerHTML = renderSheet(state.sheet, sheetContext());

  if (state.sheet && changed) {
    const focusTarget = sheetLayer.querySelector<HTMLElement>("[data-autofocus]") ?? sheetLayer.querySelector<HTMLElement>("button");
    focusTarget?.focus({ preventScroll: true });
  }
}

function patchImportProgress(session: ImportSession): void {
  const sheet = sheetLayer.querySelector(".sheet-import.is-working");
  if (!sheet) {
    renderSheetLayer(true);
    return;
  }
  const parts = importProgressParts(session);
  const bar = sheet.querySelector<HTMLElement>('[data-part="bar"]');
  if (bar) {
    bar.classList.remove("is-indeterminate");
    bar.setAttribute("aria-valuenow", String(parts.percent));
    const fill = bar.querySelector<HTMLElement>(".progress-fill");
    if (fill) fill.style.width = `${parts.percent}%`;
  }
  const label = sheet.querySelector<HTMLElement>('[data-part="label"]');
  if (label) label.textContent = parts.label;

  const headline = sheet.querySelector<HTMLElement>('[data-part="headline"]');
  if (headline && headline.dataset.seq !== String(parts.seq)) {
    headline.dataset.seq = String(parts.seq);
    headline.textContent = parts.headline;
    headline.classList.remove("is-pop");
    void headline.offsetWidth;
    headline.classList.add("is-pop");
  }

  const chips = sheet.querySelector<HTMLElement>('[data-part="chips"]');
  if (chips) chips.innerHTML = parts.chips;
}

function renderOverlays(): void {
  const context: ContentContext = state.sheet?.kind === "add" ? state.sheet.context : "all";
  overlayLayer.innerHTML =
    renderDropOverlay({
      active: state.dragActive,
      hasBuild: Boolean(activeBuild()),
      context,
    }) +
    renderPortalTransition(state.portalTransition) +
    renderToast(state.toast) +
    renderMissingAssetToast(state.missingToast);
}

function togglePlayMenu(open: boolean): void {
  state.playMenuOpen = open;
  const wrap = screenLayer.querySelector(".play-menu-wrap");
  if (!wrap) return;
  const btn = wrap.querySelector<HTMLButtonElement>('[data-action="toggle-play-menu"]');
  btn?.setAttribute("aria-expanded", String(open));
  const existing = wrap.querySelector(".play-menu");
  if (open && !existing) {
    wrap.insertAdjacentHTML(
      "beforeend",
      `<div class="play-menu" role="menu">
        <button type="button" class="play-menu-item" role="menuitem" data-action="open-missing-log">
          <span>${he.missingAssetsLog}${state.missingAssets.length > 0 ? ` (${state.missingAssets.length})` : ""}</span>
        </button>
        <button type="button" class="play-menu-item" role="menuitem" data-action="restart-play"><span>${he.restartGame}</span></button>
        <button type="button" class="play-menu-item" role="menuitem" data-action="exit-play"><span>${he.backToLauncher}</span></button>
      </div>`,
    );
  } else if (!open && existing) {
    existing.remove();
  }
}

// ───────────────────────── Count-up Motion ─────────────────────────

function animateCount(el: HTMLElement, from: number, to: number, durationMs = 520): void {
  if (prefersReducedMotion() || from === to) {
    el.textContent = num(to);
    return;
  }
  const start = performance.now();
  const step = (now: number) => {
    const t = Math.min(1, (now - start) / durationMs);
    const eased = 1 - Math.pow(1 - t, 3);
    const val = Math.round(from + (to - from) * eased);
    el.textContent = num(val);
    if (t < 1) requestAnimationFrame(step);
    else el.textContent = num(to);
  };
  requestAnimationFrame(step);
}

function animateHomeGrowth(prev: ContentCounts, next: ContentCounts): void {
  const keys: Array<"rooms" | "items" | "games"> = ["rooms", "items", "games"];
  for (const key of keys) {
    if (next[key] > prev[key]) {
      const countEl = screenLayer.querySelector<HTMLElement>(`[data-count-key="${key}"]`);
      if (countEl) animateCount(countEl, prev[key], next[key], 560);
      const bubble = screenLayer.querySelector<HTMLElement>(`[data-bump-key="${key}"]`);
      if (bubble) {
        bubble.classList.remove("is-bumped");
        void bubble.offsetWidth;
        bubble.classList.add("is-bumped");
      }
    }
  }
}

function animateResultCounts(): void {
  sheetLayer.querySelectorAll<HTMLElement>("[data-count-from]").forEach((el) => {
    const from = Number(el.dataset.countFrom ?? 0);
    const to = Number(el.dataset.count ?? 0);
    animateCount(el, from, to, 460);
  });
}

// ───────────────────────── Event Delegation ─────────────────────────

app.addEventListener("click", (e) => {
  const target = (e.target as HTMLElement | null)?.closest<HTMLElement>("[data-action]");
  if (!target) {
    if (state.playMenuOpen && !(e.target as HTMLElement | null)?.closest(".play-menu-wrap")) {
      togglePlayMenu(false);
    }
    return;
  }

  const action = target.dataset.action;
  switch (action) {
    case "pick-apk":
      apkInput.click();
      break;
    case "pick-folder":
      state.pendingContext = (target.dataset.context as ContentContext) || "all";
      folderInput.click();
      break;
    case "pick-files":
      state.pendingContext = (target.dataset.context as ContentContext) || "all";
      filesInput.click();
      break;
    case "open-add":
      openSheet({ kind: "add", context: (target.dataset.context as ContentContext) || "all" });
      break;
    case "set-context": {
      const nextCtx = (target.dataset.context as ContentContext) || "all";
      if (state.sheet?.kind === "add" && state.sheet.context !== nextCtx) {
        state.sheet = { kind: "add", context: nextCtx };
        renderSheetLayer(true);
        sheetLayer.querySelector<HTMLElement>(`[data-action="set-context"][data-context="${nextCtx}"]`)?.focus();
      }
      break;
    }
    case "open-details":
      openSheet({ kind: "details", confirmRemove: false });
      break;
    case "open-settings":
      void (async () => {
        try {
          currentUpdateStatus = await fetchUpdateStatus();
        } catch {
          // ignore error on quiet fetch
        }
        openSheet({ kind: "settings" });
      })();
      break;
    case "check-updates":
      void (async () => {
        currentUpdateStatus = {
          state: "checking",
          currentVersion: currentUpdateStatus?.currentVersion ?? "0.1.0-preview.2",
        };
        renderSheetLayer(true);
        try {
          currentUpdateStatus = await triggerCheckUpdates();
        } catch (err) {
          currentUpdateStatus = {
            state: "error",
            currentVersion: currentUpdateStatus?.currentVersion ?? "0.1.0-preview.2",
            errorMessage: err instanceof Error ? err.message : String(err),
          };
        }
        renderSheetLayer(true);
      })();
      break;
    case "download-update":
      void (async () => {
        currentUpdateStatus = {
          state: "downloading",
          currentVersion: currentUpdateStatus?.currentVersion ?? "0.1.0-preview.2",
          availableVersion: currentUpdateStatus?.availableVersion,
          downloadProgress: 0,
        };
        renderSheetLayer(true);
        try {
          void triggerDownloadUpdate();
        } catch (err) {
          currentUpdateStatus = {
            state: "error",
            currentVersion: currentUpdateStatus?.currentVersion ?? "0.1.0-preview.2",
            errorMessage: err instanceof Error ? err.message : String(err),
          };
          renderSheetLayer(true);
          return;
        }
        if (updatePollTimer) clearInterval(updatePollTimer);
        updatePollTimer = window.setInterval(async () => {
          try {
            currentUpdateStatus = await fetchUpdateStatus();
            renderSheetLayer(true);
            if (currentUpdateStatus.state !== "downloading") {
              if (updatePollTimer) {
                clearInterval(updatePollTimer);
                updatePollTimer = null;
              }
            }
          } catch {
            if (updatePollTimer) {
              clearInterval(updatePollTimer);
              updatePollTimer = null;
            }
          }
        }, 500);
      })();
      break;
    case "install-update":
      void (async () => {
        try {
          await triggerInstallUpdate();
        } catch (err) {
          console.error("[updater] Install update failed:", err);
        }
      })();
      break;
    case "dismiss-update":
      closeSheet();
      break;
    case "close-sheet":
      closeSheet();
      break;
    case "backdrop":
      if (e.target === target) closeSheet();
      break;
    case "stop-import":
      cancelImportRequested = true;
      break;
    case "retry":
      void refreshBuilds(false);
      break;
    case "play": {
      const build = activeBuild();
      if (build?.playReady) void startPlayMode(build);
      break;
    }
    case "exit-play":
      exitPlayMode();
      break;
    case "toggle-play-menu":
      togglePlayMenu(!state.playMenuOpen);
      break;
    case "restart-play": {
      const build = activeBuild();
      if (build) void startPlayMode(build, true);
      break;
    }
    case "toggle-fullscreen": {
      const host = document.getElementById("player-host");
      if (document.fullscreenElement && document.exitFullscreen) {
        void document.exitFullscreen().catch(() => {});
      } else if (host?.requestFullscreen) {
        void host.requestFullscreen().catch(() => {});
      }
      break;
    }
    case "remove-build":
      openSheet({ kind: "details", confirmRemove: true });
      break;
    case "remove-build-cancel":
      openSheet({ kind: "details", confirmRemove: false });
      break;
    case "remove-build-confirm": {
      const build = activeBuild();
      if (!build) break;
      void (async () => {
        const name = build.displayName;
        await deleteBuild(build.buildId);
        state.sheet = null;
        renderSheetLayer(true);
        await refreshBuilds(false);
        showToast(he.removed(name));
      })();
      break;
    }
    case "open-missing-log":
      dismissMissingToast();
      if (state.playMenuOpen) togglePlayMenu(false);
      openSheet({ kind: "missing-log" });
      break;
    case "open-room-revisions":
      if (state.playMenuOpen) togglePlayMenu(false);
      openSheet({ kind: "room-revisions" });
      break;
    case "dismiss-missing-toast":
      dismissMissingToast();
      break;
    case "copy-missing-log": {
      const text = state.missingAssets
        .map(
          (e) =>
            `[${e.category.toUpperCase()}] ${e.filename} (${e.count > 1 ? `×${e.count}, ` : ""}${e.timeFormatted})\n  Path: ${e.path}\n  Full URL: ${e.url}`,
        )
        .join("\n\n");
      if (navigator.clipboard?.writeText) {
        void navigator.clipboard.writeText(text).then(() => {
          showToast(he.copiedToClipboard);
        });
      }
      break;
    }
    case "clear-missing-log":
      state.missingAssets = [];
      updatePlayMissingChip();
      renderSheetLayer(true);
      break;
  }
});

app.addEventListener("change", (e) => {
  const target = e.target as HTMLElement | null;
  if (target?.matches("[data-action='change-room-revision']")) {
    const select = target as HTMLSelectElement;
    const roomId = Number(select.dataset.roomId);
    const revisionKey = select.value || null;
    const build = activeBuild();
    if (build && roomId) {
      void fetch(`/api/builds/${encodeURIComponent(build.buildId)}/rooms/${roomId}/select-revision`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ revisionKey }),
      })
        .then((r) => r.json())
        .then((res) => {
          if (res.manifest && state.data) {
            const idx = state.data.installed.findIndex((b) => b.buildId === build.buildId);
            if (idx >= 0) {
              state.data.installed[idx] = res.manifest;
            }
          }
          showToast(he.roomRevisionNotice);
        })
        .catch((err) => {
          console.error("Failed to select room revision", err);
        });
    }
    return;
  }

  const input = e.target as HTMLInputElement | null;
  if (!input?.dataset.pref) return;
  if (input.dataset.pref === "fullscreen") {
    state.preferFullscreen = input.checked;
    localStorage.setItem("localgobe:fullscreen", String(state.preferFullscreen));
  } else if (input.dataset.pref === "diagnostics") {
    state.diagnosticsEnabled = input.checked;
    localStorage.setItem("localgobe:diagnostics", String(state.diagnosticsEnabled));
  }
});

// Keyboard accessibility: Escape closes sheets/menus; arrow keys move through category radios
window.addEventListener("keydown", (e) => {
  if (e.key === "Escape") {
    if (state.playMenuOpen) {
      togglePlayMenu(false);
      return;
    }
    if (state.sheet && sheetDismissible(state.sheet)) {
      closeSheet();
      return;
    }
  }

  if (state.sheet?.kind === "add" && (e.key === "ArrowLeft" || e.key === "ArrowRight" || e.key === "ArrowUp" || e.key === "ArrowDown")) {
    const radios = Array.from(sheetLayer.querySelectorAll<HTMLButtonElement>('[role="radio"]'));
    const idx = radios.indexOf(document.activeElement as HTMLButtonElement);
    if (idx >= 0 && radios.length > 0) {
      e.preventDefault();
      // In RTL, ArrowLeft advances visually to the next tile, ArrowRight goes back
      const delta = e.key === "ArrowLeft" || e.key === "ArrowDown" ? 1 : -1;
      const next = radios[(idx + delta + radios.length) % radios.length];
      const ctx = (next.dataset.context as ContentContext) || "all";
      state.sheet = { kind: "add", context: ctx };
      renderSheetLayer(true);
      sheetLayer.querySelector<HTMLButtonElement>(`[data-context="${ctx}"]`)?.focus();
    }
  }
});

// ───────────────────────── Global Drag & Drop ─────────────────────────

function hasFiles(dt: DataTransfer | null): boolean {
  if (!dt) return false;
  return Array.from(dt.types ?? []).includes("Files");
}

window.addEventListener("dragenter", (e) => {
  if (state.mode === "play" || isBusy(state.sheet) || !hasFiles(e.dataTransfer)) return;
  e.preventDefault();
  dragDepth++;
  if (!state.dragActive) {
    state.dragActive = true;
    renderOverlays();
  }
});

window.addEventListener("dragover", (e) => {
  if (state.mode === "play" || isBusy(state.sheet) || !hasFiles(e.dataTransfer)) return;
  e.preventDefault();
  if (e.dataTransfer) e.dataTransfer.dropEffect = "copy";
});

window.addEventListener("dragleave", (e) => {
  if (!state.dragActive) return;
  e.preventDefault();
  dragDepth = Math.max(0, dragDepth - 1);
  if (dragDepth === 0) {
    state.dragActive = false;
    renderOverlays();
  }
});

window.addEventListener("drop", (e) => {
  if (state.mode === "play" || isBusy(state.sheet)) return;
  e.preventDefault();
  dragDepth = 0;
  if (state.dragActive) {
    state.dragActive = false;
    renderOverlays();
  }
  if (!e.dataTransfer) return;

  const context: ContentContext = state.sheet?.kind === "add" ? state.sheet.context : "all";
  const build = activeBuild();

  // Show collecting feedback immediately if a build exists (large folders can take a moment to walk)
  const dt = e.dataTransfer;
  void (async () => {
    let collectingTimer: number | null = null;
    if (build) {
      collectingTimer = window.setTimeout(() => {
        const session = createImportSession(context, build, 0);
        openSheet({ kind: "import", session, id: importRunId + 1 });
      }, 140);
    }

    const dropped = await collectDroppedFiles(dt);
    if (collectingTimer !== null) window.clearTimeout(collectingTimer);

    const route = routeDroppedFiles(
      dropped.map((d) => d.file.name),
      Boolean(build),
    );

    if (route.kind === "empty") {
      if (state.sheet?.kind === "import" && state.sheet.session.phase === "collecting") {
        state.sheet = null;
        renderSheetLayer(true);
      }
      return;
    }
    if (route.kind === "apk") {
      await handleApkImport(dropped[route.index].file);
      return;
    }
    if (route.kind === "need-apk") {
      openSheet({ kind: "need-apk" });
      return;
    }
    const entries = route.indices.map((idx) => dropped[idx]);
    // If we already opened the collecting sheet, smoothly transition to importing
    if (state.sheet?.kind === "import" && state.sheet.session.phase === "collecting") {
      state.sheet = { ...state.sheet, session: beginImporting(state.sheet.session, entries.length) };
    }
    await handleExternalFilesImport(entries, context);
  })();
});

// Boot
setupMissingAssetInterceptor();
renderScreenLayer(true);
void refreshBuilds(false);
