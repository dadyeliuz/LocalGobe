import type { InstalledBuildManifest } from "../../storage/manifest-generator.ts";
import { icon, type IconName } from "../art.ts";
import { esc, num } from "../html.ts";
import { apkErrorMessage, he, miniGameStateLabel, nounFor, type NounKey } from "../i18n/he.ts";
import {
  CONTENT_CONTEXTS,
  CONTEXT_COPY,
  countsOf,
  type ContentContext,
  type ContentCounts,
  type MissingAssetEntry,
} from "../model.ts";
import {
  sessionDeltas,
  sessionProgress,
  summarizeOutcome,
  type ImportSession,
  type IncompleteRoomInfo,
  type OutcomeStat,
} from "../import-session.ts";
import type { Sheet } from "../ui-state.ts";
import type { UpdateStatusResponse } from "../api.ts";

export type SheetContext = {
  build: InstalledBuildManifest | null;
  runtime: {
    ruffleReady: boolean;
    airShimsReady: boolean;
    smartFoxReady: boolean;
    dataDir: string;
  } | null;
  prefs: { fullscreen: boolean; diagnostics: boolean };
  lastUnknownFiles: string[];
  missingAssets?: MissingAssetEntry[];
  updateStatus?: UpdateStatusResponse | null;
};

const CONTEXT_ICON: Record<ContentContext, IconName> = {
  all: "sparkle",
  world: "room",
  items: "item",
  miniGames: "game",
  interface: "interface",
};

const NOUN_ICON: Record<NounKey, IconName> = {
  room: "room",
  item: "item",
  game: "game",
  music: "music",
  interfaceFile: "interface",
  language: "interface",
  chatLanguage: "interface",
  file: "files",
};

const NOUN_TONE: Record<NounKey, string> = {
  room: "coral",
  item: "pink",
  game: "grape",
  music: "sun",
  interfaceFile: "teal",
  language: "teal",
  chatLanguage: "teal",
  file: "sky",
};

function frame(opts: { cls: string; title: string; body: string; dismissible: boolean; labelledBy?: string; tone?: string }): string {
  const titleId = opts.labelledBy ?? "sheet-title";
  return `<div class="sheet-backdrop" data-action="${opts.dismissible ? "backdrop" : ""}">
    <section class="sheet ${opts.cls}" role="dialog" aria-modal="true" aria-labelledby="${titleId}" ${opts.tone ? `data-tone="${opts.tone}"` : ""}>
      ${opts.dismissible ? `<button type="button" class="icon-btn sheet-close" data-action="close-sheet" aria-label="${esc(he.close)}">${icon("close")}</button>` : ""}
      ${opts.title ? `<h2 class="sheet-title" id="${titleId}">${opts.title}</h2>` : ""}
      ${opts.body}
    </section>
  </div>`;
}

// ───────────────────────── Add content ─────────────────────────

function contextCountLabel(ctx: ContentContext, counts: ContentCounts, interfaceReady: boolean): string {
  switch (ctx) {
    case "world":
      return `${num(counts.rooms)} ${nounFor("room", counts.rooms)}`;
    case "items":
      return counts.items > 0 ? `${num(counts.items)} ${nounFor("item", counts.items)}` : "עדיין ריק";
    case "miniGames":
      return counts.games > 0 ? `${num(counts.games)} ${nounFor("game", counts.games)}` : "עדיין ריק";
    case "interface":
      return interfaceReady ? he.interfaceReady : "";
    case "all":
    default:
      return "זיהוי אוטומטי";
  }
}

