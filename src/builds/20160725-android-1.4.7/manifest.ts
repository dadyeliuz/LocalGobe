import type { BuildDefinition } from "../types.ts";
import { APK_OPTIONAL_PREFIXES_20160725, APK_REQUIRED_ASSETS_20160725 } from "./apk-assets.ts";
import { EXTERNAL_RECOGNITION_RULES_20160725, MINI_GAMES_CATALOG_20160725 } from "./external-assets.ts";
import { getRuntimeConfig20160725 } from "./runtime-adapter.ts";

export const BUILD_20160725_ANDROID_1_4_7: BuildDefinition = Object.freeze({
  buildId: "20160725-android-1.4.7",
  displayName: "Mogobe Android 1.4.7",
  sourceType: "APK",
  apkMetadata: {
    expectedVersionName: "1.4.7",
    expectedPackageName: "air.mogobe.mogoTab.IL",
    clientAppVer: "1.0.0",
    knownApkHashes: [
      "963c46f70142ff085acdcdaa4f7d1a2242089ac5f886cfea262e5c140e849f56",
    ],
    airApplicationXmlPath: "assets/META-INF/AIR/application.xml",
  },
  bootstrapRoomId: 20,
  roomRequiresTxt: true,
  apkRequiredAssets: APK_REQUIRED_ASSETS_20160725,
  apkOptionalPrefixes: APK_OPTIONAL_PREFIXES_20160725,
  externalRecognitionRules: EXTERNAL_RECOGNITION_RULES_20160725,
  miniGames: MINI_GAMES_CATALOG_20160725,
  getRuntimeConfig: getRuntimeConfig20160725,
});
