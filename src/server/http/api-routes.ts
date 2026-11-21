import { existsSync, statSync } from "node:fs";
import { join } from "node:path";
import { getBuildDefinition, listSupportedBuilds } from "../../builds/registry.ts";
import { getAirShimsStatus } from "../../compatibility/air/air-shims.ts";
import { importApkBuffer } from "../../importer/apk-importer.ts";
import { importExternalFiles, reconcileUnclassifiedAssets } from "../../importer/file-importer.ts";
import {
  deleteInstalledBuild,
  listInstalledBuilds,
  readBuildManifest,
  refreshBuildManifest,
} from "../../storage/build-store.ts";
import {
  getRoomPlayableRevisions,
  getSelectedRoomRevision,
  setRoomRevisionSelection,
} from "../../storage/room-resolver.ts";
import { getDataRoot, getRuffleDistDir } from "../../storage/paths.ts";
import { getActiveUpdater, type IUpdateService } from "../../desktop/updater.ts";

export type HttpResponse = {
  status: number;
  mime: string;
  body: Buffer | string;
  headers?: Record<string, string>;
};

function json(status: number, payload: unknown): HttpResponse {
  return {
    status,
    mime: "application/json; charset=utf-8",
    body: JSON.stringify(payload),
  };
}

export function getRuffleRuntimeStatus(dataDir?: string): { ready: boolean; directory: string } {
  const dir = getRuffleDistDir(dataDir);
  const ready = existsSync(join(dir, "ruffle.js")) && statSync(join(dir, "ruffle.js")).isFile();
  return { ready, directory: dir };
}

