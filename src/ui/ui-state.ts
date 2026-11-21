import type { ContentContext } from "./model.ts";
import type { ImportSession } from "./import-session.ts";

/** Dialog-like surfaces that float above the current screen. */
export type Sheet =
  | { kind: "add"; context: ContentContext }
  | { kind: "import"; session: ImportSession; id: number }
  | { kind: "apk"; phase: "checking" }
  | { kind: "apk"; phase: "recognized"; displayName: string }
  | { kind: "apk"; phase: "error"; code: string; technical: string }
  | { kind: "need-apk" }
  | { kind: "details"; confirmRemove: boolean }
  | { kind: "settings" }
  | { kind: "missing-log" }
  | { kind: "room-revisions" };

/** Stable identity used to decide whether a sheet can be patched instead of rebuilt. */
export function sheetKey(sheet: Sheet | null): string {
  if (!sheet) return "none";
  switch (sheet.kind) {
    case "add":
      return `add`;
    case "import":
      return `import:${sheet.id}:${sheet.session.phase}`;
    case "apk":
      return `apk:${sheet.phase}`;
    case "details":
      return `details:${sheet.confirmRemove}`;
    default:
      return sheet.kind;
  }
}

/** Whether the user may dismiss the sheet right now (busy states are not dismissible). */
export function sheetDismissible(sheet: Sheet | null): boolean {
  if (!sheet) return false;
  if (sheet.kind === "apk" && sheet.phase === "checking") return false;
  if (sheet.kind === "import" && sheet.session.phase !== "done") return false;
  return true;
}

/** Busy = a long-running import is in flight; new drops are ignored meanwhile. */
export function isBusy(sheet: Sheet | null): boolean {
  return Boolean(sheet) && !sheetDismissible(sheet) && sheet!.kind !== "need-apk";
}
