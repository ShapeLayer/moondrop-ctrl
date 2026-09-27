import { api } from "../api";
import { isMac, registerCommand, runCommand, shortcutLabel, type CommandId } from "../commands";
import { applyI18n, i18n, langChoice, LANGUAGES, setLang, systemLanguage, t, type Lang, type LangChoice } from "../i18n";
import { presetFor, presetNote, presetTitle, refreshCatalog } from "../catalog";
import { store, type StatusMessage } from "../store";
import { fromWire, toWire } from "../types";
import "./eq-editor";
import type { SettingsPanel } from "./settings-panel";
import "./settings-panel";

const ICONS = {
  read: `<path d="M8 2v8m0 0L5 7m3 3 3-3M3 12.5h10" />`,
  apply: `<path d="M3 8.5 6.5 12 13 4.5" />`,
  save: `<path d="M3.5 2.5h7l2 2v9h-9zM5.5 2.5v3h5v-3M5.5 13.5v-4h5v4" />`,
  export: `<path d="M8 10V2m0 0L5 5m3-3 3 3M3 9v4.5h10V9" />`,
  import: `<path d="M8 2v8m0 0L5 7m3 3 3-3M3 9v4.5h10V9" />`,
  undo: `<path d="M5.5 3.5 2.5 6.5l3 3M2.5 6.5h7a4 4 0 0 1 0 8H7" />`,
  redo: `<path d="m10.5 3.5 3 3-3 3M13.5 6.5h-7a4 4 0 0 0 0 8H9" />`,
  add: `<path d="M8 3v10M3 8h10" />`,
  gear: `<circle cx="8" cy="8" r="2.2" /><path d="M8 1.8v1.6M8 12.6v1.6M1.8 8h1.6M12.6 8h1.6M3.6 3.6l1.1 1.1M11.3 11.3l1.1 1.1M3.6 12.4l1.1-1.1M11.3 4.7l1.1-1.1" />`,
  globe: `<circle cx="8" cy="8" r="5.5" /><path d="M2.5 8h11M8 2.5c1.6 1.6 2.3 3.5 2.3 5.5S9.6 11.9 8 13.5C6.4 11.9 5.7 10 5.7 8S6.4 4.1 8 2.5Z" />`,
};
const icon = (name: keyof typeof ICONS) =>
  `<svg viewBox="0 0 16 16" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[name]}</svg>`;

export class MdApp extends HTMLElement {
  private root: ShadowRoot;
  private presetKey = "";
  private $ = <T extends Element>(sel: string) => this.root.querySelector<T>(sel)!;

