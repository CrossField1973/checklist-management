import i18n from "i18next";
import { initReactI18next } from "react-i18next";
import type { Language } from "../api/types";
import de from "./de.json";
import en from "./en.json";

export const LANGUAGES: Language[] = ["de", "en"];
const STORAGE_KEY = "language";

export const isLanguage = (v: unknown): v is Language => v === "de" || v === "en";

/** Sprache vor der Anmeldung: zuletzt gewählte → Browsersprache → Standard des Servers → Deutsch. */
export function detectLanguage(serverDefault?: Language): Language {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (isLanguage(stored)) return stored;
  } catch { /* Speicher gesperrt */ }
  const browser = typeof navigator !== "undefined" ? navigator.language?.slice(0, 2) : undefined;
  if (isLanguage(browser)) return browser;
  return serverDefault ?? "de";
}

export function rememberLanguage(lang: Language) {
  try { localStorage.setItem(STORAGE_KEY, lang); } catch { /* ignorieren */ }
}

void i18n.use(initReactI18next).init({
  resources: { de: { translation: de }, en: { translation: en } },
  lng: "de",
  fallbackLng: "de",
  interpolation: { escapeValue: false }, // React maskiert bereits
  returnNull: false,
});

/** Setzt Sprache für Oberfläche und `<html lang>` (Screenreader, Silbentrennung). */
export function applyLanguage(lang: Language) {
  void i18n.changeLanguage(lang);
  document.documentElement.lang = lang;
}

export default i18n;
