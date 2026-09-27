import { api } from "./api";
import { installShortcuts } from "./commands";
import { initI18n } from "./i18n";
import { installMenu } from "./menu";
import { installTooltips } from "./tooltip";

/** Resolve the language from the system locales before any component renders text. */
async function start() {
  let locales: string[] = [];
  try {
    locales = await api.systemLocales();
  } catch {
    locales = [...navigator.languages];
  }
  initI18n(locales);
  installShortcuts();
  installTooltips();
  await import("./components/md-app");
  void installMenu();
}

void start();