export function renderAddSheet(context: ContentContext, ctx: SheetContext): string {
  const counts = countsOf(ctx.build);
  const interfaceReady = ctx.build?.categories.interface.ready ?? false;
  const copy = CONTEXT_COPY[context];
  const tiles = CONTENT_CONTEXTS.map((c) => {
    const cc = CONTEXT_COPY[c];
    const selected = c === context;
    return `<button type="button" class="ctx-tile ${selected ? "is-selected" : ""}" role="radio" aria-checked="${selected}" data-tone="${cc.tone}" data-action="set-context" data-context="${c}" ${selected ? "tabindex=\"0\"" : 'tabindex="-1"'}>
      <span class="ctx-tile-icon">${icon(CONTEXT_ICON[c])}</span>
      <span class="ctx-tile-text"><span class="ctx-tile-title">${esc(cc.title)}</span><span class="ctx-tile-meta">${esc(contextCountLabel(c, counts, interfaceReady))}</span></span>
    </button>`;
  }).join("");

  const body = `
    <p class="sheet-lead">אפשר להוסיף תוכן מתי שרוצים — העולם שלך ממשיך לגדול.</p>
    <div class="add-layout">
      <div class="ctx-tiles" role="radiogroup" aria-label="סוג התוכן">${tiles}</div>
      <div class="dropzone" data-tone="${copy.tone}" data-drop-context="${context}">
        <div class="dropzone-art" aria-hidden="true">
          <span class="dropzone-blob">${icon(CONTEXT_ICON[context])}</span>
          <span class="dropzone-arrow">${icon("drop")}</span>
        </div>
        <h3 class="dropzone-title">${esc(copy.dropTitle)}</h3>
        <p class="dropzone-sub">${esc(copy.dropSub)}</p>
        <div class="dropzone-actions">
          <button type="button" class="btn btn-primary" data-action="pick-folder" data-context="${context}" data-autofocus>${icon("folder")}<span>${esc(he.chooseFolder)}</span></button>
          <button type="button" class="btn btn-secondary" data-action="pick-files" data-context="${context}">${icon("files")}<span>${esc(he.chooseFiles)}</span></button>
        </div>
      </div>
    </div>
    <p class="sheet-note">${icon("sparkle")}<span>${esc(he.addSheetAnyNote)}</span></p>`;

  return frame({
    cls: "sheet-add",
    title: esc(he.addSheetTitle),
    body,
    dismissible: true,
    tone: copy.tone,
  });
}

// ───────────────────────── Import progress / result ─────────────────────────

function foundChips(session: ImportSession): string {
  const d = sessionDeltas(session);
  const chips: Array<{ key: NounKey; n: number; countKey: keyof ContentCounts }> = [
    { key: "room", n: d.rooms, countKey: "rooms" },
    { key: "item", n: d.items, countKey: "items" },
    { key: "game", n: d.games, countKey: "games" },
    { key: "music", n: d.music, countKey: "music" },
    { key: "interfaceFile", n: d.interfaceFiles, countKey: "interfaceFiles" },
  ];
  return chips
    .filter((c) => c.n > 0)
    .map(
      (c) => `<li class="found-chip" data-tone="${NOUN_TONE[c.key]}">${icon(NOUN_ICON[c.key])}<b class="count" data-count-key="found-${c.countKey}" data-count="${c.n}" data-count-from="0">${num(c.n)}</b><span>${esc(nounFor(c.key, c.n))}</span></li>`,
    )
    .join("");
}

export function importProgressParts(session: ImportSession): {
  percent: number;
  label: string;
  headline: string;
  seq: number;
  chips: string;
} {
  return {
    percent: Math.round(sessionProgress(session) * 100),
    label: session.total > 0 ? he.importProgress(session.processed, session.total) : "",
    headline: session.lastEvent?.text ?? "",
    seq: session.lastEvent?.seq ?? 0,
    chips: foundChips(session),
  };
}

function renderImporting(session: ImportSession): string {
  const collecting = session.phase === "collecting";
  const p = importProgressParts(session);
  const body = `
    <div class="import-live">
      <div class="portal-spinner" aria-hidden="true"><span></span><span></span><span></span></div>
      <p class="discovery" data-part="headline" data-seq="${p.seq}" aria-live="polite">${esc(p.headline)}</p>
      <div class="progress ${collecting ? "is-indeterminate" : ""}" role="progressbar" aria-label="${esc(he.importWorking)}" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${p.percent}" data-part="bar">
        <span class="progress-fill" style="width:${collecting ? 100 : p.percent}%"></span>
      </div>
      <p class="progress-label" data-part="label">${esc(p.label)}</p>
      <ul class="found-chips" data-part="chips" aria-live="polite">${p.chips}</ul>
      ${collecting ? "" : `<button type="button" class="btn btn-quiet btn-sm" data-action="stop-import">${esc(he.importStop)}</button>`}
    </div>`;
  return frame({
    cls: "sheet-import is-working",
    title: esc(collecting ? he.importCollecting : he.importWorking),
    body,
    dismissible: false,
  });
}

function resultStat(stat: OutcomeStat, sessionId: number): string {
  return `<li class="result-stat" data-tone="${NOUN_TONE[stat.key]}">
    <span class="result-icon">${icon(NOUN_ICON[stat.key])}</span>
    <span class="result-count"><b class="count" data-count-key="result-${sessionId}-${stat.key}" data-count="${stat.amount}" data-count-from="0">${num(stat.amount)}</b></span>
    <span class="result-noun">${esc(nounFor(stat.key, stat.amount))}</span>
    <span class="sr-only">${esc(stat.phrase)}</span>
  </li>`;
}

