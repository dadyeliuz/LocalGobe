import type { ContentCategory } from "../builds/types.ts";
import type { InstalledBuildManifest, StoredAssetRecord } from "../storage/manifest-generator.ts";

export type ApkImportResult =
  | {
      ok: true;
      buildId: string;
      displayName: string;
      matchedBy: "sha256" | "air-metadata";
      apkSha256: string;
      extractedCount: number;
      hashMismatches: Array<{ logicalId: string; storagePath: string; expected: string; actual: string }>;
      manifest: InstalledBuildManifest;
    }
  | {
      ok: false;
      code: "UNSUPPORTED_APK" | "INVALID_ARCHIVE" | "SECURITY_VIOLATION" | "HASH_MISMATCH" | "MISSING_REQUIRED_APK_ASSET";
      userMessage: string;
      details?: {
        apkSha256?: string;
        packageName?: string;
        versionName?: string;
        technicalError?: string;
      };
    };

export type ConfidenceLevel =
  | "KNOWN_EXACT"
  | "KNOWN_PATTERN"
  | "PROBABLE_MOGOBE"
  | "INVALID_OR_UNRELATED";

export type ClassificationResult =
  | {
      recognized: true;
      confidence: "KNOWN_EXACT" | "KNOWN_PATTERN" | "PROBABLE_MOGOBE";
      logicalId: string;
      category: ContentCategory;
      storagePath: string;
      runtimeUrl?: string;
      required: boolean;
      feature?: string;
      matchedBy: StoredAssetRecord["matchedBy"];
      rank: number;
      entityType?: "room" | "popup" | "language" | "chat-language" | "other";
      entityId?: number | string;
      role?: string;
      revisionKey?: string;
      timestamp?: string;
      languageInspection?: import("./language-inspector.ts").LanguageInspectionResult;
      chatInspection?: import("./chat-inspector.ts").ChatInspectionResult;
    }
  | {
      recognized: false;
      confidence: "PROBABLE_MOGOBE";
      reason: string;
      evidence: string;
      detectedType: "swf" | "mp3" | "text" | "data";
    }
  | {
      recognized: false;
      confidence: "INVALID_OR_UNRELATED";
      reason: string;
    };

export type FileImportItemResult = {
  relativePath: string;
  status: "added" | "updated" | "duplicate" | "conflict-kept-existing" | "unclassified" | "unknown" | "rejected";
  category?: ContentCategory;
  logicalId?: string;
  confidence?: ConfidenceLevel;
  reason?: string;
};

export type ExternalImportSummary = {
  buildId: string;
  addedCount: number;
  updatedCount: number;
  duplicateCount: number;
  conflictCount: number;
  unclassifiedCount: number;
  unknownCount: number;
  rejectedCount: number;
  addedByCategory: Record<ContentCategory, number>;
  unknownFiles: string[];
  unclassifiedFiles: Array<{
    filename: string;
    relativePath: string;
    evidence: string;
    detectedType: "swf" | "mp3" | "text" | "data";
  }>;
  conflicts: Array<{ relativePath: string; logicalId: string; existingSha256: string; incomingSha256: string }>;
  items: FileImportItemResult[];
  manifest: InstalledBuildManifest;
};
