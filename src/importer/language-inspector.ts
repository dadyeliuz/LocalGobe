/**
 * Minimal Mogobe Language XML Inspector
 *
 * Validates original Mogobe language files (lang.aspx) using minimal structural rules:
 * - Well-formed XML
 * - Root element is <Lang> or <Language>
 * - Contains <Sections> element
 * - Contains expected Mogobe <Section> / <M> structure
 * - Language matches Hebrew (1) when declared
 *
 * Contains ZERO copyrighted Mogobe strings or messages.
 */

export interface LanguageInspectionResult {
  valid: boolean;
  languageId: number;
  lastUpdate?: string;
  hasSections: boolean;
  sectionsCount?: number;
  messagesCount?: number;
  reason?: string;
}

/**
 * Strips UTF-8 Byte Order Mark (BOM) if present.
 */
export function stripUtf8Bom(text: string): string {
  if (text.charCodeAt(0) === 0xfeff) {
    return text.slice(1);
  }
  return text;
}

/**
 * Inspects a candidate language buffer or string using minimal structural criteria.
 *
 * For an imported language file to be recognized as a valid active asset:
 * 1. Well-formed XML structure (open/close tags for root and sections).
 * 2. Root element is <Lang> or <Language>.
 * 3. Contains <Sections> container.
 * 4. Language ID matches Hebrew (1) when declared.
 * 5. Contains at least one <Section> element.
 * 6. Contains at least one <M> message entry inside the language structure.
 *
 * The empty protocol shim (<Lang Language="1"><Sections /></Lang>) returns valid: false
 * so it is NEVER accepted as an imported language asset, keeping language.present = false.
 */
export function inspectMogobeLanguageXml(
  input: Buffer | string,
): LanguageInspectionResult {
  const rawText = typeof input === "string" ? input : input.toString("utf8");
  const text = stripUtf8Bom(rawText).trim();

  // 1. Basic well-formed XML check
  if (text.startsWith("<?xml")) {
    const xmlDeclEnd = text.indexOf("?>");
    if (xmlDeclEnd === -1) {
      return {
        valid: false,
        languageId: 0,
        hasSections: false,
        reason: "הצהרת XML אינה תקינה",
      };
    }
  }

  // Root element check: <Lang> or <Language>
  const rootMatch = /<(Lang|Language)[\s>]/i.exec(text);
  if (!rootMatch) {
    return {
      valid: false,
      languageId: 0,
      hasSections: false,
      reason: "הקובץ אינו מכיל תגית Lang ראשית של מוגובי",
    };
  }
  const rootTag = rootMatch[1];
  const closeRootRegex = new RegExp(`</${rootTag}>`, "i");
  if (!closeRootRegex.test(text)) {
    return {
      valid: false,
      languageId: 0,
      hasSections: false,
      reason: `תגית ראשית <${rootTag}> אינה סגורה כהלכה`,
    };
  }

  // 2. Must contain <Sections> element
  if (!/<Sections[\s>]/i.test(text)) {
    return {
      valid: false,
      languageId: 0,
      hasSections: false,
      reason: "הקובץ אינו מכיל מקטעי שפה (Sections) של מוגובי",
    };
  }
  if (!/<\/Sections>/i.test(text) && !/<Sections\s*\/>/i.test(text)) {
    return {
      valid: false,
      languageId: 0,
      hasSections: false,
      reason: "תגית <Sections> אינה סגורה כהלכה",
    };
  }

  // 3. Extract languageId (e.g. Language="1")
  let languageId = 1; // Default Hebrew
  const langMatch = /\bLanguage\s*=\s*["'](\d+)["']/i.exec(text);
  if (langMatch) {
    languageId = parseInt(langMatch[1], 10);
  }

  // If a language is specified and it's not Hebrew (1), flag as non-Hebrew
  if (langMatch && languageId !== 1) {
    return {
      valid: false,
      languageId,
      hasSections: true,
      reason: `קובץ שפה לשפה ${languageId} (נדרשת עברית - 1)`,
    };
  }

  // 4. Must contain at least one <Section> element
  const sectionMatches = text.match(/<Section[\s>]/gi);
  const sectionsCount = sectionMatches ? sectionMatches.length : 0;
  if (sectionsCount === 0) {
    return {
      valid: false,
      languageId,
      hasSections: false,
      sectionsCount: 0,
      reason: "לא נמצאו מקטעי שפה (Section) בתוך הקובץ",
    };
  }

  // 5. Must contain at least one <M> message entry
  const messageMatches = text.match(/<M[\s>]/gi);
  const messagesCount = messageMatches ? messageMatches.length : 0;
  if (messagesCount === 0) {
    return {
      valid: false,
      languageId,
      hasSections: true,
      sectionsCount,
      messagesCount: 0,
      reason: "לא נמצאו רשומות תוכן ושפה (M) בתוך הקובץ",
    };
  }

  // Extract lastUpdate if present
  let lastUpdate: string | undefined;
  const updateMatch = /\blastUpdate\s*=\s*["']([^"']+)["']/i.exec(text);
  if (updateMatch) {
    lastUpdate = updateMatch[1].trim();
  }

  return {
    valid: true,
    languageId,
    lastUpdate,
    hasSections: true,
    sectionsCount,
    messagesCount,
    reason: lastUpdate ? `עודכן ב-${lastUpdate}` : "קובץ שפה תקין",
  };
}
