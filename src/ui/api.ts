import type { InstalledBuildManifest } from "../storage/manifest-generator.ts";
import type { ApkImportResult, ExternalImportSummary } from "../importer/types.ts";
import type { BuildRuntimeConfig } from "../builds/types.ts";

export type BuildsListResponse = {
  installed: InstalledBuildManifest[];
  supported: Array<{ buildId: string; displayName: string; sourceType: string }>;
  activeBuildId: string;
  runtime: {
    ruffle: { ready: boolean; directory: string };
    airShims: { ready: boolean; directory: string; present: string[]; missing: string[] };
    smartFoxReady: boolean;
    dataDir: string;
  };
};

export type RuntimeConfigResponse = {
  buildId: string;
  displayName: string;
  playReady: boolean;
  runtimeConfig: BuildRuntimeConfig;
};

export async function fetchBuilds(): Promise<BuildsListResponse> {
  const res = await fetch("/api/builds");
  if (!res.ok) throw new Error(`Failed to load builds (${res.status})`);
  return (await res.json()) as BuildsListResponse;
}

export async function uploadApk(file: File): Promise<ApkImportResult> {
  const buffer = await file.arrayBuffer();
  const res = await fetch("/api/import/apk", {
    method: "POST",
    headers: {
      "Content-Type": "application/octet-stream",
      "X-File-Name": encodeURIComponent(file.name),
    },
    body: buffer,
  });
  return (await res.json()) as ApkImportResult;
}

export async function uploadExternalFile(
  buildId: string,
  relativePath: string,
  file: File,
): Promise<ExternalImportSummary> {
  const buffer = await file.arrayBuffer();
  const res = await fetch("/api/import/file", {
    method: "POST",
    headers: {
      "Content-Type": "application/octet-stream",
      "X-Build-Id": buildId,
      "X-Relative-Path": encodeURIComponent(relativePath),
    },
    body: buffer,
  });
  if (!res.ok) {
    const err = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(err.error ?? `Import failed (${res.status})`);
  }
  return (await res.json()) as ExternalImportSummary;
}

export async function fetchRuntimeConfig(buildId: string): Promise<RuntimeConfigResponse> {
  const res = await fetch(`/api/builds/${encodeURIComponent(buildId)}/runtime-config`);
  if (!res.ok) throw new Error(`Failed to get runtime config (${res.status})`);
  return (await res.json()) as RuntimeConfigResponse;
}

export async function deleteBuild(buildId: string): Promise<void> {
  const res = await fetch(`/api/builds/${encodeURIComponent(buildId)}`, { method: "DELETE" });
  if (!res.ok) throw new Error(`Failed to remove build (${res.status})`);
}

export type UpdateStatusResponse = {
  state: "idle" | "checking" | "available" | "not-available" | "downloading" | "downloaded" | "error";
  currentVersion: string;
  availableVersion?: string;
  downloadProgress?: number;
  errorMessage?: string;
};

export async function fetchUpdateStatus(): Promise<UpdateStatusResponse> {
  const res = await fetch("/api/updates/status");
  if (!res.ok) throw new Error(`Failed to get update status (${res.status})`);
  return (await res.json()) as UpdateStatusResponse;
}

export async function triggerCheckUpdates(): Promise<UpdateStatusResponse> {
  const res = await fetch("/api/updates/check", { method: "POST" });
  if (!res.ok) throw new Error(`Failed to check for updates (${res.status})`);
  return (await res.json()) as UpdateStatusResponse;
}

export async function triggerDownloadUpdate(): Promise<UpdateStatusResponse> {
  const res = await fetch("/api/updates/download", { method: "POST" });
  if (!res.ok) throw new Error(`Failed to download update (${res.status})`);
  return (await res.json()) as UpdateStatusResponse;
}

export async function triggerInstallUpdate(): Promise<void> {
  await fetch("/api/updates/install", { method: "POST" });
}