function incompleteRoomRow(r: IncompleteRoomInfo): string {
  const title = r.isBootstrap ? he.entryRoomTitle : `חדר ${r.roomId}`;
  const found = r.hasSwf ? `room_${r.roomId}.swf` : `room_${r.roomId}.txt`;
  const missing = r.hasSwf ? `room_${r.roomId}.txt` : `room_${r.roomId}.swf`;
  const missingKind = r.hasSwf ? "קובץ ההגדרות" : "קובץ החדר";
  return `<li class="incomplete-item">
    <div class="incomplete-head">
      <span class="incomplete-name">${icon("room")}<span>${esc(title)}</span></span>
      <span class="pill is-warn">חסר ${esc(missingKind)}</span>
    </div>
    <p class="incomplete-files">
      <span>נמצא <code dir="ltr" lang="en">${esc(found)}</code></span>
      <span> · </span>
      <span>עדיין חסר <code dir="ltr" lang="en">${esc(missing)}</code></span>
    </p>
  </li>`;
}

function renderImportDone(session: ImportSession, sessionId: number, playReady: boolean): string {
  const outcome = summarizeOutcome(session);
  let title: string;
  let lead = "";
  let art: string;
  if (outcome.kind === "added") {
    title = he.importDoneTitle;
    art = `<div class="success-burst" aria-hidden="true"><span class="burst-ring"></span>${icon("check")}</div>`;
  } else if (outcome.kind === "incomplete") {
    const onlyBootstrap = outcome.incompleteRooms.length === 1 && outcome.incompleteRooms[0].isBootstrap;
    if (onlyBootstrap && outcome.incompleteRooms[0].hasSwf) {
      title = he.importEntrySwfOnlyTitle;
      lead = he.importEntrySwfOnlySub;
    } else if (onlyBootstrap && outcome.incompleteRooms[0].hasTxt) {
      title = he.importEntryTxtOnlyTitle;
      lead = he.importEntryTxtOnlySub;
    } else {
      title = he.importIncompleteTitle;
      lead = he.importIncompleteSub;
    }
    art = `<div class="success-burst is-calm" aria-hidden="true">${icon("room")}</div>`;
  } else if (outcome.kind === "conflict") {
    title = he.importConflictTitle;
    lead = he.importConflictSub;
    art = `<div class="success-burst is-calm" aria-hidden="true">${icon("info")}</div>`;
  } else if (outcome.kind === "nothing-new") {
    title = he.importNothingNewTitle;
    lead = he.importNothingNewSub;
    art = `<div class="success-burst is-calm" aria-hidden="true">${icon("heart")}</div>`;
  } else if (outcome.kind === "unclassified") {
    title = "הקובץ נשמר בארכיון הכללי";
    lead = "הקובץ לא זוהה כחלק פעיל מהמשחק ונשמר בתיקיית unclassified לזיהוי עתידי.";
    art = `<div class="success-burst is-calm" aria-hidden="true">${icon("folder")}</div>`;
  } else {
    title = he.importUnknownTitle;
    lead = he.importUnknownSub;
    art = `<div class="success-burst is-muted" aria-hidden="true">${icon("folder")}</div>`;
  }

  const notes: string[] = [];
  if (session.stopped) notes.push(esc(he.importStopped));
  if (outcome.skipped > 0) {
    notes.push(`${esc(he.importSkipped(outcome.skipped))} · <button type="button" class="btn-link-inline" data-action="open-details">${esc(he.details)}</button>`);
  }
  if (outcome.failed > 0) notes.push(esc(he.importFailed(outcome.failed)));

  const incompleteList =
    outcome.incompleteRooms.length > 0
      ? `<ul class="incomplete-list">${outcome.incompleteRooms.slice(0, 6).map(incompleteRoomRow).join("")}</ul>`
      : "";

  const body = `
    <div class="import-done" aria-live="polite">
      ${art}
      ${lead ? `<p class="sheet-lead">${esc(lead)}</p>` : ""}
      ${outcome.becameReady ? `<p class="ready-banner">${icon("sparkle")}<span>${esc(he.importWorldNowReady)}</span></p>` : ""}
      ${outcome.stats.length > 0 ? `<ul class="result-stats">${outcome.stats.map((s) => resultStat(s, sessionId)).join("")}</ul>` : ""}
      ${incompleteList}
      ${outcome.foundOutsideContext ? `<p class="also-found">${icon("sparkle")}<span>${esc(he.alsoFound)}</span></p>` : ""}
      ${notes.length > 0 ? `<p class="quiet-notes">${notes.join("<br>")}</p>` : ""}
      <div class="sheet-actions">
        ${playReady ? `<button type="button" class="btn btn-primary btn-lg" data-action="play" ${outcome.becameReady ? "data-autofocus" : ""}>${icon("play")}<span>${esc(he.play)}</span></button>` : ""}
        <button type="button" class="btn btn-secondary btn-lg" data-action="open-add" data-context="${session.context}" ${outcome.becameReady ? "" : "data-autofocus"}>${icon("plus")}<span>${esc(he.importAddMore)}</span></button>
        <button type="button" class="btn btn-quiet btn-lg" data-action="close-sheet">${esc(he.importFinish)}</button>
      </div>
    </div>`;
  return frame({ cls: "sheet-import is-done", title: esc(title), body, dismissible: true });
}

