/**
 * Minimal i18n: flat message tables per language, `{name}` placeholders, and a "change" event
 * so components (and the native menu) can re-render their text when the language switches.
 */
import en from "./locales/en.json";
import ja from "./locales/ja.json";
import ko from "./locales/ko.json";

/** Supported languages and their names in their own language. Add a locale file per entry. */
export const LANGUAGES = { ko: "한국어", en: "English", ja: "日本語" } as const;
export type Lang = keyof typeof LANGUAGES;

/** Korean is the reference locale: its keys define the message set. */
type Key = keyof typeof ko;
type Messages = Record<Key, string>;

// Assigning to Messages makes a missing key in en.json or ja.json a type error.
const TABLES: Record<Lang, Messages> = { ko, en, ja };
const FALLBACK: Lang = "en";
const STORAGE_KEY = "moondrop.lang";

/** "system" follows the OS language; a language code is an explicit user override. */
export type LangChoice = Lang | "system";

/**
 * First supported language among `locales` (most preferred first). Accepts BCP 47 and POSIX
 * forms ("ko-KR", "ja_JP.UTF-8", "zh-Hant-TW") and compares the primary language subtag.
 */
export function matchLocale(locales: readonly string[]): Lang | null {
  for (const tag of locales) {
    const base = tag.trim().toLowerCase().split(/[-_.@]/)[0];
    if (base in LANGUAGES) return base as Lang;
  }
  return null;
}

let systemLocales: string[] = [];
let systemLang: Lang = FALLBACK;
let choice: LangChoice = "system";
let current: Lang = FALLBACK;

function readChoice(): LangChoice {
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved && saved in LANGUAGES) return saved as Lang;
  } catch {
    // Storage can be unavailable; follow the system language.
  }
  return "system";
}

function activate(next: Lang) {
  current = next;
  document.documentElement.lang = next;
}

/**
 * Call once before rendering. The system locales are checked first against the supported
 * languages; a language the user picked explicitly then overrides the result.
 */
export function initI18n(locales: readonly string[]) {
  systemLocales = [...locales];
  systemLang = matchLocale(systemLocales) ?? FALLBACK;
  choice = readChoice();
  activate(choice === "system" ? systemLang : choice);
}

export const i18n = new EventTarget();

/** The language in use. */
export function lang(): Lang {
  return current;
}
/** What the user selected: an explicit language or "system". */
export function langChoice(): LangChoice {
  return choice;
}
/** The supported language resolved from the system locales, and the raw locales for display. */
export function systemLanguage(): { lang: Lang; locales: string[]; supported: boolean } {
  return { lang: systemLang, locales: systemLocales, supported: matchLocale(systemLocales) !== null };
}

export function setLang(next: LangChoice) {
  choice = next;
  try {
    if (next === "system") localStorage.removeItem(STORAGE_KEY);
    else localStorage.setItem(STORAGE_KEY, next);
  } catch {
    // Not persisted; the choice still applies for this session.
  }
  activate(next === "system" ? systemLang : next);
  // Fire even when the language is unchanged so menus update which option is checked.
  i18n.dispatchEvent(new Event("change"));
}

export type MessageKey = Key;

export function t(key: Key, params: Record<string, string | number> = {}): string {
  const text = TABLES[current][key] ?? ko[key] ?? key;
  return text.replace(/\{(\w+)\}/g, (_, name) => String(params[name] ?? `{${name}}`));
}

/** Translation for a dynamic key (e.g. a preset ID) with a fallback when there is none. */
export function tMaybe(key: string, fallback: string): string {
  return key in ko ? t(key as Key) : fallback;
}

/**
 * Fill text from `data-i18n` (textContent), `data-i18n-tip` (tooltip) and `data-i18n-aria` (aria-label)
 * attributes within `root`.
 */
export function applyI18n(root: ParentNode) {
  root.querySelectorAll<HTMLElement>("[data-i18n]").forEach((el) => (el.textContent = t(el.dataset.i18n as Key)));
  root.querySelectorAll<HTMLElement>("[data-i18n-tip]").forEach((el) => (el.dataset.tooltip = t(el.dataset.i18nTip as Key)));
  root
    .querySelectorAll<HTMLElement>("[data-i18n-aria]")
    .forEach((el) => el.setAttribute("aria-label", t(el.dataset.i18nAria as Key)));
}
