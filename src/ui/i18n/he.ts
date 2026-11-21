/**
 * LocalGobe user-facing Hebrew copy.
 *
 * Everything a normal user reads in the primary flow lives here so the voice stays
 * consistent: short, warm, friendly Hebrew. Technical vocabulary is reserved for the
 * secondary "פרטים" (details) surface.
 */

export type NounForms = {
  /** Singular noun, e.g. "חדר". */
  one: string;
  /** Plural noun, e.g. "חדרים". */
  many: string;
  /** Grammatical gender, used for "אחד/אחת" and verb agreement. */
  gender: "m" | "f";
};

export const NOUNS = {
  room: { one: "חדר", many: "חדרים", gender: "m" },
  item: { one: "פריט", many: "פריטים", gender: "m" },
  game: { one: "משחק", many: "משחקים", gender: "m" },
  music: { one: "מנגינה", many: "מנגינות", gender: "f" },
  interfaceFile: { one: "קובץ ממשק", many: "קבצי ממשק", gender: "m" },
  language: { one: "קובץ שפה", many: "קבצי שפה", gender: "m" },
  chatLanguage: { one: "קובץ צ'אט", many: "קבצי צ'אט", gender: "m" },
  file: { one: "קובץ", many: "קבצים", gender: "m" },
} as const satisfies Record<string, NounForms>;

export type NounKey = keyof typeof NOUNS;

/** Noun label to place under/next to a big numeral: 1 → "חדר", 12 → "חדרים". */
export function nounFor(key: NounKey, n: number): string {
  return n === 1 ? NOUNS[key].one : NOUNS[key].many;
}

/** Natural counted phrase: 1 → "חדר אחד", 12 → "12 חדרים". */
export function countPhrase(key: NounKey, n: number): string {
  const noun = NOUNS[key];
  if (n === 1) return `${noun.one} ${noun.gender === "f" ? "אחת" : "אחד"}`;
  return `${n} ${noun.many}`;
}

/** "נוסף חדר אחד" / "נוספו 8 חדרים" / "נוספה מנגינה אחת". */
export function addedPhrase(key: NounKey, n: number): string {
  if (key === "language") {
    return "נוסף קובץ השפה העברי";
  }
  if (key === "chatLanguage") {
    return "נוסף קובץ משפטי הצ'אט בעברית";
  }
  const noun = NOUNS[key];
  if (n === 1) return `${noun.gender === "f" ? "נוספה" : "נוסף"} ${countPhrase(key, 1)}`;
  return `נוספו ${countPhrase(key, n)}`;
}

/** Live discovery headline while importing. */
export function discoveryPhrase(key: NounKey, n: number): string {
  switch (key) {
    case "room":
      return n === 1 ? "נמצא חדר חדש" : `נמצאו ${n} חדרים חדשים`;
    case "game":
      return n === 1 ? "נמצא משחק נוסף" : `נמצאו ${n} משחקים נוספים`;
    case "item":
      return n === 1 ? "נמצא פריט חדש" : `נמצאו ${n} פריטים`;
    case "music":
      return n === 1 ? "נמצאה מנגינה לחדר" : `נמצאו ${n} מנגינות לחדרים`;
    case "interfaceFile":
      return "נמצאו תוספות לממשק";
    case "file":
    default:
      return n === 1 ? "נמצא קובץ" : `נמצאו ${n} קבצים`;
  }
}