export function handleApiRoute(options: {
  method: string;
  pathname: string;
  query: URLSearchParams;
  headers: Record<string, string | string[] | undefined>;
  body: Buffer;
  origin: string;
  dataDir?: string;
  smartFoxReady?: boolean;
  activeBuildId: string;
  setActiveBuildId: (buildId: string) => void;
  updater?: IUpdateService;
}): HttpResponse | null {
  const { method, pathname, headers, body, origin, dataDir } = options;
  if (!pathname.startsWith("/api/")) return null;

  // ── Updates routes ──
  if (method === "GET" && pathname === "/api/updates/status") {
    const updater = options.updater ?? getActiveUpdater();
    return json(200, updater.getStatus());
  }

  if (method === "POST" && pathname === "/api/updates/check") {
    const updater = options.updater ?? getActiveUpdater();
    void updater.checkForUpdates();
    return json(200, updater.getStatus());
  }

  if (method === "POST" && pathname === "/api/updates/download") {
    const updater = options.updater ?? getActiveUpdater();
    void updater.downloadUpdate();
    return json(200, updater.getStatus());
  }

  if (method === "POST" && pathname === "/api/updates/install") {
    const updater = options.updater ?? getActiveUpdater();
    setTimeout(() => {
      void updater.quitAndInstall().catch((err) => {
        console.error("[updater] quitAndInstall failed:", err);
      });
    }, 100);
    return json(200, { ok: true, message: "Restarting and updating..." });
  }

  // GET /api/builds
  if (method === "GET" && pathname === "/api/builds") {
    const installed = listInstalledBuilds(dataDir).map((b) => {
      reconcileUnclassifiedAssets(b.buildId, { dataDir });
      return refreshBuildManifest(b.buildId, dataDir) ?? b;
    });
    const supported = listSupportedBuilds().map((b) => ({
      buildId: b.buildId,
      displayName: b.displayName,
      sourceType: b.sourceType,
    }));
    return json(200, {
      installed,
      supported,
      activeBuildId: options.activeBuildId,
      runtime: {
        ruffle: getRuffleRuntimeStatus(dataDir),
        airShims: getAirShimsStatus(dataDir),
        smartFoxReady: options.smartFoxReady ?? true,
        dataDir: getDataRoot(dataDir),
      },
    });
  }

  // GET /api/runtime/status
  if (method === "GET" && pathname === "/api/runtime/status") {
    return json(200, {
      ruffle: getRuffleRuntimeStatus(dataDir),
      airShims: getAirShimsStatus(dataDir),
      smartFoxReady: options.smartFoxReady ?? true,
      dataDir: getDataRoot(dataDir),
    });
  }

  // POST /api/import/apk
  if (method === "POST" && pathname === "/api/import/apk") {
    if (body.length === 0) {
      return json(400, {
        ok: false,
        code: "INVALID_ARCHIVE",
        userMessage: "No APK file was received.",
      });
    }
    const result = importApkBuffer(body, { dataDir });
    if (result.ok) {
      options.setActiveBuildId(result.buildId);
      return json(200, result);
    }
    const status = result.code === "SECURITY_VIOLATION" ? 400 : 422;
    return json(status, result);
  }

  // POST /api/import/file
  if (method === "POST" && pathname === "/api/import/file") {
    const rawBuildId = String(headers["x-build-id"] ?? options.activeBuildId ?? "");
    const rawRelPath = String(headers["x-relative-path"] ?? "");
    let relativePath = rawRelPath;
    try {
      relativePath = decodeURIComponent(rawRelPath);
    } catch {
      // keep raw
    }
    if (!rawBuildId || !relativePath) {
      return json(400, { error: "Missing buildId or relativePath header" });
    }
    try {
      const summary = importExternalFiles(rawBuildId, [{ relativePath, bytes: body }], { dataDir });
      return json(200, summary);
    } catch (err) {
      return json(400, { error: err instanceof Error ? err.message : String(err) });
    }
  }

  // /api/builds/:buildId/rooms/:roomId/(revisions|select-revision)
  const roomRevMatch = /^\/api\/builds\/([A-Za-z0-9._-]+)\/rooms\/(\d+)\/(revisions|select-revision)$/.exec(pathname);
  if (roomRevMatch) {
    const buildId = roomRevMatch[1];
    const roomId = Number(roomRevMatch[2]);
    const action = roomRevMatch[3];

    if (method === "GET" && action === "revisions") {
      const playable = getRoomPlayableRevisions(buildId, roomId, dataDir);
      const selectedKey = getSelectedRoomRevision(buildId, roomId, dataDir);
      const recommendedKey = playable.find((p) => p.isRecommended)?.revisionKey ?? null;
      return json(200, {
        roomId,
        selectedRevisionKey: selectedKey,
        recommendedRevisionKey: recommendedKey,
        revisions: playable,
      });
    }

    if (method === "POST" && action === "select-revision") {
      try {
        const parsed = JSON.parse(body.toString("utf8") || "{}");
        const rawKey = parsed.revisionKey;
        const revisionKey = typeof rawKey === "string" && rawKey.trim() !== "" && rawKey !== "auto" ? rawKey : null;
        setRoomRevisionSelection(buildId, roomId, revisionKey, dataDir);
        const updatedManifest = refreshBuildManifest(buildId, dataDir);
        return json(200, {
          ok: true,
          roomId,
          selectedRevisionKey: revisionKey,
          manifest: updatedManifest,
        });
      } catch (err) {
        return json(400, { error: "Invalid JSON body" });
      }
    }
  }

  // /api/builds/:buildId routes
  const buildMatch = /^\/api\/builds\/([A-Za-z0-9._-]+)(?:\/(select|runtime-config))?$/.exec(pathname);
  if (buildMatch) {
    const buildId = buildMatch[1];
    const subAction = buildMatch[2];

    if (method === "GET" && !subAction) {
      const manifest = refreshBuildManifest(buildId, dataDir);
      if (!manifest) return json(404, { error: "Build not installed" });
      return json(200, manifest);
    }

    if (method === "GET" && subAction === "runtime-config") {
      const def = getBuildDefinition(buildId);
      const manifest = readBuildManifest(buildId, dataDir);
      if (!def || !manifest) return json(404, { error: "Build not installed" });
      options.setActiveBuildId(buildId);
      return json(200, {
        buildId,
        displayName: manifest.displayName,
        playReady: manifest.playReady,
        runtimeConfig: def.getRuntimeConfig(origin),
      });
    }

    if (method === "POST" && subAction === "select") {
      const manifest = readBuildManifest(buildId, dataDir);
      if (!manifest) return json(404, { error: "Build not installed" });
      options.setActiveBuildId(buildId);
      return json(200, { ok: true, activeBuildId: buildId });
    }

    if (method === "DELETE" && !subAction) {
      const deleted = deleteInstalledBuild(buildId, dataDir);
      if (!deleted) return json(404, { error: "Build not found" });
      return json(200, { ok: true, deletedBuildId: buildId });
    }
  }

  return json(404, { error: "API route not found" });
}
