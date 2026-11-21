import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { getAirShimsDir } from "../../storage/paths.ts";

export const REQUIRED_AIR_SHIM_FILES = Object.freeze([
  "AirBootstrap.swf",
  "air_network_info_shim.swf",
  "stage_text_init_options_shim.swf",
  "stage_text_shim.swf",
]);

export type AirShimsStatus = {
  ready: boolean;
  directory: string;
  present: string[];
  missing: string[];
};

export function getAirShimsStatus(dataDir?: string): AirShimsStatus {
  const dir = getAirShimsDir(dataDir);
  const present: string[] = [];
  const missing: string[] = [];
  for (const name of REQUIRED_AIR_SHIM_FILES) {
    const full = join(dir, name);
    if (existsSync(full) && statSync(full).isFile()) {
      present.push(name);
    } else {
      missing.push(name);
    }
  }
  return {
    ready: missing.length === 0,
    directory: dir,
    present,
    missing,
  };
}

export function readAirShimFile(filename: string, dataDir?: string): Buffer | null {
  if (!REQUIRED_AIR_SHIM_FILES.includes(filename)) return null;
  if (dataDir) {
    const customPath = join(getAirShimsDir(dataDir), filename);
    if (existsSync(customPath) && statSync(customPath).isFile()) {
      return readFileSync(customPath);
    }
  }
  const defaultPath = join(getAirShimsDir(), filename);
  if (!existsSync(defaultPath) || !statSync(defaultPath).isFile()) return null;
  return readFileSync(defaultPath);
}
