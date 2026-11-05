import "@testing-library/jest-dom/vitest";
import { cleanup, configure } from "@testing-library/react";
import { afterEach, beforeEach } from "vitest";
import i18n from "../i18n";

// Großzügigere Wartezeit für findBy…/waitFor: auf ausgelasteten Rechnern (parallele Tests) reichen die 1000 ms sonst gelegentlich nicht
configure({ asyncUtilTimeout: 5000 });

// jsdom kennt <dialog>.showModal()/close() nicht – minimal nachbilden (open-Attribut + close-Ereignis)
if (typeof HTMLDialogElement !== "undefined") {
  HTMLDialogElement.prototype.showModal = function showModal(this: HTMLDialogElement) { this.setAttribute("open", ""); };
  HTMLDialogElement.prototype.close = function close(this: HTMLDialogElement) {
    this.removeAttribute("open");
    this.dispatchEvent(new Event("close"));
  };
}

// Standard in Tests: Browser auf Deutsch (jsdom meldet sonst „en-US“); einzelne Tests überschreiben das
Object.defineProperty(navigator, "language", { value: "de-DE", configurable: true });

beforeEach(async () => {
  localStorage.clear();
  document.documentElement.removeAttribute("data-theme");
  await i18n.changeLanguage("de");
});
afterEach(() => cleanup());
