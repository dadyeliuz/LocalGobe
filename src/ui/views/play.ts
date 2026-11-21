import { icon } from "../art.ts";
import { esc } from "../html.ts";
import { he } from "../i18n/he.ts";
import { CONTEXT_COPY, type ContentContext } from "../model.ts";

export type MissingToastState = {
  filename: string;
  categoryLabel: string;
  batchCount: number;
  timestamp: number;
};

export function renderPlayScreen(opts: {
  displayName: string;
  menuOpen: boolean;
  entering: boolean;
  missingCount?: number;
}): string {
  const missingCount = opts.missingCount ?? 0;
  return `<div class="screen screen-play" data-screen="play">
    <header class="play-chrome">
      <div class="play-chrome-start">
        <button type="button" class="play-chip play-back" data-action="exit-play">
          ${icon("back")}<span>${esc(he.back)}</span>
        </button>
        <span class="play-title" lang="en" dir="ltr">${esc(opts.displayName)}</span>
      </div>
      <div class="play-chrome-end">
        <button
          type="button"
          class="play-chip play-room-revisions-chip"
          data-action="open-room-revisions"
          title="${esc(he.roomRevisions)}"
          aria-label="${esc(he.roomRevisions)}"
        >
          ${icon("folder")}<span>${esc(he.roomRevisions)}</span>
        </button>
        <button
          type="button"
          class="play-chip play-missing-chip ${missingCount > 0 ? "has-missing" : ""}"
          data-action="open-missing-log"
          title="${esc(he.missingAssetsLog)}"
          aria-label="${esc(he.missingAssetsLog)}"
        >
          ${icon("alert")}<span>${esc(he.missingAssetsTitle)}</span>${missingCount > 0 ? `<span class="play-chip-badge">${missingCount}</span>` : ""}
        </button>
        <button type="button" class="play-chip" data-action="toggle-fullscreen">
          ${icon("fullscreen")}<span>${esc(he.fullscreen)}</span>
        </button>
        <div class="play-menu-wrap">
          <button
            type="button"
            class="play-chip play-chip-icon"
            data-action="toggle-play-menu"
            aria-label="${esc(he.more)}"
            aria-haspopup="menu"
            aria-expanded="${opts.menuOpen}"
          >${icon("more")}</button>
          ${
            opts.menuOpen
              ? `<div class="play-menu" role="menu">
                  <button type="button" class="play-menu-item" role="menuitem" data-action="open-room-revisions">
                    ${icon("folder")}<span>${esc(he.roomRevisions)}</span>
                  </button>
                  <button type="button" class="play-menu-item" role="menuitem" data-action="open-missing-log">
                    ${icon("alert")}<span>${esc(he.missingAssetsLog)}${missingCount > 0 ? ` (${missingCount})` : ""}</span>
                  </button>
                  <button type="button" class="play-menu-item" role="menuitem" data-action="restart-play">
                    ${icon("refresh")}<span>${esc(he.restartGame)}</span>
                  </button>
                  <button type="button" class="play-menu-item" role="menuitem" data-action="exit-play">
                    ${icon("back")}<span>${esc(he.backToLauncher)}</span>
                  </button>
                </div>`
              : ""
          }
        </div>
      </div>
    </header>
    <main class="play-stage" id="main">
      <div class="stage-frame">
        <div id="player-host" class="player-host" aria-label="${esc(he.gameName)}">
          ${
            opts.entering
              ? `<div class="player-loading">
                  <div class="portal-spinner is-dark" aria-hidden="true"><span></span><span></span><span></span></div>
                  <p>${esc(he.enteringWorld)}</p>
                </div>`
              : ""
          }
        </div>
      </div>
    </main>
  </div>`;
}

export function renderPlayError(displayName: string, detail: string): string {
  return `<div class="player-error" role="alert">
    <p class="player-error-title">${esc(he.playErrorTitle)}</p>
    <p class="player-error-sub">${esc(he.playErrorSub)}</p>
    ${detail ? `<p class="player-error-detail" dir="ltr" lang="en">${esc(detail)}</p>` : ""}
    <div class="player-error-actions">
      <button type="button" class="btn btn-primary btn-sm" data-action="restart-play">${icon("refresh")}<span>${esc(he.retry)}</span></button>
      <button type="button" class="btn btn-quiet-dark btn-sm" data-action="exit-play">${esc(he.backToLauncher)}</button>
    </div>
    <span class="sr-only">${esc(displayName)}</span>
  </div>`;
}

export function renderDropOverlay(opts: {
  active: boolean;
  hasBuild: boolean;
  context: ContentContext;
}): string {
  if (!opts.active) return "";
  const title = opts.hasBuild ? CONTEXT_COPY[opts.context].overlayTitle : he.dropTitleApk;
  const sub = opts.hasBuild ? he.dropSubFiles : he.dropSubApk;
  const tone = opts.hasBuild ? CONTEXT_COPY[opts.context].tone : "sky";
  return `<div class="drop-overlay" data-tone="${tone}" role="status" aria-live="polite">
    <div class="drop-overlay-card">
      <div class="drop-overlay-ring" aria-hidden="true">${icon("drop")}</div>
      <p class="drop-overlay-title">${esc(title)}</p>
      <p class="drop-overlay-sub">${esc(sub)}</p>
    </div>
  </div>`;
}

export function renderPortalTransition(active: boolean): string {
  if (!active) return "";
  return `<div class="portal-transition" aria-hidden="true">
    <div class="portal-transition-ring"></div>
    <p class="portal-transition-label">${esc(he.enteringWorld)}</p>
  </div>`;
}

export function renderToast(text: string | null): string {
  if (!text) return "";
  return `<div class="toast" role="status" aria-live="polite">
    ${icon("check")}<span>${esc(text)}</span>
  </div>`;
}

export function renderMissingAssetToast(toast: MissingToastState | null): string {
  if (!toast) return "";
  const label =
    toast.batchCount > 1
      ? he.missingAssetsBatchToast(toast.batchCount, toast.filename)
      : he.missingAssetToast(toast.filename, toast.categoryLabel);
  return `<aside class="missing-asset-toast" role="status" aria-live="polite">
    <div class="missing-toast-body">
      <span class="missing-toast-icon" aria-hidden="true">${icon("alert")}</span>
      <div class="missing-toast-info">
        <p class="missing-toast-text">${esc(label)}</p>
        <span class="missing-toast-sub">${esc(he.missingAssetsTitle)} (404)</span>
      </div>
      <button type="button" class="btn btn-sm missing-toast-action" data-action="open-missing-log">
        ${esc(he.viewLog)}
      </button>
      <button type="button" class="missing-toast-dismiss" data-action="dismiss-missing-toast" aria-label="${esc(he.close)}">
        ${icon("close")}
      </button>
    </div>
  </aside>`;
}