  constructor() {
    super();
    this.root = this.attachShadow({ mode: "open" });
    this.root.innerHTML = `
      <style>
        :host, *, *::before, *::after { box-sizing: border-box; }
        :host { display: grid; grid-template-rows: auto 1fr auto; grid-template-columns: minmax(0, 1fr); height: 100%; }
        header { display: flex; align-items: center; gap: 14px; padding: 14px 20px 12px; min-height: 58px;
          border-bottom: 1px solid var(--border); background: color-mix(in srgb, var(--surface) 70%, var(--bg)); }
        /* macOS overlay title bar: leave room for the window buttons. */
        :host([mac]) header { padding-left: 88px; }
        .brand { display: flex; flex-direction: column; line-height: 1.15; margin-right: auto; pointer-events: none; }
        .brand b { font-size: 15px; letter-spacing: -.01em; }
        .brand span { font-size: 11.5px; color: var(--muted); }
        .pill { display: inline-flex; align-items: center; gap: 6px; height: 24px; padding: 0 10px; border-radius: 99px;
          font-size: 11.5px; font-weight: 500; background: var(--surface-2); border: 1px solid var(--border); color: var(--muted); }
        .pill i { width: 7px; height: 7px; border-radius: 50%; background: var(--faint); }
        .pill[data-state=connected] i { background: var(--ok); box-shadow: 0 0 0 3px color-mix(in srgb, var(--ok) 20%, transparent); }
        .pill[data-state=missing] i { background: var(--danger); }
        .group { display: flex; align-items: center; gap: 6px; }
        .sep { width: 1px; height: 22px; background: var(--border); }

        button, select { font: inherit; color: inherit; }
        button { display: inline-flex; align-items: center; gap: 6px; height: 30px; padding: 0 12px; border-radius: 8px;
          border: 1px solid var(--border); background: var(--surface-2); cursor: pointer; font-weight: 500;
          transition: background .12s, border-color .12s, opacity .12s; white-space: nowrap; }
        button:hover:not(:disabled) { background: var(--surface-3); border-color: var(--border-strong); }
        button:disabled { opacity: .45; cursor: default; }
        button:focus-visible, select:focus-visible { outline: 2px solid var(--accent); outline-offset: 1px; }
        button.primary { background: var(--accent); border-color: transparent; color: var(--accent-ink); font-weight: 600; }
        button.primary:hover:not(:disabled) { background: color-mix(in srgb, var(--accent) 88%, white); }
        button.icon { width: 30px; padding: 0; justify-content: center; }
        button[aria-busy=true] svg { animation: spin 0.9s linear infinite; }
        @keyframes spin { to { transform: rotate(360deg); } }

        select { height: 30px; min-width: 190px; padding: 0 28px 0 10px; border-radius: 8px; border: 1px solid var(--border);
          appearance: none; cursor: pointer;
          background: var(--surface-2) url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='8' height='5'%3E%3Cpath d='M0 0l4 5 4-5z' fill='%238a93a0'/%3E%3C/svg%3E") no-repeat right 10px center; }

        .switch { display: inline-flex; align-items: center; gap: 8px; cursor: pointer; font-weight: 500; }
        .switch input { appearance: none; margin: 0; width: 34px; height: 20px; border-radius: 99px; background: var(--surface-3);
          border: 1px solid var(--border-strong); position: relative; cursor: pointer; transition: background .15s; }
        .switch input::after { content: ""; position: absolute; top: 2px; left: 2px; width: 14px; height: 14px; border-radius: 50%;
          background: var(--muted); transition: transform .18s cubic-bezier(.2,.8,.2,1), background .15s; }
        .switch input:checked { background: var(--accent); border-color: transparent; }
        .switch input:checked::after { transform: translateX(14px); background: var(--accent-ink); }
        .switch input:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }

        main { display: flex; flex-direction: column; gap: 12px; padding: 16px 20px 12px; min-height: 0; }
        .toolbar { display: flex; align-items: center; gap: 12px; }
        .toolbar .hint { flex: 1; min-width: 0; text-align: right; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
          font-size: 11.5px; color: var(--faint); }
        .toolbar .hint kbd { font: 10.5px var(--mono); padding: 1px 4px; border-radius: 4px; border: 1px solid var(--border); color: var(--muted); }
        eq-editor { flex: 1; min-height: 0; }

        footer { display: flex; align-items: center; gap: 10px; padding: 8px 20px; min-height: 36px;
          border-top: 1px solid var(--border); font-size: 12px; color: var(--muted); background: color-mix(in srgb, var(--surface) 70%, var(--bg)); }
        footer .msg { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; user-select: text; -webkit-user-select: text; }
        footer .msg[data-kind=ok] { color: var(--ok); }
        footer .msg[data-kind=error] { color: var(--danger); }
        footer .msg small { color: var(--faint); margin-left: 8px; }
        .sync { flex: none; font-size: 11px; font-weight: 600; padding: 2px 8px; border-radius: 99px; }
        .sync[data-state=dirty] { color: var(--warn); background: color-mix(in srgb, var(--warn) 14%, transparent); }
        .sync[data-state=clean] { color: var(--ok); background: color-mix(in srgb, var(--ok) 12%, transparent); }
        .sync[data-state=none] { display: none; }
        .mock { flex: none; font-size: 11px; color: var(--accent); }
        .lang { display: inline-flex; align-items: center; gap: 4px; color: var(--muted); }
        .lang select { min-width: 0; height: 26px; padding: 0 22px 0 6px; background-position: right 7px center; font-size: 12px; }
        .toolbar .hint + .lang { margin-left: 4px; }
      </style>
      <header data-tauri-drag-region>
        <div class="brand" data-tauri-drag-region><b id="title"></b></div>
        <span class="pill" id="conn" data-state="unknown"><i></i><span></span></span>
        <div class="sep"></div>
        <div class="group">
          <button id="read" data-i18n-tip="action.read.tip">${icon("read")}<span data-i18n="action.read"></span></button>
          <button id="apply" data-i18n-tip="action.apply.tip">${icon("apply")}<span data-i18n="action.apply"></span></button>
          <button id="save" class="primary" data-i18n-tip="action.save.tip">${icon("save")}<span data-i18n="action.save"></span></button>
        </div>
        <div class="sep"></div>
        <button id="settings" class="icon" data-i18n-tip="tip.settings" data-i18n-aria="action.settings">${icon("gear")}</button>
      </header>
      <main>
        <div class="toolbar">
          <label class="switch" data-i18n-tip="tip.eq"><input type="checkbox" id="enabled" role="switch" />EQ</label>
          <div class="sep"></div>
          <div class="group">
            <button id="undo" class="icon" data-i18n-tip="tip.undo" data-i18n-aria="action.undo">${icon("undo")}</button>
            <button id="redo" class="icon" data-i18n-tip="tip.redo" data-i18n-aria="action.redo">${icon("redo")}</button>
          </div>
          <div class="sep"></div>
          <button id="add-band">${icon("add")}<span data-i18n="action.addBand"></span></button>
          <div class="sep"></div>
          <select id="preset" data-i18n-aria="preset.aria" data-i18n-tip="tip.preset"></select>
          <button id="import" class="icon" data-i18n-tip="tip.import" data-i18n-aria="action.import">${icon("import")}</button>
          <button id="export" class="icon" data-i18n-tip="tip.export" data-i18n-aria="action.export">${icon("export")}</button>
          <span class="hint"><span data-i18n="hint.drag"></span> · <span data-i18n="hint.wheel"></span> <kbd>Q</kbd> · <kbd>Shift</kbd> <span data-i18n="hint.axis"></span> · <span data-i18n="hint.reset"></span></span>
          <label class="lang">${icon("globe")}<select id="lang" data-i18n-aria="language.aria"></select></label>
        </div>
        <eq-editor></eq-editor>
      </main>
      <footer>
        <span class="msg" id="msg" aria-live="polite"></span>
        <span class="sync" id="sync" data-state="none" data-i18n-tip="tip.sync"></span>
        ${api.mock ? `<span class="mock" data-i18n="mock"></span>` : ""}
      </footer>
      <md-settings></md-settings>`;

    const commands: Record<CommandId, () => void> = {
      read: () => void this.readDevice(),
      apply: () => void this.apply(false),
      save: () => void this.apply(true),
      import: () => void this.importJson(),
      export: () => void this.exportJson(),
      undo: () => store.undo(),
      redo: () => store.redo(),
      settings: () => void this.$<SettingsPanel>("md-settings").open(),
    };
    for (const [id, handler] of Object.entries(commands) as [CommandId, () => void][]) {
      registerCommand(id, handler);
      this.root.querySelector(`#${id}`)?.addEventListener("click", () => runCommand(id));
    }
    this.$<HTMLButtonElement>("#add-band").addEventListener("click", () => store.addBand());
    this.$<HTMLInputElement>("#enabled").addEventListener("change", (e) => store.setEnabled((e.target as HTMLInputElement).checked));
    this.$<HTMLSelectElement>("#preset").addEventListener("change", (e) => this.loadPreset((e.target as HTMLSelectElement).value));
    this.$<HTMLSelectElement>("#lang").addEventListener("change", (e) => setLang((e.target as HTMLSelectElement).value as LangChoice));
    store.addEventListener("change", () => this.render());
    i18n.addEventListener("change", () => this.localize());
  }