// ───────────────────────── APK flow ─────────────────────────

function renderApk(sheet: Extract<Sheet, { kind: "apk" }>): string {
  if (sheet.phase === "checking") {
    return frame({
      cls: "sheet-apk is-working",
      title: esc(he.apkChecking),
      dismissible: false,
      body: `<div class="import-live"><div class="portal-spinner" aria-hidden="true"><span></span><span></span><span></span></div><p class="sheet-lead">${esc(he.apkCheckingSub)}</p></div>`,
    });
  }
  if (sheet.phase === "recognized") {
    return frame({
      cls: "sheet-apk is-recognized",
      title: `<span lang="en" dir="ltr">${esc(sheet.displayName)}</span> זוהה`,
      dismissible: true,
      body: `<div class="import-done" aria-live="polite">
        <div class="success-burst is-big" aria-hidden="true"><span class="burst-ring"></span><span class="burst-dots"></span>${icon("check")}</div>
        <p class="sheet-lead">${esc(he.apkRecognizedSub)}</p>
        <div class="sheet-actions"><button type="button" class="btn btn-primary btn-lg" data-action="close-sheet" data-autofocus>${esc(he.continue)}</button></div>
        <div class="auto-continue" aria-hidden="true"><span></span></div>
      </div>`,
    });
  }
  return frame({
    cls: "sheet-apk is-error",
    title: esc(he.apkErrorTitle),
    dismissible: true,
    body: `<div class="import-done">
      <div class="success-burst is-muted" aria-hidden="true">${icon("apk")}</div>
      <p class="sheet-lead">${esc(apkErrorMessage(sheet.code))}</p>
      ${sheet.technical ? `<details class="tech"><summary>${esc(he.technicalDetails)}</summary><p dir="ltr" lang="en">${esc(sheet.technical)}</p></details>` : ""}
      <div class="sheet-actions">
        <button type="button" class="btn btn-primary btn-lg" data-action="pick-apk" data-autofocus>${icon("apk")}<span>${esc(he.tryAnotherFile)}</span></button>
        <button type="button" class="btn btn-quiet btn-lg" data-action="close-sheet">${esc(he.close)}</button>
      </div>
    </div>`,
  });
}

function renderNeedApk(): string {
  return frame({
    cls: "sheet-apk",
    title: esc(he.dropNeedApkFirst),
    dismissible: true,
    body: `<div class="import-done">
      <div class="success-burst is-calm" aria-hidden="true">${icon("apk")}</div>
      <p class="sheet-lead">${esc(he.dropNeedApkFirstSub)}</p>
      <div class="sheet-actions">
        <button type="button" class="btn btn-primary btn-lg" data-action="pick-apk" data-autofocus>${icon("apk")}<span>${esc(he.addApk)}</span></button>
      </div>
    </div>`,
  });
}

// ───────────────────────── Details / Settings ─────────────────────────

function kv(label: string, value: string, ltr = true): string {
  return `<div class="kv"><dt>${esc(label)}</dt><dd ${ltr ? 'dir="ltr"' : ""}>${value}</dd></div>`;
}

function okLabel(ok: boolean): string {
  return `<span class="pill ${ok ? "is-ok" : "is-warn"}" dir="rtl">${esc(ok ? he.ready : he.notReady)}</span>`;
}