export const he = {
  brand: "LocalGobe",
  gameName: "מוגובי",
  loading: "טוענים את LocalGobe…",
  serviceDown: "לא הצלחנו להתחבר לשירות המקומי של LocalGobe. ודא שהוא פועל ונסה שוב.",
  retry: "נסה שוב",

  // ── Navigation / chrome ──
  addContent: "הוסף תוכן",
  details: "פרטים",
  settings: "הגדרות",
  close: "סגור",
  back: "חזרה",
  fullscreen: "מסך מלא",
  more: "עוד",
  restartGame: "הפעל מחדש את המשחק",
  backToLauncher: "חזרה ל־LocalGobe",
  roomRevisions: "גרסאות חדרים",
  roomRevisionsTitle: "בחירת גרסאות לחדרים",
  roomRevisionsLead: "תוכל לבחור איזו גרסה היסטורית תשוחק בכל חדר. הגרסה תיטען בפעם הבאה שתיכנס לחדר.",
  roomRevisionNotice: "הגרסה תיטען בפעם הבאה שתיכנס לחדר",
  roomAutoOption: "אוטומטי (מומלץ)",
  incompleteRevision: "גרסה חלקית",

  // ── First run ──
  firstRunTitle: "ברוכים הבאים ל־LocalGobe",
  firstRunLead: "מחזירים את מוגובי לחיים אצלך במחשב.",
  addApk: "הוסף APK של מוגובי",
  firstRunNote: "הקבצים המקוריים של מוגובי נשארים אצלך.",
  firstRunDropHint: "אפשר גם פשוט לגרור את קובץ ה־APK לחלון",
  firstRunLegal: "LocalGobe הוא פרויקט שימור עצמאי ואינו כולל קבצים מקוריים של מוגובי.",

  // ── APK flow ──
  apkChecking: "בודקים את ה־APK…",
  apkCheckingSub: "זה לוקח רק רגע",
  apkRecognized: (name: string) => `${name} זוהה`,
  apkRecognizedSub: "המשחק מותקן. עכשיו נחזיר את העולם לחיים.",
  apkErrorTitle: "לא הצלחנו להשתמש בקובץ הזה",
  continue: "המשך",
  tryAnotherFile: "בחר קובץ אחר",
  technicalDetails: "פרטים טכניים",

  // ── Home ──
  readyToPlay: "מוכן למשחק",
  worldReady: "העולם מוכן",
  languageReady: "הממשק בעברית מוכן",
  languageMissingLead: "חסר קובץ השפה העברי של מוגובי",
  languageMissingSub: "אפשר להיכנס למשחק גם בלעדיו, אבל חלק מהטקסטים והממשק יהיו חסרים.",
  play: "שחק",
  almostThere: "עוד רגע נכנסים לעולם",
  addWorldFilesLead: "חסרים קבצי חדר הכניסה של מוגובי. אם יש לך תיקיית Rooms או תיקיית קבצים מקוריים, אפשר פשוט לגרור אותה לכאן.",
  entryRoomSwfOnlyLead: "מצאנו את חדר הכניסה — חסר עדיין קובץ ההגדרות המתאים כדי שאפשר יהיה להיכנס.",
  entryRoomTxtOnlyLead: "מצאנו את קובץ ההגדרות של חדר הכניסה — חסר עדיין קובץ החדר המתאים כדי שאפשר יהיה להיכנס.",
  whatsMissing: "מה חסר?",
  entryRoomTitle: "חדר הכניסה",
  fileFoundLabel: "נמצא",
  fileMissingLabel: "עדיין חסר",
  needsWorldStatus: "צריך עוד קבצי עולם לפני שאפשר להיכנס",
  needsWorldShort: "צריך עוד קבצי עולם",
  needsFilesStatus: "צריך עוד כמה קבצים מקוריים לפני שאפשר להיכנס",
  needsGameTitle: "צריך להוסיף שוב את ה־APK",
  needsGameLead: "חלק מקבצי המשחק חסרים. הוספה מחדש של ה־APK תסדר את זה.",
  addFiles: "הוסף קבצים",
  chooseFolder: "בחר תיקייה",
  chooseFiles: "בחר קבצים",
  stepGame: "המשחק זוהה",
  stepWorld: "קבצי העולם",
  stepPlay: "נכנסים לשחק",
  dropAnywhereHint: "אפשר לגרור קבצים לכל מקום בחלון",
  interfaceReady: "הממשק בעברית מוכן",
  interfaceExtras: (n: number) => (n === 1 ? "תוספת ממשק אחת" : `${n} תוספות ממשק`),
  addRooms: "הוסף חדרים",
  addItems: "הוסף פריטים",
  addGames: "הוסף משחקים",
  noItemsYet: "עדיין לא נוספו פריטים",
  noGamesYet: "עדיין לא נוספו מיני־משחקים",
  noRoomsYet: "עדיין אין חדרים",
  roomMusic: (n: number) => (n === 1 ? "עם מנגינה אחת" : `עם ${n} מנגינות`),

  // ── Add content ──
  addSheetTitle: "הוסף תוכן לעולם שלך",
  addSheetAnyNote: "לא משנה מה בחרת — אם יש בתיקייה גם תוכן מסוג אחר, נוסיף גם אותו.",
  orByType: "או בחר לפי סוג",
  allContent: "הכול",

  // ── Global drop ──
  dropTitleFiles: "שחרר כאן את קבצי מוגובי",
  dropSubFiles: "נזהה ונסדר אותם לבד ✨",
  dropTitleApk: "שחרר כאן את ה־APK של מוגובי",
  dropSubApk: "נבדוק אותו ונתקין את המשחק",
  dropNeedApkFirst: "קודם צריך להוסיף את ה־APK של מוגובי",
  dropNeedApkFirstSub: "אחרי שהמשחק יותקן, אפשר יהיה להוסיף חדרים, פריטים ומשחקים.",

  // ── Import ──
  importCollecting: "קוראים את התיקייה…",
  importWorking: "מסדרים את קבצי מוגובי שלך…",
  importProgress: (done: number, total: number) => `${done} מתוך ${total}`,
  importStop: "עצור",
  importDoneTitle: "נוסף לעולם שלך",
  importWorldNowReady: "העולם מוכן! אפשר להיכנס",
  importEntrySwfOnlyTitle: "מצאנו את חדר הכניסה",
  importEntrySwfOnlySub: "חסר עדיין קובץ ההגדרות המתאים כדי שאפשר יהיה להיכנס.",
  importEntryTxtOnlyTitle: "מצאנו את קובץ ההגדרות של חדר הכניסה",
  importEntryTxtOnlySub: "חסר עדיין קובץ החדר המתאים כדי שאפשר יהיה להיכנס.",
  importIncompleteTitle: "זיהינו קבצי חדר",
  importIncompleteSub: "הקבצים נשמרו. כדי שהחדר יהיה זמין למשחק, הוסף גם את הקובץ המשלים שלו.",
  importConflictTitle: "הקבצים כבר קיימים בגרסה אחרת",
  importConflictSub: "שמרנו את הגרסה שכבר מותקנת אצלך כדי לא לדרוס קבצים קיימים.",
  importNothingNewTitle: "הכול כבר בעולם שלך",
  importNothingNewSub: "הקבצים האלה כבר נוספו קודם.",
  importUnknownTitle: "לא מצאנו כאן קבצי מוגובי",
  importUnknownSub: "אפשר לנסות תיקייה אחרת מהקבצים המקוריים שלך.",
  importSkipped: (n: number) => (n === 1 ? "קובץ אחד לא זוהה ודולג" : `${n} קבצים לא זוהו ודולגו`),
  importFailed: (n: number) => (n === 1 ? "קובץ אחד לא נקרא" : `${n} קבצים לא נקראו`),
  importStopped: "הייבוא נעצר. מה שכבר נוסף נשאר בעולם שלך.",
  importAddMore: "הוסף עוד",
  importFinish: "סיום",
  alsoFound: "מצאנו גם תוכן מסוג אחר — והוספנו אותו",

  // ── Play ──
  enteringWorld: "נכנסים לעולם…",
  playErrorTitle: "המשחק לא הצליח לעלות",
  playErrorSub: "משהו בסביבת ההפעלה המקומית לא מוכן.",

  // ── Settings ──
  settingsTitle: "הגדרות",
  prefFullscreen: "להיכנס למשחק במסך מלא",
  prefDiagnostics: "יומן אבחון למפתחים (בקונסול)",
  storageTitle: "איפה הקבצים נשמרים",
  preferencesTitle: "העדפות",

  // ── Updates ──
  updatesTitle: "עדכוני LocalGobe",
  installedVersion: "גרסה מותקנת:",
  checkUpdatesBtn: "בדוק אם יש עדכון",
  checkingUpdates: "בודקים אם יש עדכון…",
  upToDate: "LocalGobe מעודכנת",
  updateAvailable: "גרסה חדשה של LocalGobe זמינה",
  installedLabel: "מותקנת:",
  newVersionLabel: "חדשה:",
  downloadUpdateBtn: "הורד עדכון",
  laterBtn: "אחר כך",
  downloadingUpdate: (percent: number) => `מורידים את העדכון… ${percent}%`,
  updateReady: "העדכון מוכן",
  updateReadyDescription: "LocalGobe תיסגר, תתקין את הגרסה החדשה ותיפתח מחדש.",
  restartAndUpdateBtn: "הפעל מחדש ועדכן",
  checkUpdateFailed: "לא הצלחנו לבדוק אם יש עדכון",
  downloadUpdateFailed: "לא הצלחנו להוריד את העדכון",

  // ── Details ──
  detailsTitle: "פרטים",
  detailsGame: "המשחק",
  detailsRuntime: "סביבת ההפעלה",
  detailsWorld: "חדרים",
  detailsItems: "פריטים לפי משפחה",
  detailsMiniGames: "מיני־משחקים",
  detailsInterface: "ממשק ותוספות",
  detailsUnclassified: "קבצים שנשמרו לזיהוי עתידי",
  detailsSkipped: "קבצים שלא זוהו בייבוא האחרון",
  ready: "מוכן",
  notReady: "לא מוכן",
  removeBuild: "הסר את המשחק מ־LocalGobe",
  removeConfirm: "בטוח? המשחק וכל הקבצים שהוספת יימחקו מ־LocalGobe.",
  removeYes: "כן, הסר",
  cancel: "ביטול",
  removed: (name: string) => `${name} הוסר`,

  // ── Missing Assets Notification & Log ──
  missingAssetsTitle: "קבצים חסרים",
  missingAssetsLog: "יומן קבצים חסרים",
  missingAssetToast: (name: string, catLabel?: string) =>
    catLabel ? `קובץ חסר: ${name} (${catLabel})` : `קובץ חסר: ${name}`,
  missingAssetsBatchToast: (count: number, lastFilename: string) =>
    `חסרו ${count} קבצים (האחרון: ${lastFilename})`,
  viewLog: "צפה ביומן",
  missingAssetsLead: "במהלך המשחק, הקליינט ביקש את הקבצים הבאים שלא נמצאו (שגיאת 404). תוכל להשתמש ברשימה זו כדי לאתר את הקבצים המקוריים בארכיון או ב־Wayback Machine.",
  noMissingAssetsYet: "עדיין לא נרשמו בקשות לקבצים חסרים במהלך הפעלת המשחק הנוכחית.",
  copyMissingList: "העתק רשימה",
  copiedToClipboard: "הרשימה הועתקה ללוח!",
  clearLog: "נקה יומן",
  missingEntriesCount: (n: number) => (n === 1 ? "קובץ חסר אחד נרשם" : `${n} קבצים חסרים נרשמו`),
} as const;

