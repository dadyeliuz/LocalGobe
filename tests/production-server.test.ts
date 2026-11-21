import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { startProductionServer, type ProductionServerHandle } from "../src/server/production-server.ts";

describe("Production HTTP Server", () => {
  const testDir = join(process.cwd(), "temp-test-prod-server-" + Date.now());
  const distDir = join(testDir, "dist");
  const dataDir = join(testDir, "data");

  before(() => {
    mkdirSync(distDir, { recursive: true });
    mkdirSync(dataDir, { recursive: true });
    writeFileSync(join(distDir, "index.html"), "<!DOCTYPE html><html><body><h1>LocalGobe</h1></body></html>", "utf8");
    writeFileSync(join(distDir, "test.css"), "body { margin: 0; }", "utf8");
    writeFileSync(join(distDir, "app.js"), "console.log('ready');", "utf8");
  });

  after(() => {
    try {
      rmSync(testDir, { recursive: true, force: true });
    } catch {
      // ignore cleanup
    }
  });

  it("binds to loopback on a dynamically assigned port and serves API and static assets", async () => {
    const handle: ProductionServerHandle = await startProductionServer({
      port: 0,
      host: "127.0.0.1",
      distDir,
      dataDir,
      startSmartFox: false,
    });

    try {
      assert.ok(handle.port > 0, "Allocated port must be positive");
      assert.equal(handle.host, "127.0.0.1");
      assert.equal(handle.origin, `http://127.0.0.1:${handle.port}`);

      // 1. API Route: /api/builds
      const apiRes = await fetch(`${handle.origin}/api/builds`);
      assert.equal(apiRes.status, 200);
      assert.equal(apiRes.headers.get("content-type"), "application/json; charset=utf-8");
      const body = await apiRes.json();
      assert.ok(Array.isArray(body.installed));
      assert.ok(Array.isArray(body.supported));

      // 2. Static root: index.html
      const rootRes = await fetch(`${handle.origin}/`);
      assert.equal(rootRes.status, 200);
      assert.equal(rootRes.headers.get("x-content-type-options"), "nosniff");
      assert.equal(rootRes.headers.get("x-frame-options"), "SAMEORIGIN");
      const htmlText = await rootRes.text();
      assert.ok(htmlText.includes("LocalGobe"));

      // 3. Static asset: test.css
      const cssRes = await fetch(`${handle.origin}/test.css`);
      assert.equal(cssRes.status, 200);
      assert.equal(cssRes.headers.get("content-type"), "text/css; charset=utf-8");
      const cssText = await cssRes.text();
      assert.ok(cssText.includes("margin: 0"));

      // 4. Missing asset with extension: 404
      const missingAssetRes = await fetch(`${handle.origin}/missing.png`);
      assert.equal(missingAssetRes.status, 404);

      // 5. SPA navigation route without extension: index.html fallback
      const spaRes = await fetch(`${handle.origin}/some/client/route`);
      assert.equal(spaRes.status, 200);
      const spaHtml = await spaRes.text();
      assert.ok(spaHtml.includes("LocalGobe"));
    } finally {
      await handle.close();
    }
  });

  it("enforces loopback host security policy", async () => {
    await assert.rejects(
      async () => {
        await startProductionServer({
          host: "0.0.0.0",
          distDir,
          dataDir,
          startSmartFox: false,
        });
      },
      /Production server security policy restricts host binding to loopback/,
    );
  });
});
