/**
 * App commands shared by toolbar buttons, keyboard shortcuts, the native menu bar, and the
 * webview's text context menu. The same shortcut can reach us twice (menu accelerator and the
 * webview keydown), so a trigger from a different source right after another is dropped.
 */
export type CommandId = "read" | "apply" | "save" | "import" | "export" | "undo" | "redo" | "settings";
type Source = "button" | "key" | "menu" | "input";

const handlers = new Map<CommandId, () => void>();
const last = new Map<CommandId, { source: Source; at: number }>();
const DUPLICATE_MS = 150;

export function registerCommand(id: CommandId, handler: () => void) {
  handlers.set(id, handler);
}

export function runCommand(id: CommandId, source: Source = "button") {
  const now = performance.now();
  const prev = last.get(id);
  if (prev && prev.source !== source && now - prev.at < DUPLICATE_MS) return;
  last.set(id, { source, at: now });
  handlers.get(id)?.();
}

const isMac = /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);
export { isMac };

/** Keyboard shortcuts: `accelerator` for the native menu, `label` for tooltips. */
const SHORTCUTS: Partial<Record<CommandId, { accelerator: string; mac: string; other: string }>> = {
  apply: { accelerator: "CmdOrCtrl+Enter", mac: "⌘↩", other: "Ctrl+Enter" },
  save: { accelerator: "CmdOrCtrl+S", mac: "⌘S", other: "Ctrl+S" },
  import: { accelerator: "CmdOrCtrl+O", mac: "⌘O", other: "Ctrl+O" },
  export: { accelerator: "CmdOrCtrl+Shift+E", mac: "⇧⌘E", other: "Ctrl+Shift+E" },
  undo: { accelerator: "CmdOrCtrl+Z", mac: "⌘Z", other: "Ctrl+Z" },
  redo: { accelerator: isMac ? "Cmd+Shift+Z" : "Ctrl+Y", mac: "⇧⌘Z", other: "Ctrl+Y" },
  settings: { accelerator: "CmdOrCtrl+,", mac: "⌘,", other: "Ctrl+," },
};

export function shortcutAccelerator(id: CommandId): string | undefined {
  return SHORTCUTS[id]?.accelerator;
}
export function shortcutLabel(id: CommandId): string {
  const s = SHORTCUTS[id];
  return s ? (isMac ? s.mac : s.other) : "";
}

/** Undo/redo (⌘Z / ⇧⌘Z on macOS, Ctrl+Z / Ctrl+Y / Ctrl+Shift+Z elsewhere) and settings (⌘, / Ctrl+,). */
export function installShortcuts() {
  window.addEventListener(
    "keydown",
    (e) => {
      const mod = isMac ? e.metaKey && !e.ctrlKey : e.ctrlKey && !e.metaKey;
      if (!mod || e.altKey) return;
      const key = e.key.toLowerCase();
      const id: CommandId | null =
        key === "z" ? (e.shiftKey ? "redo" : "undo") : key === "y" && !isMac && !e.shiftKey ? "redo" : key === "," ? "settings" : null;
      if (!id) return;
      e.preventDefault();
      runCommand(id, "key");
    },
    { capture: true },
  );

  // "Undo"/"Redo" from the webview's own text context menu target the focused text field's
  // native history; route them to the EQ history instead.
  window.addEventListener(
    "beforeinput",
    (e) => {
      if (e.inputType !== "historyUndo" && e.inputType !== "historyRedo") return;
      e.preventDefault();
      runCommand(e.inputType === "historyUndo" ? "undo" : "redo", "input");
    },
    { capture: true },
  );

  // Outside text fields the default context menu only offers reload/inspect-style items.
  window.addEventListener("contextmenu", (e) => {
    const target = e.composedPath()[0];
    if (!(target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement)) e.preventDefault();
  });
}