  async connectedCallback() {
    this.toggleAttribute("mac", isMac);
    this.localize();
    await refreshCatalog().catch((e) => store.setMeta({ status: { kind: "error", key: "status.error", params: { message: errorText(e) } } }));
    this.localize();
    await this.readDevice(true);
  }

  /** Static labels, shortcut tooltips, and preset names in the current language. */
  private localize() {
    applyI18n(this.root);
    for (const id of ["apply", "save", "import", "export", "undo", "redo", "settings"] as CommandId[]) {
      this.$<HTMLElement>(`#${id}`).dataset.shortcut = shortcutLabel(id);
    }
    const system = systemLanguage();
    const langSelect = this.$<HTMLSelectElement>("#lang");
    langSelect.innerHTML =
      `<option value="system">${escapeHtml(t("language.system", { lang: LANGUAGES[system.lang] }))}</option>` +
      (Object.keys(LANGUAGES) as Lang[]).map((code) => `<option value="${code}">${LANGUAGES[code]}</option>`).join("");
    langSelect.value = langChoice();
    langSelect.parentElement!.dataset.tooltip = system.supported
      ? t("tip.language")
      : t("language.unsupported", { locale: system.locales[0] ?? "?", lang: LANGUAGES[system.lang] });
    this.presetKey = "";
    this.render();
  }

