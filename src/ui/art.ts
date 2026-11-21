/**
 * Original LocalGobe artwork: icons and the floating-island portal scene.
 *
 * All shapes are drawn from scratch for LocalGobe (no original game assets). The
 * vocabulary — a sunny sky, a floating island, a glowing doorway, chunky white
 * outlines with a lime rim — is a nod to the sunny virtual-world mood of the
 * preserved game, not a copy of any of its screens.
 */

const ICON_PATHS = {
  play: `<path d="M8.2 5.6v12.8a1.1 1.1 0 0 0 1.7.93l10-6.4a1.1 1.1 0 0 0 0-1.86l-10-6.4a1.1 1.1 0 0 0-1.7.93z" fill="currentColor" stroke="none"/>`,
  plus: `<path d="M12 5v14M5 12h14"/>`,
  folder: `<path d="M3 7.6A2.6 2.6 0 0 1 5.6 5h3.6l2.1 2.4h7.1A2.6 2.6 0 0 1 21 10v7.4a2.6 2.6 0 0 1-2.6 2.6H5.6A2.6 2.6 0 0 1 3 17.4z"/>`,
  files: `<path d="M14 3H7.5A2.5 2.5 0 0 0 5 5.5v13A2.5 2.5 0 0 0 7.5 21h9a2.5 2.5 0 0 0 2.5-2.5V8z"/><path d="M14 3v5h5"/>`,
  room: `<path d="M3.5 11.2 12 4l8.5 7.2"/><path d="M5.8 9.6v9.1c0 .7.6 1.3 1.3 1.3h3.4v-5.2h3v5.2h3.4c.7 0 1.3-.6 1.3-1.3V9.6"/>`,
  item: `<rect x="3.5" y="8" width="17" height="4.2" rx="1.2"/><path d="M5.2 12.2v6.6c0 .7.5 1.2 1.2 1.2h11.2c.7 0 1.2-.5 1.2-1.2v-6.6M12 8v12"/><path d="M12 8S10.6 3.6 8.1 4.3C6.1 4.9 6.9 8 12 8zm0 0s1.4-4.4 3.9-3.7c2 .6 1.2 3.7-3.9 3.7z"/>`,
  game: `<path d="M7.2 7h9.6a5 5 0 0 1 4.9 6l-.7 3.4a2.4 2.4 0 0 1-4.1 1.2L14.4 15H9.6l-2.5 2.6A2.4 2.4 0 0 1 3 16.4L2.3 13A5 5 0 0 1 7.2 7z"/><path d="M7.6 9.9v3.2M6 11.5h3.2"/><circle cx="15.9" cy="10.4" r="1" fill="currentColor" stroke="none"/><circle cx="17.7" cy="12.6" r="1" fill="currentColor" stroke="none"/>`,
  interface: `<path d="M11 3.5l1.9 4.7 4.7 1.9-4.7 1.9L11 16.7l-1.9-4.7-4.7-1.9 4.7-1.9z"/><path d="M18 14.5l.8 2 2 .8-2 .8-.8 2-.8-2-2-.8 2-.8z"/>`,
  music: `<path d="M9 17.5V6.2l10-2.2v11.3"/><circle cx="6.6" cy="17.6" r="2.4"/><circle cx="16.6" cy="15.4" r="2.4"/>`,
  info: `<circle cx="12" cy="12" r="8.6"/><path d="M12 11v5.2"/><circle cx="12" cy="7.9" r="1.1" fill="currentColor" stroke="none"/>`,
  settings: `<path d="M4 7.5h9M17.5 7.5H20M4 16.5h3M11.5 16.5H20"/><circle cx="15.2" cy="7.5" r="2.3"/><circle cx="9.2" cy="16.5" r="2.3"/>`,
  // RTL "back" points to the right (towards the start edge).
  back: `<path d="M9.5 5.5 16 12l-6.5 6.5"/>`,
  fullscreen: `<path d="M4 9V5.2c0-.7.5-1.2 1.2-1.2H9M15 4h3.8c.7 0 1.2.5 1.2 1.2V9M20 15v3.8c0 .7-.5 1.2-1.2 1.2H15M9 20H5.2c-.7 0-1.2-.5-1.2-1.2V15"/>`,
  close: `<path d="M6.5 6.5l11 11M17.5 6.5l-11 11"/>`,
  check: `<path d="M5.2 12.6l4.4 4.4 9.2-9.6"/>`,
  more: `<circle cx="6" cy="12" r="1.6" fill="currentColor" stroke="none"/><circle cx="12" cy="12" r="1.6" fill="currentColor" stroke="none"/><circle cx="18" cy="12" r="1.6" fill="currentColor" stroke="none"/>`,
  refresh: `<path d="M19.5 12a7.5 7.5 0 1 1-2.2-5.3"/><path d="M19.5 4.5v4h-4"/>`,
  drop: `<path d="M12 3.8v10.8M7.6 10.4 12 14.8l4.4-4.4"/><path d="M4 14.5v3.3A2.2 2.2 0 0 0 6.2 20h11.6a2.2 2.2 0 0 0 2.2-2.2v-3.3"/>`,
  apk: `<path d="M12 3 4.2 7v10L12 21l7.8-4V7z"/><path d="M4.2 7 12 11l7.8-4M12 11v10"/>`,
  sparkle: `<path d="M12 3.5l2 5.6 5.5 2-5.5 2-2 5.4-2-5.4-5.5-2 5.5-2z"/>`,
  heart: `<path d="M12 19.5s-7.5-4.4-7.5-9.6A4.1 4.1 0 0 1 12 7.7a4.1 4.1 0 0 1 7.5 2.2c0 5.2-7.5 9.6-7.5 9.6z"/>`,
  alert: `<circle cx="12" cy="12" r="8.6"/><path d="M12 7.8v5.4"/><circle cx="12" cy="16.2" r="1.1" fill="currentColor" stroke="none"/>`,
  copy: `<rect x="8.5" y="8.5" width="11" height="11" rx="2"/><path d="M5.5 15.5H4.2A1.8 1.8 0 0 1 2.4 13.7V4.2A1.8 1.8 0 0 1 4.2 2.4h9.5a1.8 1.8 0 0 1 1.8 1.8v1.3"/>`,
} as const;

