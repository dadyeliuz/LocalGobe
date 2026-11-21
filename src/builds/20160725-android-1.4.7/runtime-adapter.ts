import type { BuildRuntimeConfig } from "../types.ts";
import { APK_REQUIRED_ASSETS_20160725 } from "./apk-assets.ts";

/**
 * Runtime adapter for Mogobe Android 1.4.7 (20160725-android-1.4.7).
 * Configures Ruffle AIR mode, local URL rewriting, and the internal AIR bootstrap loader.
 */
export function getRuntimeConfig20160725(origin: string): BuildRuntimeConfig {
  const normalizedOrigin = origin.replace(/\/+$/, "");
  const aneLibraryUrls = APK_REQUIRED_ASSETS_20160725
    .filter((asset) => asset.logicalId.startsWith("ane:") && asset.runtimeUrl)
    .map((asset) => asset.runtimeUrl!);

  return {
    playerRuntime: "air",
    deviceFontRenderer: "embedded",
    fontSources: ["/local-fonts/arimo.ttf"],
    rootUrl: "/runtime/air/AirBootstrap.swf",
    urlRewriteRules: [
      ["^http://mogobe\\.walla\\.co\\.il/", `${normalizedOrigin}/`],
      ["^https://mogobe\\.walla\\.co\\.il/", `${normalizedOrigin}/`],
    ],
    requiresAirShims: true,
    aneLibraryUrls,
    defaultParameters: {
      origin: normalizedOrigin,
      rootSwf: "/game/MogobeTabIL.swf",
    },
  };
}