function renderDetails(confirmRemove: boolean, ctx: SheetContext): string {
  const b = ctx.build;
  const rt = ctx.runtime;
  if (!b) {
    return frame({ cls: "sheet-details", title: esc(he.detailsTitle), dismissible: true, body: `<p class="sheet-lead">אין עדיין משחק מותקן.</p>` });
  }
  const rooms = b.categories.world.rooms
    .map((r) => {
      const revNote = r.revisionsCount && r.revisionsCount > 1 ? ` · ${num(r.revisionsCount)} גרסאות נשמרו` : "";
      const activeInfo = r.activeRevision
        ? `<br><small class="muted">גרסה פעילה: ${esc(r.activeRevision.formattedDate || r.activeRevision.filename)} (${esc(r.activeRevision.sha256.slice(0, 8))})</small>`
        : "";
      return `<li><div><strong>חדר ${r.roomId}</strong>${esc(revNote)}${activeInfo}</div><span class="pill ${r.ready ? "is-ok" : "is-warn"}">${r.ready ? "מוכן" : r.hasSwf ? "חסר קובץ הגדרות" : "חסר קובץ החדר"}</span></li>`;
    })
    .join("");
  const families = Object.entries(b.categories.items.byFamily)
    .filter(([, n]) => n > 0)
    .map(([f, n]) => `<li><span dir="ltr">${esc(f)}</span><span>${num(n)}</span></li>`)
    .join("");
  const games = b.categories.miniGames.games
    .map(
      (g) =>
        `<li><span dir="ltr" lang="en">${esc(g.displayName)}</span><span class="pill ${g.state === "Available" ? "is-ok" : "is-quiet"}">${esc(miniGameStateLabel(g.state))}</span></li>`,
    )
    .join("");
  const iface = b.categories.interface;

  const body = `
    <div class="details">
      <section class="detail-block">
        <h3>${esc(he.detailsGame)}</h3>
        <dl class="kv-list">
          ${kv("גרסה", `<span lang="en">${esc(b.displayName)}</span>`)}
          ${kv("מזהה", esc(b.buildId))}
          ${b.apk ? kv("חבילה", esc(b.apk.packageName)) : ""}
          ${b.apk ? kv("גרסת APK", `${esc(b.apk.versionName)} (appVer ${esc(b.apk.clientAppVer)})`) : ""}
          ${b.apk ? kv("SHA-256", `<code>${esc(b.apk.sha256)}</code>`) : ""}
          ${kv("קבצים מזוהים", num(b.recognizedAssets.length))}
          ${kv("מוכן למשחק", okLabel(b.playReady), false)}
        </dl>
      </section>
      <section class="detail-block">
        <h3>${esc(he.detailsRuntime)}</h3>
        <dl class="kv-list">
          ${kv("Ruffle", rt?.ruffleReady ? okLabel(true) : `${okLabel(false)} <code>npm run setup:ruffle</code>`, false)}
          ${kv("AIR shims", rt?.airShimsReady ? okLabel(true) : `${okLabel(false)} <code>npm run build:air-shims</code>`, false)}
          ${kv("שרת מקומי", okLabel(Boolean(rt?.smartFoxReady)), false)}
        </dl>
      </section>
      <section class="detail-block">
        <h3>${esc(he.detailsWorld)} · ${num(b.categories.world.roomCount)}</h3>
        ${rooms ? `<ul class="detail-list">${rooms}</ul>` : `<p class="muted">עדיין אין חדרים.</p>`}
        ${b.categories.world.musicCount > 0 ? `<p class="muted">${esc(he.roomMusic(b.categories.world.musicCount))}</p>` : ""}
      </section>
      <section class="detail-block">
        <h3>${esc(he.detailsItems)} · ${num(b.categories.items.count)}</h3>
        ${families ? `<ul class="detail-list">${families}</ul>` : `<p class="muted">${esc(he.noItemsYet)}.</p>`}
      </section>
      <section class="detail-block">
        <h3>${esc(he.detailsMiniGames)} · ${num(b.categories.miniGames.availableCount)}</h3>
        ${games ? `<ul class="detail-list">${games}</ul>` : `<p class="muted">${esc(he.noGamesYet)}.</p>`}
      </section>
      <section class="detail-block">
        <h3>${esc(he.detailsInterface)}</h3>
        <dl class="kv-list">
          ${kv("שפה וממשק", iface.language?.compatible ? "עברית (Hebrew)" : iface.language?.present ? "קובץ שפה לא תואם" : "חסר קובץ שפה", false)}
          ${iface.language?.originalFilename ? kv("שם קובץ שפה", `<span lang="en">${esc(iface.language.originalFilename)}</span>`) : ""}
          ${iface.language?.sha256 ? kv("SHA-256", `<code>${esc(iface.language.sha256)}</code>`) : ""}
          ${iface.language?.activeRevisionKey ? kv("גרסה פעילה", esc(iface.language.lastUpdate || iface.language.activeRevisionKey)) : ""}
          ${iface.language?.sectionsCount ? kv("מקטעי שפה שזוהו", num(iface.language.sectionsCount)) : ""}
          ${iface.language?.revisionsCount && iface.language.revisionsCount > 1 ? kv("גרסאות שמורות בארכיון", num(iface.language.revisionsCount)) : ""}
          ${iface.language?.reason ? kv("סטטוס תאימות", esc(iface.language.reason), false) : ""}
          ${kv("קבצי ממשק", num(iface.presentCount))}
          ${kv("מצב ממשק", okLabel(iface.ready), false)}
        </dl>
      </section>
      ${
        b.unclassifiedAssets && b.unclassifiedAssets.length > 0
          ? `<section class="detail-block"><h3>${esc(he.detailsUnclassified)} · ${num(b.unclassifiedAssets.length)}</h3>
              <ul class="detail-list is-mono">${b.unclassifiedAssets
                .slice(0, 40)
                .map((u) => `<li><span dir="ltr">${esc(u.originalFilename)}</span><span class="pill is-quiet">${esc(u.evidence)}</span></li>`)
                .join("")}</ul></section>`
          : ""
      }
      ${
        ctx.lastUnknownFiles.length > 0
          ? `<section class="detail-block"><h3>${esc(he.detailsSkipped)} · ${num(ctx.lastUnknownFiles.length)}</h3>
              <ul class="detail-list is-mono">${ctx.lastUnknownFiles
                .slice(0, 40)
                .map((f) => `<li><span dir="ltr">${esc(f)}</span></li>`)
                .join("")}</ul></section>`
          : ""
      }
      <section class="detail-block danger-zone">
        ${
          confirmRemove
            ? `<p>${esc(he.removeConfirm)}</p>
               <div class="sheet-actions is-start">
                 <button type="button" class="btn btn-danger" data-action="remove-build-confirm">${esc(he.removeYes)}</button>
                 <button type="button" class="btn btn-quiet" data-action="remove-build-cancel" data-autofocus>${esc(he.cancel)}</button>
               </div>`
            : `<button type="button" class="btn btn-danger-quiet" data-action="remove-build">${esc(he.removeBuild)}</button>`
        }
      </section>
    </div>`;
  return frame({ cls: "sheet-details", title: esc(he.detailsTitle), dismissible: true, body });
}

