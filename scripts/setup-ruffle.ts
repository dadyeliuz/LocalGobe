import { existsSync, statSync } from "node:fs";
import { join } from "node:path";
import { getAirShimsStatus } from "../src/compatibility/air/air-shims.ts";
import { getRuffleDistDir } from "../src/storage/paths.ts";

const ruffleDir = getRuffleDistDir();
const ruffleJs = join(ruffleDir, "ruffle.js");
const ruffleReady = existsSync(ruffleJs) && statSync(ruffleJs).isFile();
const airStatus = getAirShimsStatus();

console.log("LocalGobe Runtime Check");
console.log("-----------------------");
console.log(`Ruffle selfhosted dir: ${ruffleDir}`);
console.log(`Ruffle status:         ${ruffleReady ? "READY" : "NOT INSTALLED"}`);
if (!ruffleReady) {
  console.log("  -> Follow ruffle/README.md to build Ruffle and copy dist/ into data/runtime/ruffle/");
}
console.log(`AIR shims dir:         ${airStatus.directory}`);
console.log(`AIR shims status:      ${airStatus.ready ? "READY" : `MISSING (${airStatus.missing.join(", ")})`}`);
