/** Minimal HTML-string helpers shared by all views (pure; safe to import in Node tests). */

const ESCAPES: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };

export function esc(value: unknown): string {
  return String(value ?? "").replace(/[&<>"']/g, (c) => ESCAPES[c]);
}

/** Join class names, skipping falsy values. */
export function cx(...names: Array<string | false | null | undefined>): string {
  return names.filter(Boolean).join(" ");
}

/** Hebrew-friendly number formatting (Western digits, thousands separators). */
export function num(n: number): string {
  return new Intl.NumberFormat("he-IL").format(n);
}
