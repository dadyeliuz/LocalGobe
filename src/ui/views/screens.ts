import { cloud, icon, islandArt, islet, logoMark, type IconName } from "../art.ts";
import { esc, num } from "../html.ts";
import { he, nounFor, type NounKey } from "../i18n/he.ts";
import type { ContentContext, HomeModel } from "../model.ts";

/** Sky backdrop shared by the launcher screens. Purely decorative. */
export function skyBackdrop(): string {
  return `<div class="sky" aria-hidden="true">
    <div class="sky-rays"></div>
    ${cloud("cloud-a")}${cloud("cloud-b")}${cloud("cloud-c")}
    ${islet("islet-a")}${islet("islet-b")}
  </div>`;
}

export function brand(): string {
  return `<div class="brand">${logoMark()}<span class="brand-name" lang="en" dir="ltr">LocalGobe</span></div>`;
}

export function topbar(withActions: boolean): string {
  return `<header class="topbar">
    ${brand()}
    ${
      withActions
        ? `<nav class="topbar-actions" aria-label="תפריט">
            <button type="button" class="icon-btn" data-action="open-details" aria-label="${esc(he.details)}" title="${esc(he.details)}">${icon("info")}<span class="icon-btn-label">${esc(he.details)}</span></button>
            <button type="button" class="icon-btn" data-action="open-settings" aria-label="${esc(he.settings)}" title="${esc(he.settings)}">${icon("settings")}<span class="icon-btn-label">${esc(he.settings)}</span></button>
          </nav>`
        : ""
    }
  </header>`;
}

export function serviceBanner(show: boolean): string {
  if (!show) return "";
  return `<div class="service-banner" role="alert">
    <span>${esc(he.serviceDown)}</span>
    <button type="button" class="btn btn-secondary btn-sm" data-action="retry">${icon("refresh")}<span>${esc(he.retry)}</span></button>
  </div>`;
}

// ───────────────────────── First run ─────────────────────────

export function renderFirstRun(opts: { serviceError: boolean; fresh: boolean }): string {
  return `<div class="screen screen-first-run" data-screen="first-run" ${opts.fresh ? "data-fresh" : ""}>
    ${skyBackdrop()}
    ${topbar(false)}
    ${serviceBanner(opts.serviceError)}
    <main class="first-run" id="main">
      <div class="island island-first enter enter-1">${islandArt("sleeping")}</div>
      <div class="first-run-copy">
        <h1 class="hero-title enter enter-2">${esc(he.firstRunTitle)}</h1>
        <p class="hero-lead enter enter-3">${esc(he.firstRunLead)}</p>
        <div class="enter enter-4">
          <button type="button" class="btn btn-primary btn-xl" data-action="pick-apk" data-autofocus>
            ${icon("apk")}<span>${esc(he.addApk)}</span>
          </button>
        </div>
        <p class="reassure enter enter-5">${icon("heart")}<span>${esc(he.firstRunNote)}</span></p>
        <p class="drop-hint enter enter-5">${icon("drop")}<span>${esc(he.firstRunDropHint)}</span></p>
      </div>
    </main>
    <footer class="legal">${esc(he.firstRunLegal)}</footer>
  </div>`;
}

// ───────────────────────── Home ─────────────────────────

type BubbleSpec = {
  kind: "rooms" | "items" | "games";
  noun: NounKey;
  icon: IconName;
  tone: "coral" | "pink" | "grape";
  context: ContentContext;
  addLabel: string;
  emptyText: string;
};

const BUBBLES: BubbleSpec[] = [
  { kind: "rooms", noun: "room", icon: "room", tone: "coral", context: "world", addLabel: he.addRooms, emptyText: he.noRoomsYet },
  { kind: "items", noun: "item", icon: "item", tone: "pink", context: "items", addLabel: he.addItems, emptyText: he.noItemsYet },
  { kind: "games", noun: "game", icon: "game", tone: "grape", context: "miniGames", addLabel: he.addGames, emptyText: he.noGamesYet },
];

