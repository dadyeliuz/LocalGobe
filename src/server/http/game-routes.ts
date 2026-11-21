import { existsSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { readAirShimFile } from "../../compatibility/air/air-shims.ts";
import { readOriginalAsset, writeOriginalAsset } from "../../storage/build-store.ts";
import { getEntityRevisionsDir, readRevisionsRecord, verifyMapPopupCompatibility } from "../../storage/revisions-store.ts";
import { resolveRoomRevision } from "../../storage/room-resolver.ts";
import { getCategoryDir, getRuffleDistDir, getRuntimeFontsDir, getUnclassifiedDir } from "../../storage/paths.ts";
import { inspectMogobeChatXml } from "../../importer/chat-inspector.ts";
import type { HttpResponse } from "./api-routes.ts";
import { chatXml } from "./fixtures.ts";
import {
  authenticateLocalUser,
  buildLoginUResponse,
  buildLoginXmlResponse,
  buildServersXmlResponse,
  parseLoginURequest,
} from "./login-u.ts";
import { hasAccount, verifyAccountCredentials } from "../../storage/accounts-store.ts";

function mimeForPath(path: string): string {
  const lower = path.toLowerCase();
  if (lower.endsWith(".swf")) return "application/x-shockwave-flash";
  if (lower.endsWith(".txt")) return "text/plain; charset=utf-8";
  if (lower.endsWith(".xml")) return "application/xml; charset=utf-8";
  if (lower.endsWith(".mp3")) return "audio/mpeg";
  if (lower.endsWith(".json")) return "application/json; charset=utf-8";
  if (lower.endsWith(".wasm")) return "application/wasm";
  if (lower.endsWith(".js")) return "text/javascript; charset=utf-8";
  if (lower.endsWith(".css")) return "text/css; charset=utf-8";
  if (lower.endsWith(".ttf")) return "font/ttf";
  if (lower.endsWith(".otf")) return "font/otf";
  if (lower.endsWith(".woff2")) return "font/woff2";
  return "application/octet-stream";
}

function notFound(): HttpResponse {
  return { status: 404, mime: "text/plain; charset=utf-8", body: "Not found" };
}

function badRequest(msg = "Bad request"): HttpResponse {
  return { status: 400, mime: "text/plain; charset=utf-8", body: msg };
}

function tryPromoteUnclassifiedChatXml(buildId: string, langId: string, dataDir?: string): Buffer | null {
  try {
    const unclassDir = getUnclassifiedDir(buildId, dataDir);
    if (!existsSync(unclassDir)) return null;
    const entries = readdirSync(unclassDir);
    for (const entry of entries) {
      if (entry.toLowerCase().endsWith(".xml")) {
        const fullPath = join(unclassDir, entry);
        if (statSync(fullPath).isFile()) {
          const bytes = readFileSync(fullPath);
          const insp = inspectMogobeChatXml(bytes, entry);
          if (insp.valid) {
            const isTarget =
              String(insp.languageId) === langId ||
              ((langId === "1" || langId === "0" || langId === "4") && insp.languageId === 1);
            if (isTarget) {
              writeOriginalAsset(buildId, "interface", `Language/chat_${insp.languageId}.xml`, bytes, dataDir);
              try {
                rmSync(fullPath, { force: true });
              } catch {}
              return bytes;
            }
          }
        }
      }
    }
  } catch {}
  return null;
}

export function handleRuffleRoute(pathname: string, dataDir?: string): HttpResponse | null {
  if (!pathname.startsWith("/ruffle/")) return null;
  const name = pathname.slice("/ruffle/".length);
  if (!/^[A-Za-z0-9._-]+$/.test(name) || name.startsWith(".")) return badRequest("Invalid Ruffle path");
  let full = join(getRuffleDistDir(dataDir), name);
  if (!existsSync(full) && dataDir) {
    full = join(getRuffleDistDir(), name);
  }
  if (!existsSync(full) || !statSync(full).isFile()) return notFound();
  return { status: 200, mime: mimeForPath(name), body: readFileSync(full) };
}

export function handleFontRoute(pathname: string, dataDir?: string): HttpResponse | null {
  if (!pathname.startsWith("/local-fonts/")) return null;
  const name = pathname.slice("/local-fonts/".length);
  if (!/^[A-Za-z0-9._-]+$/.test(name) || name.startsWith(".")) return badRequest("Invalid font path");
  let full = join(getRuntimeFontsDir(dataDir), name);
  if (!existsSync(full) && dataDir) {
    full = join(getRuntimeFontsDir(), name);
  }
  if (!existsSync(full) || !statSync(full).isFile()) return notFound();
  return { status: 200, mime: mimeForPath(name), body: readFileSync(full) };
}

export function handleGameRoute(options: {
  rawUrl?: string;
  pathname?: string;
  url?: string;
  requestBody?: string;
  origin?: string;
  buildId: string;
  dataDir?: string;
}): HttpResponse | null {
  const pathname = options.pathname || options.url || options.rawUrl || "/";
  const rawUrl = options.rawUrl || options.url || pathname;
  const requestBody = options.requestBody || "";
  const origin = options.origin || "http://127.0.0.1:5173";
  const { buildId, dataDir } = options;
  let decoded: string;
  try {
    let cleanPath = pathname;
    const qIdx = cleanPath.indexOf("?");
    if (qIdx !== -1) cleanPath = cleanPath.slice(0, qIdx);
    decoded = decodeURIComponent(cleanPath);
  } catch {
    return badRequest("Invalid URL encoding");
  }

  if (
    decoded.includes("\\") ||
    decoded.includes("\0") ||
    decoded.split("/").some((part) => part === "." || part === "..")
  ) {
    return badRequest("Unsafe path");
  }

  if (decoded.includes("//")) {
    if (
      !decoded.toLowerCase().startsWith("/swf/assetsclean/mogowall//") &&
      !decoded.startsWith("/Swf/AssetsClean/Items//")
    ) {
      return badRequest("Unsafe path");
    }
    decoded = decoded.replace(/\/{2,}/g, "/");
  }

  const lower = decoded.toLowerCase();

  // ── 1. Clean-room AIR compatibility shims (/runtime/air/*) ──
  if (decoded.startsWith("/runtime/air/")) {
    const filename = decoded.slice("/runtime/air/".length);
    const bytes = readAirShimFile(filename, dataDir);
    if (!bytes) return notFound();
    return { status: 200, mime: "application/x-shockwave-flash", body: bytes };
  }

  // ── 2. Local service endpoints ──
  if (lower === "/crossdomain.xml") {
    return {
      status: 200,
      mime: "application/xml; charset=utf-8",
      body: '<?xml version="1.0"?><cross-domain-policy><allow-access-from domain="*"/></cross-domain-policy>',
    };
  }

  if (lower === "/servises/lang.aspx" || lower === "/services/lang.aspx" || lower === "/lang.aspx") {
    let langBytes: Buffer | null = null;
    const revRec = readRevisionsRecord(buildId, "interface", "Language", "he", dataDir);
    if (revRec?.activeRevisionKey && revRec.revisions[revRec.activeRevisionKey]) {
      const activeRev = revRec.revisions[revRec.activeRevisionKey];
      const revFile = activeRev.files["xml"];
      if (revFile) {
        const revPath = join(
          getEntityRevisionsDir(buildId, "interface", "Language", "he", dataDir),
          activeRev.revisionKey,
          revFile.filename,
        );
        if (existsSync(revPath)) {
          langBytes = readFileSync(revPath);
        }
      }
    }

    if (langBytes) {
      // Strip UTF-8 BOM if present
      if (langBytes.length >= 3 && langBytes[0] === 0xef && langBytes[1] === 0xbb && langBytes[2] === 0xbf) {
        langBytes = langBytes.subarray(3);
      }
      return { status: 200, mime: "application/xml; charset=utf-8", body: langBytes };
    }

    // When no active original language asset exists, return minimal empty protocol-only document
    // so LanguageManager dispatches Event.COMPLETE and native client does not hang.
    // Contains ZERO Mogobe messages, ZERO reconstructed UI strings.
    const emptyProtocolXml = '<?xml version="1.0" encoding="utf-8"?><Lang Language="1"><Sections /></Lang>';
    return { status: 200, mime: "application/xml; charset=utf-8", body: emptyProtocolXml };
  }

  if (
    lower === "/xmls/lang/chat_4.xml" ||
    lower === "/xmls/lang/chat_0.xml" ||
    lower === "/xmls/lang/chat_1.xml" ||
    lower.startsWith("/xmls/lang/chat_")
  ) {
    const rawFilename = decoded.split("/").pop() ?? "";
    const fnMatch = /chat_(\d+)\.xml/i.exec(rawFilename);
    const langId = fnMatch ? fnMatch[1] : "1";

    let chatBytes = readOriginalAsset(buildId, "interface", `Language/chat_${langId}.xml`, dataDir);

    if (!chatBytes && (langId === "1" || langId === "0" || langId === "4")) {
      chatBytes =
        readOriginalAsset(buildId, "interface", "Language/chat_1.xml", dataDir) ??
        readOriginalAsset(buildId, "interface", "Language/chat.xml", dataDir);
    }

    if (!chatBytes) {
      chatBytes = tryPromoteUnclassifiedChatXml(buildId, langId, dataDir);
    }

    if (chatBytes) {
      if (chatBytes.length >= 3 && chatBytes[0] === 0xef && chatBytes[1] === 0xbb && chatBytes[2] === 0xbf) {
        chatBytes = chatBytes.subarray(3);
      }
      return {
        status: 200,
        mime: "application/xml; charset=utf-8",
        body: chatBytes,
        headers: {
          "Cache-Control": "no-store, must-revalidate",
        },
      };
    }

    return { status: 200, mime: "application/xml; charset=utf-8", body: chatXml() };
  }

  if (lower === "/servises/loginu.aspx") {
    const cmd = parseLoginURequest(rawUrl, requestBody);
    if (!cmd) return badRequest("Invalid LoginU request");
    let authenticated = true;
    if (cmd.command === "Login") {
      authenticated = authenticateLocalUser(cmd, dataDir);
      if (!authenticated) {
        return { status: 403, mime: "text/plain; charset=utf-8", body: "Invalid credentials" };
      }
    }
    return {
      status: 200,
      mime: "application/xml; charset=utf-8",
      body: buildLoginUResponse(cmd, origin, dataDir, authenticated),
    };
  }

  if (lower === "/servises/login.aspx") {
    const params = new URL(rawUrl, "http://127.0.0.1").searchParams;
    const reqUser = params.get("user");
    const reqPass = params.get("pass");
    if (reqUser && reqPass && hasAccount(reqUser, dataDir)) {
      if (!verifyAccountCredentials(reqUser, reqPass, dataDir)) {
        return { status: 200, mime: "application/xml; charset=utf-8", body: buildLoginXmlResponse(false) };
      }
    }
    return { status: 200, mime: "application/xml; charset=utf-8", body: buildLoginXmlResponse(true) };
  }

  if (lower === "/servises/servers.aspx") {
    return { status: 200, mime: "application/xml; charset=utf-8", body: buildServersXmlResponse() };
  }

  // ── 3. Game category assets extracted from APK (/game/*) ──
  if (decoded.startsWith("/game/")) {
    const rel = decoded.slice("/game/".length);
    const bytes = readOriginalAsset(buildId, "game", rel, dataDir);
    if (!bytes) return notFound();
    return { status: 200, mime: mimeForPath(rel), body: bytes };
  }

  // ── 4. World Rooms (/Swf/AssetsClean/Rooms/* or /Swf/Rooms/room_*) ──
  if (lower.startsWith("/swf/assetsclean/rooms/")) {
    const rawFilename = decoded.slice("/Swf/AssetsClean/Rooms/".length);
    const roomNameMatch = /^room_(\d+)\.(swf|txt)$/i.exec(rawFilename);
    const filename = roomNameMatch ? `room_${roomNameMatch[1]}.${roomNameMatch[2].toLowerCase()}` : rawFilename;

    if (roomNameMatch) {
      const roomId = Number(roomNameMatch[1]);
      const ext = roomNameMatch[2].toLowerCase() as "swf" | "txt";
      const bundle = resolveRoomRevision(buildId, roomId, dataDir);
      if (bundle) {
        if (ext === "swf") {
          return {
            status: 200,
            mime: "application/x-shockwave-flash",
            body: bundle.swfBytes,
            headers: {
              "Cache-Control": "no-store, must-revalidate",
              "ETag": `"${bundle.swfSha256}"`,
            },
          };
        } else if (ext === "txt" && bundle.txtBytes) {
          let body = bundle.txtBytes;
          if (body[0] === 0xef && body[1] === 0xbb && body[2] === 0xbf) {
            body = body.subarray(3);
          }
          return {
            status: 200,
            mime: "text/plain; charset=utf-8",
            body,
            headers: {
              "Cache-Control": "no-store, must-revalidate",
              "ETag": `"${bundle.txtSha256 ?? ""}"`,
            },
          };
        }
      }
    }

    let raw = readOriginalAsset(buildId, "world", `Rooms/${filename}`, dataDir);
    if (!raw) return notFound();
    // Strip UTF-8 BOM in-memory only for room config TXT; never modify stored original bytes
    const body =
      filename.endsWith(".txt") && raw[0] === 0xef && raw[1] === 0xbb && raw[2] === 0xbf
        ? raw.subarray(3)
        : raw;
    return {
      status: 200,
      mime: mimeForPath(filename),
      body,
      headers: {
        "Cache-Control": "no-store, must-revalidate",
      },
    };
  }

  // ── 5. World Room Music (/Sound/Rooms/*) ──
  if (decoded.startsWith("/Sound/Rooms/")) {
    const filename = decoded.slice("/Sound/Rooms/".length);
    const bytes = readOriginalAsset(buildId, "world", `Sound/Rooms/${filename}`, dataDir);
    if (!bytes) return notFound();
    return { status: 200, mime: "audio/mpeg", body: bytes };
  }

  // ── 6. Items (/Swf/AssetsClean/Items/<Family>/<id>.swf) ──
  if (decoded.startsWith("/Swf/AssetsClean/Items/")) {
    const rel = decoded.slice("/Swf/AssetsClean/Items/".length);
    const bytes = readOriginalAsset(buildId, "items", rel, dataDir);
    if (!bytes) return notFound();
    return { status: 200, mime: "application/x-shockwave-flash", body: bytes };
  }

  // ── 7. Interface: ControlPanel config & Effects ──
  if (
    decoded === "/Swf/AssetsClean/ControlPanel/controlPanel.txt" ||
    decoded === "/Swf/Assets/ControlPanel/controlPanel.txt"
  ) {
    const raw = readOriginalAsset(buildId, "interface", "ControlPanel/controlPanel.txt", dataDir);
    if (!raw) return notFound();
    // Strip UTF-8 BOM in-memory only; never modify stored original file
    const body = raw[0] === 0xef && raw[1] === 0xbb && raw[2] === 0xbf ? raw.subarray(3) : raw;
    return { status: 200, mime: "text/plain; charset=utf-8", body };
  }

  if (
    decoded.startsWith("/Swf/AssetsClean/ControlPanel/Effects/") ||
    decoded.startsWith("/Swf/Assets/ControlPanel/Effects/")
  ) {
    const filename = decoded.split("/").pop() ?? "";
    const bytes = readOriginalAsset(buildId, "interface", `ControlPanel/Effects/${filename}`, dataDir);
    if (!bytes) return notFound();
    return { status: 200, mime: "application/x-shockwave-flash", body: bytes };
  }

  if (decoded.startsWith("/Sound/effects/")) {
    const rel = decoded.slice("/Sound/effects/".length);
    const bytes = readOriginalAsset(buildId, "interface", `Sound/effects/${rel}`, dataDir);
    if (!bytes) return notFound();
    return { status: 200, mime: "audio/mpeg", body: bytes };
  }

  if (decoded.startsWith("/Sound/")) {
    const rel = decoded.slice("/Sound/".length);
    const bytes = readOriginalAsset(buildId, "interface", `Sound/${rel}`, dataDir);
    if (!bytes) return notFound();
    return { status: 200, mime: "audio/mpeg", body: bytes };
  }

  if (lower.startsWith("/swf/assetsclean/mogowall/")) {
    const rel = decoded.slice("/Swf/AssetsClean/MogoWall/".length);
    let bytes = readOriginalAsset(buildId, "interface", `MogoWall/${rel}`, dataDir);
    if (!bytes) {
      const lowerRel = rel.toLowerCase();
      if (lowerRel === "mogowall.swf") {
        bytes = readOriginalAsset(buildId, "interface", "MogoWall/MogoWall.swf", dataDir);
      } else if (lowerRel === "friendcard.swf") {
        bytes = readOriginalAsset(buildId, "interface", "MogoWall/FriendCard.swf", dataDir);
      } else if (lowerRel === "mogowall.txt") {
        bytes = readOriginalAsset(buildId, "interface", "MogoWall/MogoWall.txt", dataDir);
      }
    }
    if (!bytes) return notFound();
    return {
      status: 200,
      mime: mimeForPath(rel),
      body: bytes,
      headers: {
        "Cache-Control": "no-store, must-revalidate",
      },
    };
  }

  if (decoded.startsWith("/Swf/AssetsClean/LoadingScreens/")) {
    const rel = decoded.slice("/Swf/AssetsClean/LoadingScreens/".length);
    const bytes = readOriginalAsset(buildId, "interface", `LoadingScreens/${rel}`, dataDir);
    if (!bytes) return notFound();
    return { status: 200, mime: mimeForPath(rel), body: bytes };
  }

  // ── 7b. Interface: Popups (/Swf/AssetsClean/Popups/* or /Swf/Assets/Popups/*) ──
  if (lower.startsWith("/swf/assetsclean/popups/") || lower.startsWith("/swf/assets/popups/")) {
    const rawFilename = decoded.split("/").pop() ?? "";
    const popupMatch = /^(?:p|popup)_(\d+)\.swf$/i.exec(rawFilename);
    const filename = popupMatch ? `p_${popupMatch[1]}.swf` : rawFilename;
    const popupId = popupMatch ? Number(popupMatch[1]) : null;

    let bytes: Buffer | null = null;
    if (popupId !== null) {
      const rec = readRevisionsRecord(buildId, "interface", "Popups", popupId, dataDir);
      if (rec && rec.activeRevisionKey && rec.revisions[rec.activeRevisionKey]?.files?.swf) {
        const fileInfo = rec.revisions[rec.activeRevisionKey].files.swf;
        const revPath = resolve(getEntityRevisionsDir(buildId, "interface", "Popups", popupId, dataDir), "revisions", rec.activeRevisionKey, fileInfo.filename);
        if (existsSync(revPath)) {
          bytes = readFileSync(revPath);
        }
      }
    }

    if (!bytes && popupId !== 3) {
      bytes = readOriginalAsset(buildId, "interface", `Popups/${filename}`, dataDir);
    }
    if (!bytes && popupId !== 3) {
      bytes = readOriginalAsset(buildId, "game", `Swf/Assets/Popups/${rawFilename}`, dataDir);
    }
    if (!bytes && popupId === 3) {
      const raw =
        readOriginalAsset(buildId, "interface", `Popups/${filename}`, dataDir) ||
        readOriginalAsset(buildId, "game", `Swf/Assets/Popups/${rawFilename}`, dataDir);
      if (raw && verifyMapPopupCompatibility(raw).compatible) {
        bytes = raw;
      }
    }

    if (!bytes) return notFound();
    return { status: 200, mime: "application/x-shockwave-flash", body: bytes };
  }

  // ── 8. Mini Games (/Swf/Assets/Games/Helps/*, /Swf/Apps/Games/*, /Swf/Rooms/*) ──
  if (decoded.startsWith("/Swf/Assets/Games/Helps/")) {
    const filename = decoded.slice("/Swf/Assets/Games/Helps/".length);
    const bytes = readOriginalAsset(buildId, "miniGames", `Helps/${filename}`, dataDir);
    if (bytes) return { status: 200, mime: "application/x-shockwave-flash", body: bytes };
  }

  if (lower.startsWith("/swf/apps/games/") || lower.startsWith("/swf/rooms/")) {
    const rawFilename = decoded.split("/").pop() ?? "";
    const roomNameMatch = /^room_(\d+)\.(swf|txt)$/i.exec(rawFilename);
    const roomFilename = roomNameMatch ? `room_${roomNameMatch[1]}.${roomNameMatch[2].toLowerCase()}` : rawFilename;
    let gameBytes: Buffer | null = null;

    if (roomNameMatch) {
      const roomId = Number(roomNameMatch[1]);
      const ext = roomNameMatch[2].toLowerCase() as "swf" | "txt";
      const rec = readRevisionsRecord(buildId, "world", "Rooms", roomId, dataDir);
      if (rec && rec.activeRevisionKey && rec.revisions[rec.activeRevisionKey]?.files?.[ext]) {
        const fileInfo = rec.revisions[rec.activeRevisionKey].files[ext];
        const revPath = resolve(getEntityRevisionsDir(buildId, "world", "Rooms", roomId, dataDir), "revisions", rec.activeRevisionKey, fileInfo.filename);
        if (existsSync(revPath)) {
          gameBytes = readFileSync(revPath);
        }
      }
    }

    if (!gameBytes) {
      gameBytes =
        readOriginalAsset(buildId, "miniGames", `Games/${rawFilename}`, dataDir) ??
        readOriginalAsset(buildId, "miniGames", `Managers/${rawFilename}`, dataDir) ??
        readOriginalAsset(buildId, "world", `Rooms/${roomFilename}`, dataDir);
    }
    if (gameBytes) {
      const body =
        roomFilename.endsWith(".txt") && gameBytes[0] === 0xef && gameBytes[1] === 0xbb && gameBytes[2] === 0xbf
          ? gameBytes.subarray(3)
          : gameBytes;
      return { status: 200, mime: mimeForPath(roomFilename), body };
    }
  }

  // ── 9. APK-bundled /Swf/Assets/* and /Swf/AssetsClean/* fallback ──
  if (decoded.startsWith("/Swf/Assets/") || decoded.startsWith("/Swf/AssetsClean/")) {
    const rel = decoded.startsWith("/Swf/Assets/")
      ? decoded.slice("/Swf/Assets/".length)
      : decoded.slice("/Swf/AssetsClean/".length);
    const bytes = readOriginalAsset(buildId, "game", `Swf/Assets/${rel}`, dataDir);
    if (bytes) return { status: 200, mime: mimeForPath(rel), body: bytes };
  }

  // Any remaining game/service path returns a clean 404
  if (/^\/(?:Swf|Sound|Xmls|servises|game|runtime\/air)(?:\/|$)/i.test(decoded)) {
    return notFound();
  }

  return null;
}