export type IconName = keyof typeof ICON_PATHS;

export function icon(name: IconName, cls = ""): string {
  return `<svg class="icon ${cls}" viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">${ICON_PATHS[name]}</svg>`;
}

/** LocalGobe mark: a little green world with a glowing doorway. */
export function logoMark(cls = ""): string {
  return `<svg class="logo-mark ${cls}" viewBox="0 0 48 48" aria-hidden="true" focusable="false">
    <defs>
      <linearGradient id="lg-mark-body" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0" stop-color="#C4F45C"/><stop offset="1" stop-color="#6FBA0D"/>
      </linearGradient>
      <linearGradient id="lg-mark-door" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0" stop-color="#9DF1FF"/><stop offset="1" stop-color="#1886DA"/>
      </linearGradient>
    </defs>
    <circle cx="24" cy="25" r="20" fill="url(#lg-mark-body)" stroke="#fff" stroke-width="3.5"/>
    <path d="M10 22c5 3 23 3 28 0" stroke="#ffffff" stroke-opacity=".45" stroke-width="2.5" fill="none" stroke-linecap="round"/>
    <path d="M17.5 38V27a6.5 6.5 0 0 1 13 0v11z" fill="url(#lg-mark-door)" stroke="#fff" stroke-width="2.6" stroke-linejoin="round"/>
    <path d="M37.5 5.5l1.2 3.1 3.1 1.2-3.1 1.2-1.2 3.1-1.2-3.1-3.1-1.2 3.1-1.2z" fill="#FFD447" stroke="#fff" stroke-width="1.2" stroke-linejoin="round"/>
  </svg>`;
}

export type IslandVariant = "ready" | "waiting" | "sleeping";

const PORTAL_STOPS: Record<IslandVariant, [string, string, string, string]> = {
  ready: ["#FFFBD6", "#8DF0FF", "#2CB9F3", "#1272D0"],
  waiting: ["#FFFFFF", "#D9ECF7", "#A9CBE2", "#7FA6C4"],
  sleeping: ["#F3F8FC", "#CFE0EE", "#9DB9D1", "#6F90AE"],
};