  /** Presets meant for the active profile (or any device), rebuilt when the catalog changes. */
  private renderPresets() {
    const profile = store.profile;
    const list = store.presets.filter((p) => presetFor(p, profile));
    const key = `${profile?.id}|${list.map((p) => p.id + p.title).join(",")}`;
    if (key === this.presetKey) return;
    this.presetKey = key;
    const group = (source: string, label: string) => {
      const items = list.filter((p) => p.source === source);
      return items.length
        ? `<optgroup label="${escapeHtml(label)}">${items.map((p) => `<option value="${escapeHtml(p.id)}">${escapeHtml(presetTitle(p))}</option>`).join("")}</optgroup>`
        : "";
    };
    this.$<HTMLSelectElement>("#preset").innerHTML =
      `<option value="">${escapeHtml(t("preset.placeholder"))}</option>` +
      group("snapshot", t("badge.snapshot")) +
      group("builtin", t("badge.builtin")) +
      group("user", t("badge.user"));
  }

  private render() {
    this.renderPresets();
    const conn = this.$<HTMLElement>("#conn");
    conn.dataset.state = store.connection;
    conn.querySelector("span")!.textContent = t(`conn.${store.connection}`);
    const device = store.device?.title;
    conn.dataset.tooltip = t(`tip.conn.${store.connection}`, { device: device ?? t("app.title") });
    this.$("#title").textContent = store.connection === "missing" ? t("app.title.missing") : (device ?? t("app.title"));

    const add = this.$<HTMLButtonElement>("#add-band");
    add.disabled = !store.canAddBand;
    add.dataset.tooltip = t(store.canAddBand ? "tip.addBand" : "tip.addBand.full", { max: store.maxBands });

    const enabled = this.$<HTMLInputElement>("#enabled");
    enabled.checked = store.eq.enabled;
    enabled.disabled = !store.canBypass && store.eq.enabled;
    enabled.parentElement!.dataset.tooltip = t(store.canBypass ? "tip.eq" : "tip.eq.always");
    this.$<HTMLSelectElement>("#preset").value = store.presetId;

    const busy = store.busy;
    for (const id of ["read", "apply", "save", "import", "export", "settings"]) {
      const b = this.$<HTMLButtonElement>(`#${id}`);
      b.disabled = busy !== null;
      b.setAttribute("aria-busy", String(busy === id));
    }
    this.$<HTMLButtonElement>("#undo").disabled = !store.canUndo;
    this.$<HTMLButtonElement>("#redo").disabled = !store.canRedo;

    const msg = this.$<HTMLElement>("#msg");
    const s: StatusMessage = store.status;
    const text = s.key ? t(s.key, s.params) : "";
    msg.dataset.kind = s.kind;
    msg.innerHTML = `${escapeHtml(text)}${s.detail ? `<small>${escapeHtml(s.detail)}</small>` : ""}`;
    // The status line truncates; the tooltip shows it in full.
    msg.dataset.tooltip = s.detail ? `${text} — ${s.detail}` : text;

    const sync = this.$<HTMLElement>("#sync");
    sync.dataset.state = store.deviceEq === null ? "none" : store.dirty ? "dirty" : "clean";
    sync.textContent = t(store.dirty ? "sync.dirty" : "sync.clean");
  }