function renderUpdateSection(status?: UpdateStatusResponse | null): string {
  const currentVer = status?.currentVersion ?? "0.1.0-preview.2";
  const state = status?.state ?? "idle";

  let statusContent = "";

  switch (state) {
    case "checking":
      statusContent = `
        <p class="update-status-msg" aria-live="polite">${esc(he.checkingUpdates)}</p>
      `;
      break;

    case "not-available":
      statusContent = `
        <p class="update-status-msg success">${esc(he.upToDate)}</p>
        <button type="button" class="btn btn-secondary btn-sm" data-action="check-updates">${esc(he.checkUpdatesBtn)}</button>
      `;
      break;

    case "available":
      statusContent = `
        <div class="update-available-box">
          <p class="update-heading">${esc(he.updateAvailable)}</p>
          <div class="version-comparison">
            <span class="ver-label">${esc(he.installedLabel)}</span> <span class="ver-value">${esc(currentVer)}</span>
            <span class="ver-label">${esc(he.newVersionLabel)}</span> <span class="ver-value ver-new">${esc(status?.availableVersion ?? "")}</span>
          </div>
          <div class="update-actions">
            <button type="button" class="btn btn-primary btn-sm" data-action="download-update">${esc(he.downloadUpdateBtn)}</button>
            <button type="button" class="btn btn-quiet btn-sm" data-action="dismiss-update">${esc(he.laterBtn)}</button>
          </div>
        </div>
      `;
      break;

    case "downloading": {
      const pct = status?.downloadProgress ?? 0;
      statusContent = `
        <div class="update-downloading-box">
          <p class="update-status-msg" aria-live="polite">${esc(he.downloadingUpdate(pct))}</p>
          <div class="progress" role="progressbar" aria-label="${esc(he.downloadingUpdate(pct))}" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${pct}">
            <div class="progress-bar" style="width: ${pct}%"></div>
          </div>
        </div>
      `;
      break;
    }

    case "downloaded":
      statusContent = `
        <div class="update-ready-box">
          <p class="update-heading">${esc(he.updateReady)}</p>
          <p class="update-desc">${esc(he.updateReadyDescription)}</p>
          <div class="update-actions">
            <button type="button" class="btn btn-primary btn-sm" data-action="install-update">${esc(he.restartAndUpdateBtn)}</button>
            <button type="button" class="btn btn-quiet btn-sm" data-action="dismiss-update">${esc(he.laterBtn)}</button>
          </div>
        </div>
      `;
      break;

    case "error":
      statusContent = `
        <p class="update-status-msg error">${esc(he.checkUpdateFailed)}</p>
        <button type="button" class="btn btn-secondary btn-sm" data-action="check-updates">${esc(he.checkUpdatesBtn)}</button>
      `;
      break;

    case "idle":
    default:
      statusContent = `
        <button type="button" class="btn btn-secondary btn-sm" data-action="check-updates">${esc(he.checkUpdatesBtn)}</button>
      `;
      break;
  }

  return `
    <section class="detail-block update-block">
      <h3>${esc(he.updatesTitle)}</h3>
      <p class="ver-info"><span class="ver-label">${esc(he.installedVersion)}</span> <code>${esc(currentVer)}</code></p>
      ${statusContent}
    </section>
  `;
}