function bubble(spec: BubbleSpec, model: HomeModel): string {
  const value = model.counts[spec.kind];
  let sub = "";
  if (spec.kind === "rooms") {
    const revs = model.counts.roomRevisions ?? value;
    const parts: string[] = [];
    if (revs > value) {
      parts.push(`${num(revs)} גרסאות`);
    }
    if (model.counts.music > 0) {
      parts.push(he.roomMusic(model.counts.music));
    }
    if (parts.length > 0) {
      sub = `<p class="bubble-sub">${esc(parts.join(" · "))}</p>`;
    }
  }
  const empty = value === 0;
  return `<article class="bubble bubble-${spec.kind} ${empty ? "is-empty" : ""}" data-tone="${spec.tone}" data-bump-key="${spec.kind}">
    <div class="bubble-icon">${icon(spec.icon)}</div>
    <div class="bubble-body">
      ${
        empty
          ? `<p class="bubble-empty">${esc(spec.emptyText)}</p>`
          : `<p class="bubble-count"><b class="count" data-count-key="${spec.kind}" data-count="${value}">${num(value)}</b><span class="bubble-noun">${esc(nounFor(spec.noun, value))}</span></p>${sub}`
      }
    </div>
    <button type="button" class="bubble-add" data-action="open-add" data-context="${spec.context}">
      ${icon("plus")}<span>${esc(spec.addLabel)}</span>
    </button>
  </article>`;
}

function steps(model: HomeModel): string {
  const langDone = Boolean(model.language?.compatible);
  const worldDone = Boolean(model.bootstrapRoom?.ready);
  return `<ol class="steps" aria-label="${esc(he.almostThere)}">
    <li class="step is-done">${icon("check")}<span>${esc(he.stepGame)}</span></li>
    <li class="step ${worldDone ? "is-done" : "is-current"}">${worldDone ? icon("check") : icon("room")}<span>${esc(he.stepWorld)}</span></li>
    <li class="step ${langDone ? "is-done" : "is-optional"}">${langDone ? icon("check") : icon("interface")}<span>קובץ השפה${langDone ? "" : " (מומלץ)"}</span></li>
    <li class="step ${model.playReady ? "is-done" : ""}">${icon("play")}<span>${esc(he.stepPlay)}</span></li>
  </ol>`;
}

function missingWorldDisclosure(model: HomeModel): string {
  const { roomId, hasSwf, hasTxt } = model.bootstrapRoom;
  const swfName = `room_${roomId}.swf`;
  const txtName = `room_${roomId}.txt`;
  const lang = model.language;
  const langOk = lang && lang.compatible;

  return `<details class="missing-disclosure">
    <summary class="missing-summary">${icon("info")}<span>${esc(he.whatsMissing)}</span></summary>
    <div class="missing-body">
      <p class="missing-heading">${esc(he.entryRoomTitle)}</p>
      <ul class="missing-list">
        <li class="${hasSwf ? "is-found" : "is-missing"}">
          <span class="missing-file" dir="ltr" lang="en">${esc(swfName)}</span>
          <span class="pill ${hasSwf ? "is-ok" : "is-warn"}">${esc(hasSwf ? he.fileFoundLabel : he.fileMissingLabel)}</span>
        </li>
        <li class="${hasTxt ? "is-found" : "is-missing"}">
          <span class="missing-file" dir="ltr" lang="en">${esc(txtName)}</span>
          <span class="pill ${hasTxt ? "is-ok" : "is-warn"}">${esc(hasTxt ? he.fileFoundLabel : he.fileMissingLabel)}</span>
        </li>
      </ul>
      ${
        !langOk
          ? `<p class="missing-heading">${esc(he.languageMissingLead)} (מומלץ)</p>
             <ul class="missing-list">
               <li class="${lang?.present ? "is-found" : "is-missing"}">
                 <span class="missing-file" dir="ltr" lang="en">${esc(lang?.originalFilename || "lang.aspx")}</span>
                 <span class="pill is-warn">${esc(lang?.present ? "לא מתאים" : he.fileMissingLabel)}</span>
               </li>
             </ul>
             <p class="missing-hint" style="font-size: 0.85rem; color: var(--color-ink-muted); margin-top: 4px;">${esc(he.languageMissingSub)}</p>`
          : ""
      }
    </div>
  </details>`;
}