/**
 * The central floating island with its portal doorway.
 * `ready`: glowing portal. `waiting`: portal outlined, needs world files.
 * `sleeping`: first run, the world hasn't been brought back yet.
 */
export function islandArt(variant: IslandVariant): string {
  const [p0, p1, p2, p3] = PORTAL_STOPS[variant];
  const lit = variant === "ready";
  return `<svg class="island-art is-${variant}" viewBox="0 0 560 390" aria-hidden="true" focusable="false">
    <defs>
      <linearGradient id="isl-rock" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0" stop-color="#F6BE6C"/><stop offset=".5" stop-color="#DE9447"/><stop offset="1" stop-color="#B36A2F"/>
      </linearGradient>
      <linearGradient id="isl-grass" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0" stop-color="#BFF15C"/><stop offset="1" stop-color="#76C51B"/>
      </linearGradient>
      <radialGradient id="isl-portal-${variant}" cx="50%" cy="62%" r="70%">
        <stop offset="0" stop-color="${p0}"/><stop offset=".35" stop-color="${p1}"/><stop offset=".72" stop-color="${p2}"/><stop offset="1" stop-color="${p3}"/>
      </radialGradient>
      <radialGradient id="isl-glow" cx="50%" cy="50%" r="50%">
        <stop offset="0" stop-color="#FFFFFF" stop-opacity=".95"/><stop offset=".55" stop-color="#FFFFFF" stop-opacity=".35"/><stop offset="1" stop-color="#FFFFFF" stop-opacity="0"/>
      </radialGradient>
    </defs>

    <ellipse class="portal-glow" cx="280" cy="128" rx="${lit ? 175 : 130}" ry="${lit ? 140 : 105}" fill="url(#isl-glow)"/>

    <!-- rock underside -->
    <path d="M66 198C118 258 190 336 280 372C370 336 442 258 494 198Z" fill="url(#isl-rock)"/>
    <path d="M118 232C200 258 360 258 442 232" stroke="#C27735" stroke-width="7" fill="none" stroke-linecap="round" opacity=".45"/>
    <path d="M176 290C240 306 320 306 384 290" stroke="#A65D25" stroke-width="6" fill="none" stroke-linecap="round" opacity=".4"/>
    <path d="M238 336C262 344 298 344 322 336" stroke="#94511F" stroke-width="5" fill="none" stroke-linecap="round" opacity=".35"/>
    <circle cx="190" cy="262" r="5" fill="#FFE0A6" opacity=".55"/>
    <circle cx="352" cy="276" r="4" fill="#FFE0A6" opacity=".5"/>

    <!-- sand rim + grass -->
    <ellipse cx="280" cy="196" rx="218" ry="46" fill="#FFE6A8"/>
    <ellipse cx="280" cy="186" rx="206" ry="39" fill="url(#isl-grass)"/>
    <ellipse cx="246" cy="177" rx="150" ry="19" fill="#D3F88A" opacity=".55"/>

    <!-- bushes (start side in RTL reading = right; keep decor balanced) -->
    <g class="isl-bushes">
      <circle cx="112" cy="178" r="20" fill="#5DB425"/>
      <circle cx="140" cy="166" r="27" fill="#7FCF35"/>
      <circle cx="170" cy="178" r="19" fill="#69C02C"/>
      <circle cx="134" cy="158" r="9" fill="#A8E65E" opacity=".7"/>
    </g>

    <!-- little tree -->
    <g class="isl-tree">
      <rect x="183" y="132" width="8" height="46" rx="4" fill="#B5763A"/>
      <circle cx="187" cy="122" r="22" fill="#59B223"/>
      <circle cx="178" cy="114" r="9" fill="#9BE04F" opacity=".75"/>
    </g>

    <!-- portal -->
    <g class="portal">
      <path d="M196 192V114a84 84 0 0 1 168 0v78Z" fill="#8BD11B"/>
      <path d="M203 190V115a77 77 0 0 1 154 0v75Z" fill="#FFFFFF"/>
      <path d="M219 190V117a61 61 0 0 1 122 0v73Z" fill="url(#isl-portal-${variant})"/>
      ${
        variant === "ready"
          ? `<g class="portal-swirl"><path d="M280 152m-32 0a32 32 0 1 0 64 0a24 24 0 1 0-48 0a16 16 0 1 0 32 0" fill="none" stroke="#FFFFFF" stroke-opacity=".75" stroke-width="5" stroke-linecap="round"/></g>
             <circle cx="250" cy="110" r="4" fill="#FFFFFF" opacity=".9"/><circle cx="312" cy="128" r="3" fill="#FFFFFF" opacity=".8"/>`
          : variant === "waiting"
            ? `<path d="M226 190V118a54 54 0 0 1 108 0v72" fill="none" stroke="#FFFFFF" stroke-width="4" stroke-dasharray="2 12" stroke-linecap="round" opacity=".9"/>`
            : `<path d="M262 150c4-14 32-14 36 0" fill="none" stroke="#FFFFFF" stroke-width="5" stroke-linecap="round" opacity=".85"/>`
      }
      <ellipse cx="280" cy="194" rx="76" ry="11" fill="#EAF7D4"/>
      <ellipse cx="280" cy="193" rx="52" ry="6" fill="#FFFFFF" opacity=".7"/>
    </g>

    <!-- house -->
    <g class="isl-house" transform="translate(378 116)">
      <rect x="9" y="32" width="56" height="44" rx="7" fill="#FFFFFF" stroke="#F0E2CF" stroke-width="2"/>
      <path d="M2 37 37 6l35 31" fill="#FF6A5C" stroke="#FFFFFF" stroke-width="5" stroke-linejoin="round" stroke-linecap="round"/>
      <rect x="29" y="50" width="16" height="26" rx="5" fill="#44B2F0"/>
      <rect x="14" y="43" width="11" height="10" rx="2.5" fill="#FFD447"/>
      <rect x="50" y="43" width="11" height="10" rx="2.5" fill="#FFD447"/>
    </g>

    <!-- flowers -->
    <g class="isl-flowers">
      <circle cx="232" cy="206" r="4.5" fill="#FFFFFF"/><circle cx="232" cy="206" r="1.8" fill="#FFC93C"/>
      <circle cx="356" cy="204" r="4.5" fill="#FFFFFF"/><circle cx="356" cy="204" r="1.8" fill="#FFC93C"/>
      <circle cx="404" cy="200" r="4" fill="#FF8FB8"/><circle cx="404" cy="200" r="1.6" fill="#FFFFFF"/>
      <circle cx="150" cy="200" r="4" fill="#FF8FB8"/><circle cx="150" cy="200" r="1.6" fill="#FFFFFF"/>
    </g>

    ${
      lit
        ? `<g class="isl-sparkles">
            <path d="M380 60l3 8 8 3-8 3-3 8-3-8-8-3 8-3z" fill="#FFE066"/>
            <path d="M174 76l2.2 5.8 5.8 2.2-5.8 2.2-2.2 5.8-2.2-5.8-5.8-2.2 5.8-2.2z" fill="#FFFFFF"/>
            <path d="M420 120l1.8 4.6 4.6 1.8-4.6 1.8-1.8 4.6-1.8-4.6-4.6-1.8 4.6-1.8z" fill="#FFFFFF"/>
          </g>`
        : ""
    }
  </svg>`;
}

/** Soft cartoon cloud for the sky backdrop. */
export function cloud(cls: string): string {
  return `<svg class="cloud ${cls}" viewBox="0 0 220 90" aria-hidden="true" focusable="false">
    <path d="M40 78h140a32 32 0 0 0 0-64 44 44 0 0 0-80-4 36 36 0 0 0-56 28A20 20 0 0 0 40 78z" fill="#FFFFFF"/>
  </svg>`;
}

/** A tiny distant floating islet used as background decoration. */
export function islet(cls: string): string {
  return `<svg class="islet ${cls}" viewBox="0 0 120 80" aria-hidden="true" focusable="false">
    <path d="M14 34c14 18 30 36 46 42 16-6 32-24 46-42z" fill="#E7A55A"/>
    <ellipse cx="60" cy="34" rx="48" ry="11" fill="#FFE6A8"/>
    <ellipse cx="60" cy="31" rx="45" ry="9" fill="#93D836"/>
    <circle cx="46" cy="24" r="9" fill="#6BC22C"/><circle cx="58" cy="20" r="11" fill="#86D23C"/>
  </svg>`;
}