function renderSettings(ctx: SheetContext): string {
  const body = `
    <div class="details">
      ${renderUpdateSection(ctx.updateStatus)}
      <section class="detail-block">
        <h3>${esc(he.preferencesTitle)}</h3>
        <label class="switch-row">
          <span>${esc(he.prefFullscreen)}</span>
          <input type="checkbox" class="switch" data-pref="fullscreen" ${ctx.prefs.fullscreen ? "checked" : ""} />
        </label>
        <label class="switch-row">
          <span>${esc(he.prefDiagnostics)}</span>
          <input type="checkbox" class="switch" data-pref="diagnostics" ${ctx.prefs.diagnostics ? "checked" : ""} />
        </label>
      </section>
      <section class="detail-block">
        <h3>${esc(he.storageTitle)}</h3>
        <p class="path" dir="ltr"><code>${esc(ctx.runtime?.dataDir ?? "data/")}</code></p>
        <p class="muted">${esc(he.firstRunNote)}</p>
      </section>
    </div>`;
  return frame({ cls: "sheet-settings", title: esc(he.settingsTitle), dismissible: true, body });
}

function renderMissingLogSheet(ctx: SheetContext): string {
  const entries = ctx.missingAssets ?? [];
  const count = entries.length;

  const header = `
    <div class="missing-log-header">
      <p class="missing-log-lead">${esc(he.missingAssetsLead)}</p>
      <div class="missing-log-toolbar">
        <span class="missing-log-count">${esc(he.missingEntriesCount(count))}</span>
        <div class="missing-log-actions">
          ${
            count > 0
              ? `<button type="button" class="btn btn-sm btn-quiet" data-action="copy-missing-log">
                   ${icon("copy")}<span>${esc(he.copyMissingList)}</span>
                 </button>
                 <button type="button" class="btn btn-sm btn-danger-quiet" data-action="clear-missing-log">
                   <span>${esc(he.clearLog)}</span>
                 </button>`
              : ""
          }
        </div>
      </div>
    </div>`;

  const content =
    count === 0
      ? `<div class="missing-log-empty">
           <span class="missing-empty-icon" aria-hidden="true">${icon("check")}</span>
           <p>${esc(he.noMissingAssetsYet)}</p>
         </div>`
      : `<div class="missing-log-list" role="list">
           ${entries
             .map((e) => {
               const timeStr =
                 e.timeFormatted ||
                 new Date(e.timestamp).toLocaleTimeString("he-IL", {
                   hour: "2-digit",
                   minute: "2-digit",
                   second: "2-digit",
                 });
               return `<div class="missing-log-item" role="listitem">
                 <div class="missing-item-main">
                   <span class="missing-tag missing-tag-${e.category}">${esc(e.categoryLabel)}</span>
                   <span class="missing-filename" dir="ltr">${esc(e.filename)}</span>
                   ${e.count > 1 ? `<span class="missing-batch-badge">×${e.count}</span>` : ""}
                 </div>
                 <div class="missing-item-meta">
                   <code class="missing-path" dir="ltr">${esc(e.path)}</code>
                   <time class="missing-time">${esc(timeStr)}</time>
                 </div>
               </div>`;
             })
             .join("")}
         </div>`;

  const body = `<div class="sheet-missing-log">${header}${content}</div>`;
  return frame({
    cls: "sheet-missing",
    title: esc(he.missingAssetsLog),
    dismissible: true,
    body,
  });
}

