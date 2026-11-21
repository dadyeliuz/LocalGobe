import type { IncomingMessage, ServerResponse } from "node:http";
import type { IUpdateService } from "../../desktop/updater.ts";
import { listInstalledBuilds } from "../../storage/build-store.ts";
import { handleApiRoute, type HttpResponse } from "./api-routes.ts";
import { handleFontRoute, handleGameRoute, handleRuffleRoute } from "./game-routes.ts";

const MAX_UPLOAD_BYTES = 128 * 1024 * 1024; // 128 MB max APK upload

export type LocalGobeRouterOptions = {
  dataDir?: string;
  isSmartFoxReady?: () => boolean;
  updater?: IUpdateService;
};

export function createLocalGobeMiddleware(options: LocalGobeRouterOptions = {}) {
  let activeBuildId = listInstalledBuilds(options.dataDir)[0]?.buildId ?? "20160725-android-1.4.7";

  return async function localGobeMiddleware(
    req: IncomingMessage,
    res: ServerResponse,
    next: () => void,
  ): Promise<void> {
    const rawUrl = req.url ?? "/";
    const parsedUrl = new URL(rawUrl, "http://127.0.0.1:5173");
    const pathname = parsedUrl.pathname;
    const method = (req.method ?? "GET").toUpperCase();
    const host = req.headers.host ?? "127.0.0.1:5173";
    const origin = `http://${host}`;

    const isHandledPrefix =
      pathname.startsWith("/api/") ||
      pathname.startsWith("/ruffle/") ||
      pathname.startsWith("/local-fonts/") ||
      pathname.startsWith("/runtime/air/") ||
      pathname.startsWith("/game/") ||
      pathname.startsWith("/Swf/") ||
      pathname.startsWith("/swf/") ||
      pathname.startsWith("/Sound/") ||
      pathname.startsWith("/sound/") ||
      pathname.startsWith("/Xmls/") ||
      pathname.startsWith("/xmls/") ||
      pathname.toLowerCase().startsWith("/servises/") ||
      pathname.toLowerCase() === "/crossdomain.xml";

    if (!isHandledPrefix) {
      next();
      return;
    }

    // Buffer request body for POST/PUT with size cap
    let bodyBuf: Buffer = Buffer.alloc(0);
    if (method === "POST" || method === "PUT") {
      const chunks: Buffer[] = [];
      let total = 0;
      for await (const chunk of req) {
        const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        total += buf.length;
        if (total > MAX_UPLOAD_BYTES) {
          res.statusCode = 413;
          res.setHeader("Content-Type", "application/json; charset=utf-8");
          res.end(JSON.stringify({ error: "Upload exceeds maximum allowed size" }));
          return;
        }
        chunks.push(buf);
      }
      bodyBuf = Buffer.concat(chunks);
    }

    let response: HttpResponse | null = null;
    try {
      response =
        handleApiRoute({
          method,
          pathname,
          query: parsedUrl.searchParams,
          headers: req.headers,
          body: bodyBuf,
          origin,
          dataDir: options.dataDir,
          smartFoxReady: options.isSmartFoxReady?.() ?? true,
          activeBuildId,
          setActiveBuildId: (id) => {
            activeBuildId = id;
          },
          updater: options.updater,
        }) ??
        handleRuffleRoute(pathname, options.dataDir) ??
        handleFontRoute(pathname, options.dataDir) ??
        handleGameRoute({
          rawUrl,
          pathname,
          requestBody: bodyBuf.toString("utf8"),
          origin,
          buildId: activeBuildId,
          dataDir: options.dataDir,
        });
    } catch (err) {
      res.statusCode = 500;
      res.setHeader("Content-Type", "application/json; charset=utf-8");
      res.end(JSON.stringify({ error: err instanceof Error ? err.message : String(err) }));
      return;
    }

    if (!response) {
      next();
      return;
    }

    res.statusCode = response.status;
    res.setHeader("Content-Type", response.mime);
    res.setHeader("Cache-Control", "no-store");
    if (response.headers) {
      for (const [k, v] of Object.entries(response.headers)) {
        res.setHeader(k, v);
      }
    }
    res.end(response.body);
  };
}