/** Friendly Hebrew for APK importer failure codes. */
export function apkErrorMessage(code: string): string {
  switch (code) {
    case "UNSUPPORTED_APK":
      return "זה לא ה־APK של מוגובי שאנחנו מכירים. כרגע נתמכת הגרסה Mogobe Android 1.4.7.";
    case "INVALID_ARCHIVE":
      return "לא הצלחנו לקרוא את הקובץ. ודא שזה קובץ APK שלם.";
    case "HASH_MISMATCH":
      return "הקובץ נראה שונה מהגרסה המקורית, ולכן לא נשתמש בו.";
    case "MISSING_REQUIRED_APK_ASSET":
      return "חסרים בקובץ חלקים שהמשחק צריך כדי לעלות.";
    case "SECURITY_VIOLATION":
      return "הקובץ נחסם כדי לשמור על המחשב שלך.";
    default:
      return "משהו השתבש בקריאת הקובץ. נסה שוב.";
  }
}

/** Hebrew label for the mini-game availability state (details surface only). */
export function miniGameStateLabel(state: string): string {
  switch (state) {
    case "Available":
      return "זמין";
    case "Missing original game file":
      return "עוד לא נוסף";
    case "Missing original configuration":
      return "חסרות הגדרות מקוריות";
    case "Missing original dependency":
      return "חסר רכיב מקורי";
    default:
      return state;
  }
}
