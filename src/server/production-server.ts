import { createReadStream, existsSync, statSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { extname, join, normalize, resolve } from "node:path";
import type { IUpdateService } from "../desktop/updater.ts";
import { getProjectRoot } from "../storage/paths.ts";
import { createLocalGobeMiddleware } from "./http/router.ts";
import { startSmartFoxRuntime, type SmartFoxRuntimeHandle } from "./smartfox/smartfox-server.ts";

export type ProductionServerOptions = {
  port?: number;
  host?: string;
  dataDir?: string;
  distDir?: string;
  startSmartFox?: boolean;
  updater?: IUpdateService;
};

export type ProductionServerHandle = {
  server: Server;
  host: string;
  port: number;
  origin: string;
  smartFoxReady: boolean;
  close: () => Promise<void>;
};

const MIME_TYPES: Readonly<Record<string, string>> = Object.freeze({
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  ".woff": "font/woff",
  ".ttf": "font/ttf",
  ".otf": "font/otf",
  ".wasm": "application/wasm",
  ".xml": "application/xml; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
});

function serveStaticFile(
  req: IncomingMessage,
  res: ServerResponse,
  filePath: string,
  contentType: string,
): void {
  try {
    const stats = statSync(filePath);
    if (!stats.isFile()) {
      res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
      res.end("Not Found");
      return;
    }

    res.writeHead(200, {
      "Content-Type": contentType,
      "Content-Length": stats.size,
      "X-Content-Type-Options": "nosniff",
      "X-Frame-Options": "SAMEORIGIN",
      "Cache-Control": filePath.endsWith(".html") ? "no-cache" : "public, max-age=31536000, immutable",
    });

    if (req.method === "HEAD") {
      res.end();
      return;
    }

    const stream = createReadStream(filePath);
    stream.on("error", () => {
      if (!res.headersSent) {
        res.writeHead(500, { "Content-Type": "text/plain; charset=utf-8" });
      }
      res.end("Internal Server Error");
    });
    stream.pipe(res);
  } catch {
    res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("Not Found");
  }
}

export async function startProductionServer(
  options: ProductionServerOptions = {},
): Promise<ProductionServerHandle> {
  const host = options.host ?? "127.0.0.1";
  if (host !== "127.0.0.1" && host !== "localhost") {
    throw new Error(`Production server security policy restricts host binding to loopback (got ${host})`);
  }

  const distDir = options.distDir ? resolve(options.distDir) : resolve(getProjectRoot(), "dist");
  const indexHtmlPath = join(distDir, "index.html");

  let runtimeHandle: SmartFoxRuntimeHandle | null = null;
  let smartFoxReady = false;

  if (options.startSmartFox !== false && process.env.LOCALGOBE_NO_AUTO_SERVER !== "1") {
    try {
      runtimeHandle = await startSmartFoxRuntime({ dataDir: options.dataDir });
      smartFoxReady = true;
    } catch (err) {
      const code = (err as { code?: string })?.code;
      if (code === "EADDRINUSE") {
        smartFoxReady = true;
      } else {
        console.warn("[localgobe-prod] SmartFox server did not start:", err);
      }
    }
  }

  const middleware = createLocalGobeMiddleware({
    dataDir: options.dataDir,
    isSmartFoxReady: () => smartFoxReady,
    updater: options.updater,
  });

  const server = createServer(async (req, res) => {
    let nextCalled = false;
    await middleware(req, res, () => {
      nextCalled = true;
    });

    if (!nextCalled || res.writableEnded) {
      return;
    }

    // Static frontend delivery
    const rawUrl = req.url ?? "/";
    const parsed = new URL(rawUrl, "http://127.0.0.1");
    let pathname = decodeURIComponent(parsed.pathname);

    // Prevent directory traversal
    const normalized = normalize(pathname).replace(/^(\.\.[/\\])+/, "");
    const safeRel = normalized.replace(/^[/\\]+/, "");
    let targetFile = join(distDir, safeRel);

    // If target is root or empty, point to index.html
    if (safeRel === "" || pathname === "/") {
      targetFile = indexHtmlPath;
    }

    if (existsSync(targetFile) && statSync(targetFile).isFile()) {
      const ext = extname(targetFile).toLowerCase();
      const contentType = MIME_TYPES[ext] ?? "application/octet-stream";
      serveStaticFile(req, res, targetFile, contentType);
      return;
    }

    // SPA fallback: if not found and request does not look like a static asset with extension
    const hasAssetExtension = /\.[a-z0-9]{2,8}$/i.test(pathname);
    if (!hasAssetExtension && existsSync(indexHtmlPath)) {
      serveStaticFile(req, res, indexHtmlPath, "text/html; charset=utf-8");
      return;
    }

    res.writeHead(404, {
      "Content-Type": "text/plain; charset=utf-8",
      "X-Content-Type-Options": "nosniff",
    });
    res.end("Not Found");
  });

  const targetPort = options.port ?? 0;

  await new Promise<void>((resolvePromise, rejectPromise) => {
    server.once("error", rejectPromise);
    server.listen(targetPort, host, () => {
      server.removeListener("error", rejectPromise);
      resolvePromise();
    });
  });

  const address = server.address() as AddressInfo;
  const actualPort = address.port;
  const origin = `http://${host}:${actualPort}`;

  return {
    server,
    host,
    port: actualPort,
    origin,
    smartFoxReady,
    close: async () => {
      await new Promise<void>((resolveClose) => {
        server.close(() => resolveClose());
      });
      if (runtimeHandle) {
        await runtimeHandle.close();
      }
    },
  };
}