  /** Runs one device action at a time, with the busy spinner on its button and errors in the status bar. */
  private async run(id: string, busy: StatusMessage["key"], work: () => Promise<StatusMessage | void>) {
    if (store.busy) return;
    store.setMeta({ busy: id, status: { kind: "busy", key: busy } });
    try {
      const status = await work();
      store.setMeta({ busy: null, status: status ?? store.status });
    } catch (e) {
      store.setMeta({ busy: null, status: { kind: "error", key: "status.error", params: { message: errorText(e) } } });
    }
  }

  private readDevice(initial = false) {
    return this.run("read", "status.read.busy", async () => {
      try {
        const report = await api.readEq();
        // Set the profile first: it bounds the values the editor accepts.
        store.setMeta({ connection: "connected", device: report.profile });
        // The device keeps no colors: keep the editor's, band by band.
        store.setEq(fromWire(report.eq, store.eq.bands.map((b) => b.color)), { fromDevice: true });
        if (report.snapshot) {
          await refreshCatalog();
          return { kind: "ok", key: "status.read.snapshot", detail: report.snapshot };
        }
        return { kind: "ok", key: "status.read.ok", params: { device: report.profile.title } };
      } catch (e) {
        store.setMeta({ connection: "missing", device: null });
        if (initial) return { kind: "info", key: "status.read.missing", detail: errorText(e) };
        throw e;
      }
    });
  }

  private apply(commit: boolean) {
    return this.run(commit ? "save" : "apply", commit ? "status.save.busy" : "status.apply.busy", async () => {
      const applied = structuredClone(store.eq);
      const device = store.device;
      const max = device?.protocol.bands.count;
      if (max !== undefined && applied.bands.length > max) {
        return { kind: "error", key: "status.tooManyBands", params: { max, extra: applied.bands.length - max } };
      }
      if (device && !device.verified && !(await api.confirm(t("confirm.unverified", { device: device.title }), t("confirm.unverified.title")))) {
        return { kind: "info", key: "status.cancelled" };
      }
      const report = await api.applyEq(toWire(applied), commit);
      store.setMeta({ connection: "connected", device: report.profile });
      store.setDeviceEq(applied);
      const detail = report.backup ? t("status.backup", { path: report.backup }) : undefined;
      if (commit) return { kind: "ok", key: "status.save.ok", detail };
      if (!report.changed) return { kind: "ok", key: "status.apply.same" };
      return { kind: "ok", key: "status.apply.ok", detail };
    });
  }

  private loadPreset(id: string) {
    const preset = store.presets.find((p) => p.id === id);
    if (!preset) return;
    store.setEq(fromWire(preset.eq), { presetId: id });
    store.setMeta({
      status: {
        kind: "info",
        key: "status.preset",
        params: { title: presetTitle(preset) },
        detail: presetNote(preset),
      },
    });
  }

  private exportJson() {
    return this.run("export", "status.export.busy", async () => {
      if (!(await api.exportJson(toWire(store.eq)))) return { kind: "info", key: "status.export.cancel" };
      return { kind: "ok", key: "status.export.ok" };
    });
  }

  private importJson() {
    return this.run("import", "status.import.busy", async () => {
      const state = await api.importJson();
      if (!state) return { kind: "info", key: "status.import.cancel" };
      store.setEq(fromWire(state));
      return { kind: "ok", key: "status.import.ok" };
    });
  }
}

function errorText(e: unknown) {
  return e instanceof Error ? e.message : String(e);
}

function escapeHtml(s: string) {
  return s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

customElements.define("md-app", MdApp);