function renderRoomRevisionsSheet(ctx: SheetContext): string {
  const b = ctx.build;
  if (!b) {
    return frame({
      cls: "sheet-room-revisions",
      title: esc(he.roomRevisionsTitle),
      dismissible: true,
      body: `<p class="sheet-lead">אין עדיין משחק מותקן.</p>`,
    });
  }

  const rooms = b.categories.world.rooms;
  const header = `
    <div class="room-revisions-header">
      <p class="room-revisions-lead">${esc(he.roomRevisionsLead)}</p>
      <div class="room-revisions-notice-banner" role="status">
        ${icon("sparkle")}<span>${esc(he.roomRevisionNotice)}</span>
      </div>
    </div>`;

  const content =
    rooms.length === 0
      ? `<div class="room-revisions-empty">
           <p class="muted">עדיין אין חדרים מותקנים.</p>
         </div>`
      : `<div class="room-revisions-list">
           ${rooms
             .map((r) => {
               const playable = r.playableRevisions ?? [];
               const currentSelected = r.selectedRevisionKey ?? "";
               const recommendedKey = r.recommendedRevisionKey ?? "";
               const revCount = r.revisionsCount ?? playable.length;
               return `
                 <div class="room-revisions-card" data-room-id="${r.roomId}">
                   <div class="room-revisions-card-header">
                     <span class="room-badge">חדר ${r.roomId}</span>
                     <span class="room-rev-count-badge">${revCount > 1 ? `${revCount} גרסאות` : "גרסה אחת"}</span>
                     <span class="pill ${r.ready ? "is-ok" : "is-warn"}">${r.ready ? "מוכן" : "חסרים קבצים"}</span>
                   </div>
                   <div class="room-revisions-selector">
                     <label class="room-select-label" for="select-room-${r.roomId}">בחר גרסה למשחק:</label>
                     <select
                       id="select-room-${r.roomId}"
                       class="room-revision-select"
                       data-action="change-room-revision"
                       data-room-id="${r.roomId}"
                     >
                       <option value="" ${currentSelected === "" ? "selected" : ""}>
                         ${esc(he.roomAutoOption)}${recommendedKey ? ` (${esc(playable.find((p) => p.isRecommended)?.label || recommendedKey)})` : ""}
                       </option>
                       ${playable
                         .map((p) => {
                           if (!p.isComplete) {
                             const missingText = p.missingFiles?.join(", ") ?? "";
                             return `<option value="${esc(p.revisionKey)}" disabled>
                               ${esc(p.label)} — ${esc(he.incompleteRevision)} (${esc(missingText)})
                             </option>`;
                           }
                           const isSel = currentSelected === p.revisionKey;
                           const recMark = p.isRecommended ? " (מומלץ)" : "";
                           return `<option value="${esc(p.revisionKey)}" ${isSel ? "selected" : ""}>
                             ${esc(p.label)}${recMark}
                           </option>`;
                         })
                         .join("")}
                     </select>
                   </div>
                 </div>`;
             })
             .join("")}
         </div>`;

  const body = `<div class="sheet-room-revisions-body">${header}${content}</div>`;
  return frame({
    cls: "sheet-room-revisions",
    title: esc(he.roomRevisionsTitle),
    dismissible: true,
    body,
  });
}

// ───────────────────────── Router ─────────────────────────

export function renderSheet(sheet: Sheet | null, ctx: SheetContext): string {
  if (!sheet) return "";
  switch (sheet.kind) {
    case "add":
      return renderAddSheet(sheet.context, ctx);
    case "import":
      return sheet.session.phase === "done"
        ? renderImportDone(sheet.session, sheet.id, Boolean(ctx.build?.playReady))
        : renderImporting(sheet.session);
    case "apk":
      return renderApk(sheet);
    case "need-apk":
      return renderNeedApk();
    case "details":
      return renderDetails(sheet.confirmRemove, ctx);
    case "settings":
      return renderSettings(ctx);
    case "missing-log":
      return renderMissingLogSheet(ctx);
    case "room-revisions":
      return renderRoomRevisionsSheet(ctx);
  }
}
