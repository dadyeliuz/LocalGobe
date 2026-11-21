import { readFileSync } from "node:fs";
import { join } from "node:path";
import { getProjectRoot } from "../storage/paths.ts";

export type UpdateState =
  | "idle"
  | "checking"
  | "available"
  | "not-available"
  | "downloading"
  | "downloaded"
  | "error";

export type UpdateStatus = {
  state: UpdateState;
  currentVersion: string;
  availableVersion?: string;
  downloadProgress?: number;
  errorMessage?: string;
};

export interface IUpdateService {
  getStatus(): UpdateStatus;
  checkForUpdates(): Promise<UpdateStatus>;
  downloadUpdate(): Promise<void>;
  quitAndInstall(): Promise<void>;
}

export const GITHUB_UPDATE_CONFIG = Object.freeze({
  provider: "github" as const,
  owner: "dadyeliuz",
  repo: "LocalGobe",
});

export function getAppVersion(): string {
  try {
    const pkgPath = join(getProjectRoot(), "package.json");
    const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as { version?: string };
    return pkg.version ?? "0.1.0-preview.2";
  } catch {
    return "0.1.0-preview.2";
  }
}

export type UpdaterOptions = {
  currentVersion?: string;
  autoCheckDelayMs?: number;
  autoCheck?: boolean;
  onBeforeQuitAndInstall?: () => Promise<void>;
  backend?: any;
};

export class LocalGobeUpdater implements IUpdateService {
  private state: UpdateState = "idle";
  private currentVersion: string;
  private availableVersion?: string;
  private downloadProgress?: number;
  private errorMessage?: string;
  private backend: any = null;
  private onBeforeQuitAndInstall?: () => Promise<void>;

  constructor(options: UpdaterOptions = {}) {
    this.currentVersion = options.currentVersion ?? getAppVersion();
    this.onBeforeQuitAndInstall = options.onBeforeQuitAndInstall;

    if (options.backend) {
      this.backend = options.backend;
      this.attachBackendEvents();
    } else if (typeof process !== "undefined" && process.versions?.electron) {
      this.initElectronUpdater();
    }

    if (options.autoCheck !== false && this.backend) {
      const delay = options.autoCheckDelayMs ?? 4000;
      setTimeout(() => {
        void this.checkForUpdates().catch(() => {
          // Quiet background check failure
        });
      }, delay);
    }
  }

  private async initElectronUpdater(): Promise<void> {
    try {
      const { autoUpdater } = await import("electron-updater");
      this.backend = autoUpdater;
      this.backend.setFeedURL(GITHUB_UPDATE_CONFIG);
      this.backend.autoDownload = false;
      this.backend.autoInstallOnAppQuit = false;
      this.backend.allowDowngrade = false;
      this.backend.allowPrerelease = true;

      // Unsigned OTA security mode: relax Authenticode signature check for unsigned setup binaries,
      // while enforcing cryptographic SHA-512 blockmap and latest.yml hash integrity verification.
      this.backend.verifyUpdateCodeSignature = false;

      this.attachBackendEvents();
    } catch (err) {
      console.warn("[updater] Could not initialize electron-updater:", err);
    }
  }

  private attachBackendEvents(): void {
    if (!this.backend || typeof this.backend.on !== "function") return;

    this.backend.on("checking-for-update", () => {
      this.state = "checking";
      this.errorMessage = undefined;
    });

    this.backend.on("update-available", (info: { version: string }) => {
      this.state = "available";
      this.availableVersion = info.version;
      this.errorMessage = undefined;
    });

    this.backend.on("update-not-available", () => {
      this.state = "not-available";
      this.errorMessage = undefined;
    });

    this.backend.on("download-progress", (progress: { percent: number }) => {
      this.state = "downloading";
      this.downloadProgress = Math.round(progress.percent);
      this.errorMessage = undefined;
    });

    this.backend.on("update-downloaded", (info: { version: string }) => {
      this.state = "downloaded";
      this.availableVersion = info.version;
      this.downloadProgress = 100;
      this.errorMessage = undefined;
    });

    this.backend.on("error", (err: Error) => {
      this.state = "error";
      this.errorMessage = err?.message || String(err);
    });
  }

  getStatus(): UpdateStatus {
    return {
      state: this.state,
      currentVersion: this.currentVersion,
      availableVersion: this.availableVersion,
      downloadProgress: this.downloadProgress,
      errorMessage: this.errorMessage,
    };
  }

  async checkForUpdates(): Promise<UpdateStatus> {
    if (!this.backend) {
      this.state = "not-available";
      return this.getStatus();
    }
    this.state = "checking";
    this.errorMessage = undefined;
    try {
      await this.backend.checkForUpdates();
    } catch (err) {
      this.state = "error";
      this.errorMessage = err instanceof Error ? err.message : String(err);
    }
    return this.getStatus();
  }

  async downloadUpdate(): Promise<void> {
    if (!this.backend) {
      throw new Error("No updater backend available");
    }
    this.state = "downloading";
    this.downloadProgress = 0;
    this.errorMessage = undefined;
    try {
      await this.backend.downloadUpdate();
    } catch (err) {
      this.state = "error";
      this.errorMessage = err instanceof Error ? err.message : String(err);
      throw err;
    }
  }

  async quitAndInstall(): Promise<void> {
    if (this.onBeforeQuitAndInstall) {
      await this.onBeforeQuitAndInstall();
    }
    if (this.backend && typeof this.backend.quitAndInstall === "function") {
      // isSilent: false, isForceRunAfter: true (relaunches app automatically)
      this.backend.quitAndInstall(false, true);
    }
  }
}

let activeUpdater: IUpdateService | null = null;

export function getActiveUpdater(): IUpdateService {
  if (!activeUpdater) {
    activeUpdater = new LocalGobeUpdater();
  }
  return activeUpdater;
}

export function setActiveUpdater(updater: IUpdateService | null): void {
  activeUpdater = updater;
}
