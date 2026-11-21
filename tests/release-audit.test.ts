import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { auditPackagedRelease } from "../scripts/audit-release.ts";

describe("Release Audit", () => {
  it("passes cleanly on a valid package tree with LocalGobe-owned shims and required licenses", () => {
    const testDir = join(tmpdir(), "localgobe-audit-test-" + Date.now());
    const resourcesDir = join(testDir, "win-unpacked", "resources");
    const airDir = join(resourcesDir, "runtime", "air");
    const fontsDir = join(resourcesDir, "runtime", "fonts");

    try {
      mkdirSync(airDir, { recursive: true });
      mkdirSync(fontsDir, { recursive: true });

      // Valid LocalGobe shims
      writeFileSync(join(airDir, "AirBootstrap.swf"), "CWS...");
      writeFileSync(join(airDir, "stage_text_shim.swf"), "CWS...");
      writeFileSync(join(airDir, "stage_text_init_options_shim.swf"), "CWS...");
      writeFileSync(join(airDir, "air_network_info_shim.swf"), "CWS...");

      // Required licenses
      writeFileSync(join(testDir, "win-unpacked", "LICENSE.electron.txt"), "Electron MIT License...");
      writeFileSync(join(testDir, "win-unpacked", "LICENSES.chromium.html"), "Chromium Licenses...");
      writeFileSync(join(resourcesDir, "LICENSE"), "MIT License...");
      writeFileSync(join(resourcesDir, "THIRD_PARTY_NOTICES.md"), "# Notices...");
      writeFileSync(join(resourcesDir, "LICENSE_MIT_RUFFLE"), "MIT...");
      writeFileSync(join(resourcesDir, "LICENSE_APACHE_RUFFLE"), "Apache...");
      writeFileSync(join(fontsDir, "OFL.txt"), "SIL Open Font License...");

      const result = auditPackagedRelease(testDir);
      assert.equal(result.packagedMogobeOriginalFiles, 0);
      assert.equal(result.packagedRuntimeUserDataFiles, 0);
      assert.equal(result.packagedSecrets, 0);
      assert.equal(result.packagedResearchPathLeaks, 0);
      assert.equal(result.violations.length, 0);
    } finally {
      try {
        rmSync(testDir, { recursive: true, force: true });
      } catch {}
    }
  });

  it("detects unauthorized SWF binaries, Mogobe APKs, and accounts files", () => {
    const testDir = join(tmpdir(), "localgobe-audit-bad-" + Date.now());
    const resourcesDir = join(testDir, "win-unpacked", "resources");
    const airDir = join(resourcesDir, "runtime", "air");
    const fontsDir = join(resourcesDir, "runtime", "fonts");

    try {
      mkdirSync(airDir, { recursive: true });
      mkdirSync(fontsDir, { recursive: true });

      // Required licenses
      writeFileSync(join(testDir, "win-unpacked", "LICENSE.electron.txt"), "Electron MIT License...");
      writeFileSync(join(testDir, "win-unpacked", "LICENSES.chromium.html"), "Chromium Licenses...");
      writeFileSync(join(resourcesDir, "LICENSE"), "MIT License...");
      writeFileSync(join(resourcesDir, "THIRD_PARTY_NOTICES.md"), "# Notices...");
      writeFileSync(join(resourcesDir, "LICENSE_MIT_RUFFLE"), "MIT...");
      writeFileSync(join(resourcesDir, "LICENSE_APACHE_RUFFLE"), "Apache...");
      writeFileSync(join(fontsDir, "OFL.txt"), "SIL Open Font License...");

      // Forbidden Mogobe files injected
      writeFileSync(join(resourcesDir, "MogobeTabIL.swf"), "FWS...");
      writeFileSync(join(resourcesDir, "game.apk"), "PK...");
      writeFileSync(join(resourcesDir, "localgobe-accounts.json"), "{}");

      const result = auditPackagedRelease(testDir);
      assert.ok(result.packagedMogobeOriginalFiles >= 2, "Must detect MogobeTabIL.swf and game.apk");
      assert.ok(result.packagedRuntimeUserDataFiles >= 1, "Must detect localgobe-accounts.json");
      assert.ok(result.violations.length >= 3);
    } finally {
      try {
        rmSync(testDir, { recursive: true, force: true });
      } catch {}
    }
  });
});
