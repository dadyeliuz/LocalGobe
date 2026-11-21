export type BuildSourceType = "APK" | "WEB_FILES" | "OTHER";

export type ContentCategory = "game" | "interface" | "world" | "items" | "miniGames";

export type ItemFamily =
  | "IconS"
  | "IconW"
  | "BigItem"
  | "BtnItem"
  | "BtnAccessory"
  | "Cat"
  | "Gift"
  | "RoomItem";

export const ITEM_FAMILIES: readonly ItemFamily[] = Object.freeze([
  "IconS",
  "IconW",
  "BigItem",
  "BtnItem",
  "BtnAccessory",
  "Cat",
  "Gift",
  "RoomItem",
]);

export type ApkAssetSpec = {
  /** Entry path inside the APK archive (forward-slash normalized). */
  apkPath: string;
  /** Destination relative path inside builds/<buildId>/game/. */
  storagePath: string;
  /** Logical identifier for manifests and diagnostics. */
  logicalId: string;
  /** Whether this asset is required for Game readiness. */
  required: boolean;
  /** Expected lowercase SHA-256 hex digest, when known. */
  expectedSha256?: string;
  /** Runtime URL path served by LocalGobe (if directly requested). */
  runtimeUrl?: string;
  /** Human-readable provenance note. */
  note?: string;
};

export type ApkWhitelistPrefix = {
  apkPrefix: string;
  storagePrefix: string;
  extensions: readonly string[];
  description: string;
};

export type RecognitionRule = {
  logicalId: string;
  category: ContentCategory;
  feature: string;
  required: boolean;
  /** Known lowercase SHA-256 hashes (highest priority). */
  knownHashes: readonly string[];
  /** Canonical historical URL/path patterns (normalized lowercase, forward slashes). */
  canonicalPaths: readonly string[];
  /** Weak fallback filenames (only used when unambiguous). */
  filenames?: readonly string[];
  /** Destination relative path under builds/<buildId>/<category>/. */
  storagePath: string;
  /** Runtime URL path served by LocalGobe. */
  runtimeUrl: string;
  /** Compatible build IDs. */
  compatibleBuilds: readonly string[];
  /** Known historical generations (informational metadata). */
  knownGenerations?: readonly string[];
  /** Provenance note. */
  provenanceNote?: string;
  /** File kind for structural validation. */
  structuralKind?: "swf" | "txt" | "xml" | "mp3" | "any";
};

export type MiniGameSpec = {
  id: string;
  displayName: string;
  roomId: number;
  managerSwf: "GameManager" | "ExternalGameManager";
  mainSwf: string;
  requiresXml: boolean;
  xmlFile?: string;
  helpSwf?: string;
  secondarySwfs?: readonly string[];
};

export type MiniGameAvailabilityState =
  | "Available"
  | "Missing original configuration"
  | "Missing original game file"
  | "Missing original dependency";

export type BuildRuntimeConfig = {
  playerRuntime: "air" | "flashPlayer";
  deviceFontRenderer?: "embedded" | "canvas";
  fontSources?: readonly string[];
  rootUrl: string;
  urlRewriteRules: ReadonlyArray<readonly [string, string]>;
  requiresAirShims: boolean;
  aneLibraryUrls: readonly string[];
  defaultParameters: Readonly<Record<string, string>>;
};

export type BuildDefinition = {
  buildId: string;
  displayName: string;
  sourceType: BuildSourceType;
  apkMetadata?: {
    expectedVersionName: string;
    expectedPackageName: string;
    clientAppVer: string;
    knownApkHashes: readonly string[];
    airApplicationXmlPath: string;
  };
  bootstrapRoomId: number;
  roomRequiresTxt: boolean;
  apkRequiredAssets: readonly ApkAssetSpec[];
  apkOptionalPrefixes: readonly ApkWhitelistPrefix[];
  externalRecognitionRules: readonly RecognitionRule[];
  miniGames: readonly MiniGameSpec[];
  getRuntimeConfig(origin: string): BuildRuntimeConfig;
};