export function renderHome(model: HomeModel, opts: { serviceError: boolean; fresh: boolean }): string {
  const ready = model.stage === "ready";
  const variant = ready ? "ready" : "waiting";
  const chip =
    model.stage === "needs-game"
      ? `<span class="build-chip is-warn" lang="en" dir="ltr">${esc(model.buildName)}</span>`
      : `<span class="build-chip">${icon("check")}<span lang="en" dir="ltr">${esc(model.buildName)}</span>${ready ? "" : `<span class="chip-tail">זוהה</span>`}</span>`;

  let statusLead = model.statusLine;
  const langOk = Boolean(model.language?.compatible);
  const worldOk = Boolean(model.bootstrapRoom?.ready);

  if (model.stage === "needs-world" || model.stage === "needs-files") {
    if (model.bootstrapRoom.hasSwf && !model.bootstrapRoom.hasTxt) {
      statusLead = he.entryRoomSwfOnlyLead;
    } else if (!model.bootstrapRoom.hasSwf && model.bootstrapRoom.hasTxt) {
      statusLead = he.entryRoomTxtOnlyLead;
    } else {
      statusLead = he.addWorldFilesLead;
    }
  }

  let centerAction: string;
  let below: string;
  if (ready) {
    centerAction = `<button type="button" class="btn-play" data-action="play" data-autofocus aria-describedby="hero-status">
        <span class="btn-play-icon">${icon("play")}</span><span class="btn-play-label">${esc(he.play)}</span>
      </button>`;
    below = `<section class="collection" aria-label="העולם שלך">
        ${BUBBLES.map((b) => bubble(b, model)).join("")}
      </section>
      <div class="home-actions enter enter-5">
        <button type="button" class="btn btn-secondary btn-lg btn-add-content" data-action="open-add" data-context="all">${icon("plus")}<span>${esc(he.addContent)}</span></button>
        <p class="home-hints">
          <span class="drop-hint">${icon("drop")}<span>${esc(he.dropAnywhereHint)}</span></span>
          ${model.language?.compatible ? `<span class="quiet-chip">${icon("interface")}<span>${esc(he.interfaceReady)}</span></span>` : `<span class="quiet-chip is-warn" title="${esc(he.languageMissingSub)}">${icon("info")}<span>${esc(he.languageMissingLead)}</span></span>`}
        </p>
      </div>`;
  } else if (model.stage === "needs-game") {
    centerAction = `<button type="button" class="btn btn-primary btn-xl" data-action="pick-apk" data-autofocus>${icon("apk")}<span>${esc(he.addApk)}</span></button>`;
    below = "";
  } else {
    centerAction = `<div class="setup-actions">
        <div class="setup-buttons">
          <button type="button" class="btn btn-primary btn-xl" data-action="pick-folder" data-context="world" data-autofocus>${icon("folder")}<span>${esc(he.chooseFolder)}</span></button>
          <button type="button" class="btn btn-secondary btn-lg" data-action="pick-files" data-context="world">${icon("files")}<span>${esc(he.chooseFiles)}</span></button>
        </div>
        ${missingWorldDisclosure(model)}
      </div>`;
    below = `<div class="home-actions enter enter-5">
        ${steps(model)}
        <p class="home-hints"><span class="drop-hint">${icon("drop")}<span>${esc(he.dropAnywhereHint)}</span></span></p>
      </div>`;
  }

  return `<div class="screen screen-home" data-screen="home" data-stage="${model.stage}" ${opts.fresh ? "data-fresh" : ""}>
    ${skyBackdrop()}
    ${topbar(true)}
    ${serviceBanner(opts.serviceError)}
    <main class="home" id="main">
      <div class="hero-copy">
        <div class="enter enter-1">${chip}</div>
        <h1 class="hero-title enter enter-2">${esc(model.title)}</h1>
        <p class="hero-status enter enter-3" id="hero-status">
          ${ready ? `<span class="status-dot" aria-hidden="true"></span>${esc(model.statusLine)}` : esc(statusLead)}
        </p>
        ${ready && !langOk ? `<p class="language-warning-notice enter enter-4" style="font-size: 0.9rem; color: var(--color-ink-muted); margin-top: 6px;">${icon("info")} <strong>${esc(he.languageMissingLead)}</strong> — ${esc(he.languageMissingSub)}</p>` : ""}
        ${ready && model.bootstrapRoom.isFallbackPair ? `<p class="fallback-room-notice enter enter-4" style="font-size: 0.88rem; color: var(--color-ink-muted); margin-top: 4px;">${icon("info")} <strong>חדר הכניסה שודך כצמד חלופי</strong> — קבצי ה-SWF וה-TXT ממקורות שונים, המשחק מוכן לכניסה.</p>` : ""}
      </div>
      <div class="world ${ready ? "is-ready" : "is-waiting"}">
        <div class="portal-wrap enter enter-2">
          <div class="island">${islandArt(variant)}</div>
          ${model.stage === "needs-world" ? `<p class="portal-caption">${icon("sparkle")}<span>${esc(he.needsWorldStatus)}</span></p>` : ""}
          <div class="portal-action">${centerAction}</div>
        </div>
        ${below}
      </div>
    </main>
  </div>`;
}

export function renderLoading(): string {
  return `<div class="screen screen-loading" data-screen="loading">
    ${skyBackdrop()}
    <main class="loading" id="main" aria-busy="true">
      <div class="portal-spinner" aria-hidden="true"><span></span><span></span><span></span></div>
      <p>${esc(he.loading)}</p>
    </main>
  </div>`;
}
