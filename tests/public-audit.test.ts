import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { auditPublicTree } from "../scripts/audit-public.ts";

const projectRoot = resolve(fileURLToPath(new URL("../", import.meta.url)));

test("Public tree audit passes with zero findings on the LocalGobe public repository", () => {
  const findings = auditPublicTree(projectRoot);
  assert.deepEqual(findings, []);
});

test("Public tree audit detects forbidden binaries, account JSON, and research paths", () => {
  const dir = mkdtempSync(join(tmpdir(), "localgobe-audit-test-"));
  try {
    writeFileSync(join(dir, "sample.apk"), "fake");
    writeFileSync(join(dir, "localgobe-accounts.json"), "{}");
    writeFileSync(join(dir, "leak.ts"), `const p = "C:\\\\Users\\\\dev\\\\archive-corpus";`);

    const findings = auditPublicTree(dir);
    assert.ok(findings.some((f) => f.file === "sample.apk" && f.rule === "forbidden-binary-extension"));
    assert.ok(findings.some((f) => f.file === "localgobe-accounts.json" && f.rule === "forbidden-game-or-runtime-file"));
    assert.ok(findings.some((f) => f.file === "leak.ts" && f.rule === "research-archive-corpus-ref"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Public tree audit detects mutable toolchain URLs, copied Mogobe language, and production test fixtures", () => {
  const dir = mkdtempSync(join(tmpdir(), "localgobe-audit-purity-"));
  try {
    writeFileSync(
      join(dir, "download.ts"),
      `const url = "https://raw.githubusercontent.com/dadyeliuz/LocalGobe/toolchain-assets/asc.jar";`,
    );
    writeFileSync(
      join(dir, "copied.ts"),
      `const err = "חלה שגיאה ברכישת הפריט";`,
    );
    mkdirSync(join(dir, "src"), { recursive: true });
    writeFileSync(
      join(dir, "src", "fixture-leak.ts"),
      `const fixture = "TEST_FIXTURE_VALUE";`,
    );
    writeFileSync(
      join(dir, "src", "nav-leak.ts"),
      `const entry = { nameId: "TelAviv", hebrewName: "test" };`,
    );

    const findings = auditPublicTree(dir);
    assert.ok(findings.some((f) => f.file === "download.ts" && f.rule === "mutable-toolchain-url"));
    assert.ok(findings.some((f) => f.file === "copied.ts" && f.rule === "copied-mogobe-store-language"));
    assert.ok(findings.some((f) => f.file === "src/fixture-leak.ts" && f.rule === "production-test-fixture-leak"));
    assert.ok(findings.some((f) => f.file === "src/nav-leak.ts" && f.rule === "room-navigation-research-annotation"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
