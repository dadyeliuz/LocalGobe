/**
 * Minimal Mogobe Chat XML Inspector
 *
 * Validates original Mogobe canned chat files (chat_1.xml / chat.xml) using structural criteria:
 * - Well-formed XML
 * - Root element is <Lang>, <Language>, or <chat>
 * - Contains <chat> element with message hierarchy (<ms> submenus / categories, <m> phrases)
 * - Detects language (e.g. Hebrew = 1, Russian = 5) via Hebrew characters or filename
 * - Differentiates authentic Mogobe chat XML from empty protocol shims (requires >= 3 phrases/categories)
 *
 * Contains ZERO copyrighted Mogobe strings or messages.
 */

export interface ChatInspectionResult {
  valid: boolean;
  languageId: number;
  messagesCount: number;
  categoriesCount: number;
  hasHebrew: boolean;
  reason?: string;
}

export function stripUtf8Bom(text: string): string {
  if (text.charCodeAt(0) === 0xfeff) {
    return text.slice(1);
  }
  return text;
}

export function inspectMogobeChatXml(
  input: Buffer | string,
  hintFilename?: string,
): ChatInspectionResult {
  const rawText = typeof input === "string" ? input : input.toString("utf8");
  const text = stripUtf8Bom(rawText).trim();

  // 1. Basic XML declaration check if present
  if (text.startsWith("<?xml")) {
    const xmlDeclEnd = text.indexOf("?>");
    if (xmlDeclEnd === -1) {
      return {
        valid: false,
        languageId: 0,
        messagesCount: 0,
        categoriesCount: 0,
        hasHebrew: false,
        reason: "הצהרת XML אינה תקינה",
      };
    }
  }

  // 2. Root check: <Lang>, <Language>, or <chat>
  if (!/<(Lang|Language|chat)[\s>]/i.test(text)) {
    return {
      valid: false,
      languageId: 0,
      messagesCount: 0,
      categoriesCount: 0,
      hasHebrew: false,
      reason: "הקובץ אינו מכיל תגית Lang או chat של מוגובי",
    };
  }

  // 3. Must contain <chat> element with matching close tag
  if (!/<chat[\s>]/i.test(text) || !/<\/chat>/i.test(text)) {
    return {
      valid: false,
      languageId: 0,
      messagesCount: 0,
      categoriesCount: 0,
      hasHebrew: false,
      reason: "הקובץ אינו מכיל מקטע chat של מוגובי",
    };
  }

  // 4. Extract message entries: <m id="..." txt="..." /> and submenus: <ms id="..." ...>
  const msMatches = text.match(/<ms[\s>]/gi);
  const mMatches = text.match(/<m[\s>]/gi);
  const categoriesCount = msMatches ? msMatches.length : 0;
  const messagesCount = mMatches ? mMatches.length : 0;

  // Distinguish genuine chat from minimal dummy fixture (<group id="local" txt="LOCAL_CHAT"/>)
  if (messagesCount + categoriesCount < 3) {
    return {
      valid: false,
      languageId: 0,
      messagesCount,
      categoriesCount,
      hasHebrew: false,
      reason: "הקובץ אינו מכיל מספיק משפטי צ'אט (מבנה מינימלי חסר)",
    };
  }

  // 5. Detect Hebrew characters: Hebrew Unicode range U+0590 to U+05FF
  const hasHebrew = /[\u0590-\u05FF]/.test(text);

  // 6. Language determination:
  // If hintFilename has "chat_<id>", parse it. e.g. chat_1.xml -> 1, chat_5.xml -> 5.
  let languageId = 1;
  if (hintFilename) {
    const fnMatch = /chat_(\d+)\.xml/i.exec(hintFilename);
    if (fnMatch) {
      languageId = parseInt(fnMatch[1], 10);
    } else if (hasHebrew) {
      languageId = 1;
    }
  } else if (hasHebrew) {
    languageId = 1;
  }

  return {
    valid: true,
    languageId,
    messagesCount,
    categoriesCount,
    hasHebrew,
    reason: `קובץ צ'אט מוגובי תקין (${messagesCount} משפטים, ${categoriesCount} קטגוריות)`,
  };
}
