import { api } from "../api";
import { eqProblems, presetFor, presetNote, presetTitle, refreshCatalog } from "../catalog";
import { runCommand } from "../commands";
import { applyI18n, i18n, lang, t, type Lang, type MessageKey } from "../i18n";
import { buildPrompt, parseReply, type AiTask } from "../prompts";
import { store } from "../store";
import {
  FILTER_TYPES,
  fromWire,
  hasGain,
  hex,
  parseHex,
  toWire,
  usbId,
  withDefaults,
  type Entry,
  type HidDevice,
  type Preset,
  type ProbeReport,
  type Profile,
  type Settings,
  type WireEqState,
} from "../types";

export type SettingsTab = "device" | "profiles" | "presets" | "ai" | "advanced" | "general";
const TABS: SettingsTab[] = ["device", "profiles", "presets", "ai", "advanced", "general"];

/** Language names for the AI prompt, which asks for a reply in the user's language. */
const AI_LANGUAGE: Record<Lang, string> = { ko: "Korean", en: "English", ja: "Japanese" };

type Kind = "text" | "textarea" | "bool" | "hex" | "hexOpt" | "int" | "num" | "bytes" | "type" | "presence" | "order";
interface Field {
  path: string;
  kind: Kind;
  label: MessageKey;
}
/** Value a "presence" field sets when switched on (the section is `null` when off). */
const PRESENCE_DEFAULTS: Record<string, unknown> = {
  "protocol.eq_switch": { register: "0x00", read_argument: [], on: "0x01", off: "0x00" },
};
/** The profile editor's form, one fieldset per section; paths follow the profile JSON. */
const SECTIONS: { title: MessageKey; hint?: MessageKey; fields: Field[] }[] = [
  {
    title: "pf.s.general",
    fields: [
      { path: "id", kind: "text", label: "pf.id" },
      { path: "title", kind: "text", label: "pf.title" },
      { path: "notes", kind: "textarea", label: "pf.notes" },
      { path: "verified", kind: "bool", label: "pf.verified" },
    ],
  },
  {
    title: "pf.s.usb",
    hint: "pf.s.usb.hint",
    fields: [
      { path: "usb.vendor_id", kind: "hex", label: "pf.vendor" },
      { path: "usb.product_id", kind: "hex", label: "pf.product" },
      { path: "usb.usage_page", kind: "hexOpt", label: "pf.usagePage" },
      { path: "usb.usage", kind: "hexOpt", label: "pf.usage" },
    ],
  },
  {
    title: "pf.s.protocol",
    hint: "pf.s.protocol.hint",
    fields: [
      { path: "protocol.report_id", kind: "hex", label: "pf.reportId" },
      { path: "protocol.read_command", kind: "hex", label: "pf.readCmd" },
      { path: "protocol.write_command", kind: "hex", label: "pf.writeCmd" },
      { path: "protocol.commit_command", kind: "hexOpt", label: "pf.commitCmd" },
      { path: "protocol.commit_register", kind: "hex", label: "pf.commitReg" },
      { path: "protocol.pregain_register", kind: "hexOpt", label: "pf.pregainReg" },
    ],
  },
  {
    title: "pf.s.frame",
    hint: "pf.s.frame.hint",
    fields: [
      { path: "protocol.frame.length", kind: "int", label: "pf.frameLength" },
      { path: "protocol.frame.register_offset", kind: "int", label: "pf.registerOffset" },
      { path: "protocol.frame.command_offset", kind: "int", label: "pf.commandOffset" },
      { path: "protocol.frame.value_offset", kind: "int", label: "pf.valueOffset" },
      { path: "protocol.frame.value_length", kind: "int", label: "pf.valueLength" },
      { path: "protocol.frame.echo_length", kind: "int", label: "pf.echoLength" },
    ],
  },
  {
    title: "pf.s.switch",
    hint: "pf.s.switch.hint",
    fields: [
      { path: "protocol.eq_switch", kind: "presence", label: "pf.hasSwitch" },
      { path: "protocol.eq_switch.register", kind: "hex", label: "pf.register" },
      { path: "protocol.eq_switch.read_argument", kind: "bytes", label: "pf.readArg" },
      { path: "protocol.eq_switch.on", kind: "hex", label: "pf.on" },
      { path: "protocol.eq_switch.off", kind: "hex", label: "pf.off" },
    ],
  },
  {
    title: "pf.s.bands",
    hint: "pf.s.bands.hint",
    fields: [
      { path: "protocol.bands.count", kind: "int", label: "pf.count" },
      { path: "protocol.bands.first_register", kind: "hex", label: "pf.firstReg" },
      { path: "protocol.bands.stride", kind: "int", label: "pf.stride" },
      { path: "protocol.bands.registers_per_band", kind: "int", label: "pf.registersPerBand" },
    ],
  },
  {
    title: "pf.s.encoding",
    hint: "pf.s.encoding.hint",
    fields: [
      { path: "protocol.band_encoding.byte_order", kind: "order", label: "pf.byteOrder" },
      ...(["gain", "frequency", "q", "filter"] as const).flatMap((name): Field[] => [
        { path: `protocol.band_encoding.${name}.offset`, kind: "int", label: `pf.enc.${name}.offset` as MessageKey },
        { path: `protocol.band_encoding.${name}.size`, kind: "int", label: `pf.enc.${name}.size` as MessageKey },
        ...(name === "filter"
          ? []
          : [
              { path: `protocol.band_encoding.${name}.step`, kind: "num", label: `pf.enc.${name}.step` as MessageKey } as Field,
              { path: `protocol.band_encoding.${name}.signed`, kind: "bool", label: `pf.enc.${name}.signed` as MessageKey } as Field,
            ]),
      ]),
    ],
  },
  {
    title: "pf.s.filters",
    hint: "pf.s.filters.hint",
    fields: FILTER_TYPES.map((type) => ({
      path: `protocol.filter_codes.${type}`,
      kind: type === "peaking" ? "hex" : "hexOpt",
      label: `filter.${type}` as MessageKey,
    })),
  },
  {
    title: "pf.s.unused",
    hint: "pf.s.unused.hint",
    fields: [
      { path: "protocol.unused_band.gain_db", kind: "num", label: "pf.gainDb" },
      { path: "protocol.unused_band.frequency_hz", kind: "num", label: "pf.freqHz" },
      { path: "protocol.unused_band.q", kind: "num", label: "pf.qValue" },
      { path: "protocol.unused_band.filter_type", kind: "type", label: "band.type" },
    ],
  },
  {
    title: "pf.s.timing",
    hint: "pf.s.timing.hint",
    fields: [
      { path: "protocol.timing.response_timeout_ms", kind: "int", label: "pf.responseTimeout" },
      { path: "protocol.timing.reconnect_timeout_ms", kind: "int", label: "pf.reconnectTimeout" },
      { path: "dsp.sample_rate_hz", kind: "int", label: "pf.sampleRate" },
    ],
  },
  {
    title: "pf.s.limits",
    fields: [
      { path: "limits.gain_db.min", kind: "num", label: "pf.gainMin" },
      { path: "limits.gain_db.max", kind: "num", label: "pf.gainMax" },
      { path: "limits.frequency_hz.min", kind: "num", label: "pf.freqMin" },
      { path: "limits.frequency_hz.max", kind: "num", label: "pf.freqMax" },
      { path: "limits.q.min", kind: "num", label: "pf.qMin" },
      { path: "limits.q.max", kind: "num", label: "pf.qMax" },
    ],
  },
];

/** Hex text of a read request for `register`, built from the profile's frame. */
function readRequest(p: Profile, register: number): string {
  const f = p.protocol.frame;
  const bytes = new Array<number>(f.length).fill(0);
  bytes[0] = parseHex(p.protocol.report_id) ?? 0;
  bytes[f.register_offset] = register;
  bytes[f.command_offset] = parseHex(p.protocol.read_command) ?? 0;
  return bytes.map((b) => b.toString(16).toUpperCase().padStart(2, "0")).join(" ");
}
const esc = (s: unknown) => String(s ?? "").replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e));
const id16 = (n: number) => n.toString(16).toUpperCase().padStart(4, "0");
const slug = (s: string) =>
  s
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);

function getPath(obj: unknown, path: string): unknown {
  return path.split(".").reduce<unknown>((o, k) => (o as Record<string, unknown> | null)?.[k], obj);
}
function setPath(obj: unknown, path: string, value: unknown) {
  const keys = path.split(".");
  const last = keys.pop()!;
  const parent = keys.reduce<Record<string, unknown>>((o, k) => (o[k] ??= {}) as Record<string, unknown>, obj as Record<string, unknown>);
  parent[last] = value;
}
/** Hex fields are always hex: "4b" and "0x4b" both mean 0x4B. */
function normalizeHex(text: string): string {
  const digits = text.trim().replace(/^0x/i, "").toUpperCase();
  return digits ? `0x${digits}` : "";
}

/** Interfaces that are clearly not earphones are hidden unless "Show all" is on. */
function likelyAudio(d: HidDevice) {
  if (d.profiles.length) return true;
  if (d.vendor_id === 0 || d.vendor_id === 0x05ac) return false;
  return !(d.usage_page === 1 && [1, 2, 6].includes(d.usage));
}

/**
 * Settings dialog: device detection, profile editor with read-only probe, preset management,
 * the AI assistant, expert register tools, and folders. Every setup step has a control here.
 */
export class SettingsPanel extends HTMLElement {
  private root: ShadowRoot;
  private dialog!: HTMLDialogElement;
  private tab: SettingsTab = "device";

  private hid: HidDevice[] | null = null;
  private showAllHid = false;
  /** Profile being edited; `editing` is the saved profile it came from (null when new). */
  private draft: Profile | null = null;
  private editing: string | null = null;
  private jsonView = false;
  /** Template for new profiles; empty = first verified profile. */
  private templateId = "";
  private probe: ProbeReport | null = null;
  private profileMsg: { kind: "ok" | "error" | "info"; text: string } | null = null;
  private validation = "";
  private validateTimer = 0;
  private presetMsg: { kind: "ok" | "error" | "info"; text: string } | null = null;
  private presetDraft = { title: "", id: "", note: "", scoped: true };
  private onlyCompatible = true;
  private ai = { task: "eq" as AiTask, goal: "", eq: true, profile: true, hid: false, probe: true, state: true, prompt: "", reply: "" };
  private aiMsg: { kind: "ok" | "error" | "info"; text: string } | null = null;
  private advMsg: Record<string, { kind: "ok" | "error"; text: string }> = {};
  private generalMsg: { kind: "ok" | "error"; text: string } | null = null;
  private udev = "";

  constructor() {
    super();
    this.root = this.attachShadow({ mode: "open" });
    this.root.innerHTML = `
      <style>${STYLE}</style>
      <dialog aria-labelledby="dlg-title">
        <div class="frame">
          <nav>
            <h2 id="dlg-title" data-i18n="settings.title"></h2>
            ${TABS.map((tab) => `<button class="tab" data-tab="${tab}" data-i18n="settings.tab.${tab}"></button>`).join("")}
          </nav>
          <section class="body" id="body"></section>
          <button class="close" id="close" data-i18n-aria="settings.close" data-i18n-tip="settings.close">
            <svg viewBox="0 0 12 12" width="12" height="12" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"><path d="M2.5 2.5l7 7m0-7-7 7" /></svg>
          </button>
        </div>
      </dialog>`;
    this.dialog = this.root.querySelector("dialog")!;
    this.root.querySelector("#close")!.addEventListener("click", () => this.dialog.close());
    this.dialog.addEventListener("click", (e) => {
      if (e.target === this.dialog) this.dialog.close();
    });
    for (const button of this.root.querySelectorAll<HTMLButtonElement>(".tab")) {
      button.addEventListener("click", () => this.show(button.dataset.tab as SettingsTab));
    }
    const body = this.root.querySelector<HTMLElement>("#body")!;
    body.addEventListener("click", (e) => this.onClick(e));
    body.addEventListener("input", (e) => this.onInput(e));
    body.addEventListener("change", (e) => this.onChange(e));
    i18n.addEventListener("change", () => this.render());
    store.addEventListener("change", (e) => {
      if ((e as CustomEvent).detail === "meta" && this.dialog.open && this.tab !== "profiles" && this.tab !== "ai") this.render();
    });
  }

  get isOpen() {
    return this.dialog.open;
  }

  async open(tab: SettingsTab = this.tab) {
    this.tab = tab;
    this.render();
    if (!this.dialog.open) this.dialog.showModal();
    await refreshCatalog().catch(() => undefined);
    if (tab === "device" && this.hid === null) void this.scanHid();
    this.render();
  }

  private show(tab: SettingsTab) {
    this.tab = tab;
    if (tab === "profiles" && !this.draft) this.selectProfile(store.profile?.id ?? store.profiles[0]?.id ?? null);
    if (tab === "device" && this.hid === null) void this.scanHid();
    this.render();
  }

  private render() {
    for (const b of this.root.querySelectorAll<HTMLButtonElement>(".tab")) b.setAttribute("aria-current", String(b.dataset.tab === this.tab));
    const body = this.root.querySelector<HTMLElement>("#body")!;
    const html = {
      device: () => this.deviceHtml(),
      profiles: () => this.profilesHtml(),
      presets: () => this.presetsHtml(),
      ai: () => this.aiHtml(),
      advanced: () => this.advancedHtml(),
      general: () => this.generalHtml(),
    }[this.tab]();
    // Keep focus and scroll when re-rendering the same tab.
    const active = this.root.activeElement as HTMLElement | null;
    const focusKey = active?.dataset.key ?? active?.dataset.path ?? null;
    const scroll = body.scrollTop;
    body.innerHTML = html;
    applyI18n(this.root);
    body.scrollTop = scroll;
    if (focusKey) {
      const again = body.querySelector<HTMLElement>(`[data-key="${focusKey}"], [data-path="${focusKey}"]`);
      again?.focus();
      if (again instanceof HTMLInputElement || again instanceof HTMLTextAreaElement) {
        const end = again.value.length;
        again.setSelectionRange?.(end, end);
      }
    }
  }

  private msg(m: { kind: string; text: string } | null | undefined) {
    return m ? `<p class="msg" data-kind="${m.kind}">${esc(m.text)}</p>` : "";
  }

  // Device tab

  private deviceHtml() {
    const device = store.device;
    const profileOptions = store.profiles
      .map((p) => `<option value="${esc(p.id)}" ${store.forcedProfile === p.id ? "selected" : ""}>${esc(p.title)} · ${usbId(p)}</option>`)
      .join("");
    const list = (this.hid ?? []).filter((d) => this.showAllHid || likelyAudio(d));
    const rows = list
      .map((d) => {
        const matched = d.profiles
          .map((id) => store.profiles.find((p) => p.id === id)?.title ?? id)
          .map((title) => `<span class="badge ok">${esc(title)}</span>`)
          .join(" ");
        return `<tr>
          <td><b>${esc(d.product || t("hid.unnamed"))}</b><small>${esc(d.manufacturer)}</small></td>
          <td class="mono">${id16(d.vendor_id)}:${id16(d.product_id)}</td>
          <td class="mono">${id16(d.usage_page)}:${id16(d.usage)}</td>
          <td>${matched || `<button data-act="hid-profile" data-i="${this.hid!.indexOf(d)}">${esc(t("hid.create"))}</button>`}</td>
        </tr>`;
      })
      .join("");
    return `
      <h3 data-i18n="dev.heading"></h3>
      <div class="card status">
        <span class="dot" data-state="${store.connection}"></span>
        <div class="grow">
          <b>${esc(device ? device.title : t(`conn.${store.connection}`))}</b>
          <small>${
            device
              ? `${usbId(device)} · ${t("dev.bands", { n: device.protocol.bands.count })} · ${esc(device.id)}`
              : esc(t("dev.none"))
          }</small>
        </div>
        ${device && !device.verified ? `<span class="badge warn" data-i18n="badge.unverified"></span>` : ""}
        <button data-act="read" data-i18n="action.read"></button>
      </div>
      <label class="row">
        <span data-i18n="dev.profile"></span>
        <select data-key="forced">
          <option value="" ${store.forcedProfile ? "" : "selected"} data-i18n="dev.auto"></option>
          ${profileOptions}
        </select>
      </label>
      <p class="hint" data-i18n="dev.profile.hint"></p>

      <h3 data-i18n="hid.heading"></h3>
      <p class="hint" data-i18n="hid.hint"></p>
      <div class="bar">
        <button data-act="hid-scan" data-i18n="hid.scan"></button>
        <label class="check"><input type="checkbox" data-key="hid-all" ${this.showAllHid ? "checked" : ""} /><span data-i18n="hid.all"></span></label>
      </div>
      ${
        this.hid === null
          ? `<p class="hint" data-i18n="hid.scanning"></p>`
          : list.length
            ? `<table><thead><tr><th data-i18n="hid.name"></th><th>VID:PID</th><th data-i18n="hid.usage"></th><th data-i18n="hid.profile"></th></tr></thead><tbody>${rows}</tbody></table>`
            : `<p class="hint" data-i18n="hid.empty"></p>`
      }
      ${this.msg(this.profileMsg && this.tab === "device" ? this.profileMsg : null)}
      <p class="hint" data-i18n="hid.next"></p>`;
  }

  private async scanHid() {
    try {
      this.hid = await api.hidDevices();
    } catch (e) {
      this.hid = [];
      this.profileMsg = { kind: "error", text: errorText(e) };
    }
    if (this.dialog.open) this.render();
  }

  /** The profile new drafts start from: the one chosen in the list, else the first verified one. */
  private template(): Profile | undefined {
    const chosen = store.profiles.find((p) => p.id === this.templateId);
    return chosen ?? store.profiles.find((p) => p.verified) ?? store.profiles[0];
  }

  /** A new profile draft from the template, for a device found on USB. */
  private profileFromHid(d: HidDevice) {
    const template = this.template();
    if (!template) return;
    const draft = structuredClone(template) as Profile & Partial<Entry<Profile>>;
    delete draft.source;
    delete draft.path;
    delete draft.overrides_builtin;
    const shared = (this.hid ?? []).filter((x) => x.vendor_id === d.vendor_id && x.product_id === d.product_id).length > 1;
    draft.id = slug(d.product) || "my-device";
    draft.title = [d.manufacturer, d.product].filter(Boolean).join(" ") || t("hid.unnamed");
    draft.notes = t("pf.templateNote", { template: template.title });
    draft.verified = false;
    draft.usb = {
      vendor_id: hex(d.vendor_id, 4),
      product_id: hex(d.product_id, 4),
      ...(shared ? { usage_page: hex(d.usage_page, 4), usage: hex(d.usage, 4) } : {}),
    };
    this.editDraft(draft, null, { kind: "info", text: t("pf.fromHid") });
    this.tab = "profiles";
    this.render();
  }

  // Profiles tab

  private selectProfile(id: string | null) {
    const entry = store.profiles.find((p) => p.id === id);
    if (!entry) {
      this.draft = null;
      this.editing = null;
      return;
    }
    const { source: _s, path: _p, overrides_builtin: _o, ...profile } = entry;
    this.editDraft(structuredClone(profile), entry.id, null);
  }

  private editDraft(profile: Profile, editing: string | null, message: SettingsPanel["profileMsg"]) {
    this.draft = profile;
    this.editing = editing;
    this.probe = null;
    this.profileMsg = message;
    this.validation = "";
    this.scheduleValidation();
  }

  private scheduleValidation() {
    clearTimeout(this.validateTimer);
    this.validateTimer = window.setTimeout(async () => {
      if (!this.draft) return;
      let text = "";
      try {
        await api.checkProfile(this.draft);
      } catch (e) {
        text = errorText(e);
      }
      if (text === this.validation) return;
      this.validation = text;
      const el = this.root.querySelector<HTMLElement>("#validation");
      if (el) {
        el.dataset.kind = text ? "error" : "ok";
        el.textContent = text || t("pf.valid");
      }
    }, 250);
  }

  private profilesHtml() {
    const entries = store.profiles;
    const list = entries
      .map((p) => {
        const badges = [
          p.source === "builtin" ? t("badge.builtin") : p.overrides_builtin ? t("badge.override") : t("badge.user"),
          ...(p.verified ? [] : [t("badge.unverified")]),
          ...(store.device?.id === p.id ? [t("badge.connected")] : []),
        ];
        return `<button class="item" data-act="pf-select" data-id="${esc(p.id)}" aria-current="${this.editing === p.id}">
          <b>${esc(p.title)}</b><small>${esc(p.id)} · ${usbId(p)}</small>
          <span class="badges">${badges.map((b) => `<span class="badge">${esc(b)}</span>`).join("")}</span>
        </button>`;
      })
      .join("");
    const issues = store.issues.length
      ? `<div class="msg" data-kind="error"><b data-i18n="issues.heading"></b>${store.issues
          .map((i) => `<div><span class="mono">${esc(i.path)}</span>: ${esc(i.message)}</div>`)
          .join("")}</div>`
      : "";
    return `
      <h3 data-i18n="pf.heading"></h3>
      <p class="hint" data-i18n="pf.hint"></p>
      ${issues}
      <div class="split">
        <div class="list">
          ${list}
          <label><span data-i18n="pf.template"></span>
            <select data-key="pf-template">${entries
              .map((p) => `<option value="${esc(p.id)}" ${p.id === this.template()?.id ? "selected" : ""}>${esc(p.title)}</option>`)
              .join("")}</select></label>
          <div class="bar">
            <button data-act="pf-new" data-i18n="pf.new"></button>
            <button data-act="pf-import" data-i18n="pf.import"></button>
          </div>
        </div>
        <div class="editor">${this.draft ? this.profileEditorHtml(this.draft) : `<p class="hint" data-i18n="pf.pick"></p>`}</div>
      </div>`;
  }

  private profileEditorHtml(p: Profile) {
    const entry = store.profiles.find((x) => x.id === this.editing);
    const deletable = entry?.source === "user";
    const header = `
      <div class="bar sticky">
        <b class="grow">${esc(this.editing ? t("pf.editing", { id: this.editing }) : t("pf.unsaved"))}</b>
        <button data-act="pf-probe" data-i18n="pf.probe" data-i18n-tip="pf.probe.tip"></button>
        <button class="primary" data-act="pf-save" data-i18n="pf.save"></button>
      </div>
      <div class="bar">
        <button data-act="pf-duplicate" data-i18n="pf.duplicate"></button>
        <button data-act="pf-export" data-i18n="pf.export"></button>
        <button data-act="pf-json" data-i18n="${this.jsonView ? "pf.form" : "pf.json"}"></button>
        ${this.editing && store.forcedProfile !== this.editing ? `<button data-act="pf-use" data-i18n="pf.use"></button>` : ""}
        ${deletable ? `<button class="danger" data-act="pf-delete" data-i18n="${entry?.overrides_builtin ? "pf.revert" : "pf.delete"}"></button>` : ""}
      </div>
      ${entry?.source === "builtin" ? `<p class="hint" data-i18n="pf.builtinHint"></p>` : ""}
      ${this.msg(this.profileMsg)}
      <p class="msg" id="validation" data-kind="${this.validation ? "error" : "ok"}">${esc(this.validation || t("pf.valid"))}</p>
      ${this.probe ? this.probeHtml(this.probe) : ""}`;
    if (this.jsonView) {
      return `${header}
        <textarea class="code" data-key="pf-json" spellcheck="false" rows="28">${esc(JSON.stringify(p, null, 2))}</textarea>
        <div class="bar"><button data-act="pf-json-apply" data-i18n="pf.jsonApply"></button></div>`;
    }
    const field = (f: Field) => {
      const v = getPath(p, f.path);
      const label = `<span>${esc(t(f.label))}</span>`;
      // Fields of an optional section that is switched off.
      const parent = f.path.slice(0, f.path.lastIndexOf("."));
      if (f.kind !== "presence" && parent in PRESENCE_DEFAULTS && getPath(p, parent) === null) {
        return `<label>${label}<input disabled placeholder="${esc(t("pf.none"))}" /></label>`;
      }
      switch (f.kind) {
        case "order":
          return `<label>${label}<select data-path="${f.path}">${(["little", "big"] as const)
            .map((o) => `<option value="${o}" ${v === o ? "selected" : ""}>${esc(t(`pf.order.${o}`))}</option>`)
            .join("")}</select></label>`;
        case "presence":
          return `<label class="check wide"><input type="checkbox" data-path="${f.path}" data-kind="presence" ${v ? "checked" : ""} />${label}</label>`;
        case "bool":
          return `<label class="check wide"><input type="checkbox" data-path="${f.path}" ${v ? "checked" : ""} />${label}</label>`;
        case "textarea":
          return `<label class="wide">${label}<textarea data-path="${f.path}" rows="2">${esc(v)}</textarea></label>`;
        case "type":
          // Only an inaudible (gain) filter can fill empty slots.
          return `<label>${label}<select data-path="${f.path}">${FILTER_TYPES.filter(hasGain).map(
            (x) => `<option value="${x}" ${v === x ? "selected" : ""}>${esc(t(`filter.${x}`))}</option>`,
          ).join("")}</select></label>`;
        case "bytes":
          return `<label>${label}<input class="mono" data-path="${f.path}" value="${esc(
            Array.isArray(v) ? v.map((b) => (parseHex(b) ?? 0).toString(16).toUpperCase().padStart(2, "0")).join(" ") : "",
          )}" placeholder="03 00 00 00" /></label>`;
        case "hex":
        case "hexOpt":
          return `<label>${label}<input class="mono" data-path="${f.path}" data-kind="${f.kind}" value="${esc(v ?? "")}" placeholder="${
            f.kind === "hexOpt" ? esc(t("pf.none")) : "0x00"
          }" /></label>`;
        default:
          return `<label>${label}<input ${f.kind === "text" ? "" : 'class="mono" inputmode="decimal"'} data-path="${f.path}" data-kind="${f.kind}" value="${esc(v)}" /></label>`;
      }
    };
    const sections = SECTIONS.map(
      (s) => `<fieldset><legend>${esc(t(s.title))}</legend>${s.hint ? `<p class="hint">${esc(t(s.hint))}</p>` : ""}<div class="grid">${s.fields
        .map(field)
        .join("")}</div></fieldset>`,
    ).join("");
    return header + sections;
  }

  private probeHtml(r: ProbeReport) {
    const reg = (x: { register: number; value: string | null; error: string | null }) =>
      `<span class="mono">${hex(x.register)}</span> ${x.value ? `<span class="mono">${esc(x.value)}</span>` : `<span class="err">${esc(x.error)}</span>`}`;
    const bandText = (b: ProbeReport["bands"][number]["band"]) =>
      b ? `${b.gain_db} dB · ${b.frequency_hz} Hz · Q ${b.q} · ${esc(t(`filter.${b.filter_type}`))}` : "";
    return `<div class="card probe" data-ok="${r.ok}">
      <b>${esc(t(r.ok ? "probe.ok" : "probe.fail"))}</b>
      <table>
        ${
          r.eq_switch
            ? `<tr><td data-i18n="probe.switch"></td><td>${reg(r.eq_switch)}</td><td>${r.enabled === null ? "" : esc(t(r.enabled ? "probe.on" : "probe.off"))}</td></tr>`
            : `<tr><td data-i18n="probe.switch"></td><td colspan="2">${esc(t("probe.noSwitch"))}</td></tr>`
        }
        ${r.bands
          .map(
            (b, i) =>
              `<tr><td>${esc(t("band.name", { n: i + 1 }))}</td><td>${b.registers.map(reg).join("<br>")}</td><td>${
                b.band ? bandText(b.band) : `<span class="err">${esc(b.error)}</span>`
              }</td></tr>`,
          )
          .join("")}
        ${r.pregain ? `<tr><td data-i18n="probe.pregain"></td><td>${reg(r.pregain)}</td><td></td></tr>` : ""}
      </table>
      <ul>${r.findings.map((f) => `<li>${esc(f)}</li>`).join("")}</ul>
    </div>`;
  }

  // Presets tab

  private presetsHtml() {
    const profile = store.profile;
    const items = store.presets.filter((p) => !this.onlyCompatible || presetFor(p, profile));
    const rows = items
      .map((p) => {
        const scope = p.profiles.length ? p.profiles.map((id) => store.profiles.find((x) => x.id === id)?.title ?? id).join(", ") : t("preset.any");
        const source = t(`badge.${p.source === "builtin" ? "builtin" : p.source === "snapshot" ? "snapshot" : "user"}`);
        return `<div class="item static">
          <div class="grow"><b>${esc(presetTitle(p))}</b><small>${esc(presetNote(p))}</small>
            <span class="badges"><span class="badge">${esc(source)}</span><span class="badge">${esc(scope)}</span><span class="badge">${esc(
              t("preset.bands", { n: p.eq.bands.length }),
            )}</span></span></div>
          <div class="actions">
            <button data-act="ps-load" data-id="${esc(p.id)}" data-i18n="preset.load"></button>
            <button data-act="ps-export" data-id="${esc(p.id)}" data-i18n="preset.export"></button>
            ${p.source !== "builtin" ? `<button class="danger" data-act="ps-delete" data-id="${esc(p.id)}" data-i18n="preset.delete"></button>` : ""}
          </div>
        </div>`;
      })
      .join("");
    const d = this.presetDraft;
    return `
      <h3 data-i18n="preset.heading"></h3>
      <div class="bar">
        <label class="check"><input type="checkbox" data-key="ps-compatible" ${this.onlyCompatible ? "checked" : ""} /><span>${esc(
          t("preset.onlyFor", { device: profile?.title ?? t("preset.anyDevice") }),
        )}</span></label>
        <span class="grow"></span>
        <button data-act="ps-import" data-i18n="preset.import"></button>
      </div>
      ${this.msg(this.presetMsg)}
      <div class="stack">${rows || `<p class="hint" data-i18n="preset.empty"></p>`}</div>
      <h3 data-i18n="preset.saveHeading"></h3>
      <p class="hint" data-i18n="preset.saveHint"></p>
      <div class="grid">
        <label><span data-i18n="preset.title"></span><input data-key="ps-title" value="${esc(d.title)}" /></label>
        <label><span data-i18n="preset.id"></span><input class="mono" data-key="ps-id" value="${esc(d.id)}" placeholder="${esc(slug(d.title) || "my-preset")}" /></label>
        <label class="wide"><span data-i18n="preset.note"></span><textarea data-key="ps-note" rows="2">${esc(d.note)}</textarea></label>
        ${
          profile
            ? `<label class="check wide"><input type="checkbox" data-key="ps-scoped" ${d.scoped ? "checked" : ""} /><span>${esc(
                t("preset.scoped", { device: profile.title }),
              )}</span></label>`
            : ""
        }
      </div>
      <div class="bar"><button class="primary" data-act="ps-save" data-i18n="preset.save"></button></div>`;
  }

  // AI tab

  private aiHtml() {
    const a = this.ai;
    const tasks: AiTask[] = ["eq", "profile", "troubleshoot"];
    const includes: [keyof typeof a, MessageKey][] = [
      ["eq", "ai.inc.eq"],
      ["profile", "ai.inc.profile"],
      ["hid", "ai.inc.hid"],
      ["probe", "ai.inc.probe"],
      ["state", "ai.inc.state"],
    ];
    return `
      <h3 data-i18n="ai.heading"></h3>
      <p class="hint" data-i18n="ai.hint"></p>
      <ol class="steps">
        <li>
          <div class="segmented">${tasks
            .map((task) => `<button data-act="ai-task" data-task="${task}" aria-pressed="${a.task === task}">${esc(t(`ai.task.${task}`))}</button>`)
            .join("")}</div>
          <p class="hint">${esc(t(`ai.task.${a.task}.hint`))}</p>
        </li>
        <li>
          <label class="wide"><span data-i18n="ai.goal"></span>
            <textarea data-key="ai-goal" rows="3" placeholder="${esc(t(`ai.goal.${a.task}`))}">${esc(a.goal)}</textarea></label>
          <div class="checks">${includes
            .map(([k, label]) => `<label class="check"><input type="checkbox" data-key="ai-inc-${k}" ${a[k] ? "checked" : ""} /><span>${esc(t(label))}</span></label>`)
            .join("")}</div>
        </li>
        <li>
          <div class="bar">
            <button class="primary" data-act="ai-build" data-i18n="ai.build"></button>
            <button data-act="ai-copy" ${a.prompt ? "" : "disabled"} data-i18n="ai.copy"></button>
            <span class="hint">${a.prompt ? esc(t("ai.length", { n: a.prompt.length })) : ""}</span>
          </div>
          ${a.prompt ? `<textarea class="code" readonly rows="10" data-key="ai-prompt">${esc(a.prompt)}</textarea>` : ""}
        </li>
        <li>
          <label class="wide"><span data-i18n="ai.reply"></span>
            <textarea class="code" data-key="ai-reply" rows="6" placeholder="${esc(t("ai.reply.placeholder"))}">${esc(a.reply)}</textarea></label>
          <div class="bar"><button class="primary" data-act="ai-load" data-i18n="ai.load"></button></div>
          ${this.msg(this.aiMsg)}
        </li>
      </ol>
      <p class="hint" data-i18n="ai.docs"></p>`;
  }

  private async buildPrompt() {
    const a = this.ai;
    let hid: HidDevice[] | null = null;
    if (a.hid) hid = this.hid ?? (await api.hidDevices().catch(() => null));
    const status = store.status.key ? t(store.status.key, store.status.params) + (store.status.detail ? ` — ${store.status.detail}` : "") : "";
    const profile = a.task === "profile" ? this.draft ?? store.profile : store.profile;
    a.prompt = buildPrompt(a.task, {
      goal: a.goal,
      language: AI_LANGUAGE[lang()],
      profile: a.profile ? profile : null,
      eq: a.eq ? toWire(store.eq) : null,
      hid,
      probe: a.probe ? this.probe : null,
      settings: a.state ? store.settingsInfo?.settings ?? null : null,
      connection: a.state ? `${store.connection}${store.device ? ` (${store.device.title})` : ""}` : "(not included)",
      status: a.state ? status : "",
    });
    this.aiMsg = null;
    this.render();
  }

  private loadReply() {
    try {
      const result = parseReply(this.ai.reply);
      if (result.kind === "profile") {
        this.editDraft(withDefaults(result.profile), null, { kind: "info", text: t("ai.loaded.profile") });
        this.jsonView = false;
        this.tab = "profiles";
        this.render();
        return;
      }
      const eq: WireEqState = result.kind === "preset" ? result.preset.eq : result.eq;
      const problems = eqProblems(eq, store.profile);
      if (problems.length) {
        this.aiMsg = { kind: "error", text: t("ai.invalid", { problems: problems.join(" · ") }) };
      } else {
        store.setEq(fromWire(eq, store.eq.bands.map((b) => b.color)));
        if (result.kind === "preset") {
          const p = result.preset;
          this.presetDraft = { title: p.title ?? "", id: p.id ?? "", note: p.note ?? "", scoped: true };
        }
        this.aiMsg = { kind: "ok", text: t(result.kind === "preset" ? "ai.loaded.preset" : "ai.loaded.eq") };
        store.setMeta({ status: { kind: "info", key: "status.ai" } });
      }
    } catch (e) {
      this.aiMsg = { kind: "error", text: errorText(e) };
    }
    this.render();
  }

  // Advanced tab

  private advancedHtml() {
    const connected = store.connection === "connected";
    const dis = connected ? "" : "disabled";
    const m = (k: string) => this.msg(this.advMsg[k]);
    const pregain = store.device?.protocol.pregain_register != null;
    // Examples built from the active profile: its first band register and a read request for it.
    const prof = store.profile;
    const firstBand = parseHex(prof?.protocol.bands.first_register) ?? 0;
    const regHint = prof ? hex(firstBand) : "0x00";
    const rawHint = prof ? readRequest(prof, firstBand) : "";
    const valueHint = Array(prof?.protocol.frame.value_length ?? 4).fill("00").join(" ");
    const commit = store.device?.protocol.commit_command != null;
    return `
      <h3 data-i18n="adv.heading"></h3>
      <p class="msg" data-kind="error" data-i18n="adv.warning"></p>
      ${connected ? "" : `<p class="hint" data-i18n="adv.noDevice"></p>`}
      <fieldset><legend data-i18n="adv.register"></legend>
        <div class="grid">
          <label><span data-i18n="pf.register"></span><input class="mono" data-key="adv-reg" placeholder="${esc(regHint)}" /></label>
          <label><span data-i18n="adv.value"></span><input class="mono" data-key="adv-value" placeholder="${esc(valueHint)}" /></label>
        </div>
        <div class="bar"><button ${dis} data-act="adv-read" data-i18n="adv.read"></button><button ${dis} class="danger" data-act="adv-write" data-i18n="adv.write"></button></div>
        ${m("register")}
      </fieldset>
      <fieldset><legend data-i18n="adv.pregain"></legend>
        <p class="hint" data-i18n="adv.pregain.hint"></p>
        <div class="grid"><label><span data-i18n="adv.pregain.db"></span><input class="mono" data-key="adv-pregain" inputmode="numeric" placeholder="0" /></label></div>
        <div class="bar"><button ${connected && pregain ? "" : "disabled"} data-act="adv-pregain-read" data-i18n="adv.read"></button><button ${
          connected && pregain ? "" : "disabled"
        } class="danger" data-act="adv-pregain-write" data-i18n="adv.write"></button></div>
        ${m("pregain")}
      </fieldset>
      <fieldset><legend data-i18n="adv.raw"></legend>
        <p class="hint" data-i18n="adv.raw.hint"></p>
        <label class="wide"><input class="mono" data-key="adv-raw" placeholder="${esc(rawHint)}" /></label>
        <div class="bar"><button ${dis} class="danger" data-act="adv-raw" data-i18n="adv.send"></button></div>
        ${m("raw")}
      </fieldset>
      <fieldset><legend data-i18n="adv.commit"></legend>
        <p class="hint" data-i18n="adv.commit.hint"></p>
        <div class="bar"><button ${connected && commit ? "" : "disabled"} class="danger" data-act="adv-commit" data-i18n="adv.commit"></button></div>
        ${m("commit")}
      </fieldset>`;
  }

  // General tab

  private generalHtml() {
    const info = store.settingsInfo;
    if (!info) return `<p class="hint" data-i18n="gen.loading"></p>`;
    return `
      <h3 data-i18n="gen.heading"></h3>
      <fieldset><legend data-i18n="gen.data"></legend>
        <p class="hint" data-i18n="gen.data.hint"></p>
        <div class="path mono">${esc(info.home)}</div>
        <div class="bar"><button data-act="gen-open" data-path="${esc(info.home)}" data-i18n="gen.open"></button></div>
      </fieldset>
      <fieldset><legend data-i18n="gen.backup"></legend>
        <p class="hint" data-i18n="gen.backup.hint"></p>
        <div class="path mono">${esc(info.backup_dir)}</div>
        <div class="bar">
          <button data-act="gen-backup-pick" data-i18n="gen.change"></button>
          ${info.settings.backup_dir ? `<button data-act="gen-backup-default" data-i18n="gen.default"></button>` : ""}
          <button data-act="gen-open" data-path="${esc(info.backup_dir)}" data-i18n="gen.open"></button>
        </div>
      </fieldset>
      <fieldset><legend data-i18n="gen.snapshot"></legend>
        <label class="check wide"><input type="checkbox" data-key="gen-capture" ${info.settings.capture_original ? "checked" : ""} /><span data-i18n="gen.capture"></span></label>
        <p class="hint" data-i18n="gen.snapshot.hint"></p>
      </fieldset>
      <fieldset><legend data-i18n="gen.udev"></legend>
        <p class="hint" data-i18n="gen.udev.hint"></p>
        ${this.udev ? `<textarea class="code" readonly rows="4">${esc(this.udev)}</textarea>` : ""}
        <div class="bar"><button data-act="gen-udev" data-i18n="gen.udev.show"></button>${
          this.udev ? `<button data-act="gen-udev-copy" data-i18n="ai.copy.short"></button>` : ""
        }</div>
      </fieldset>
      ${this.msg(this.generalMsg)}`;
  }

  private async saveSettings(patch: Partial<Settings>) {
    const current = store.settingsInfo?.settings ?? { profile: null, backup_dir: null, capture_original: true };
    try {
      const info = await api.setSettings({ ...current, ...patch });
      store.setMeta({ settingsInfo: info, forcedProfile: info.settings.profile });
      this.generalMsg = { kind: "ok", text: t("gen.saved") };
      return true;
    } catch (e) {
      this.generalMsg = { kind: "error", text: errorText(e) };
      this.profileMsg = { kind: "error", text: errorText(e) };
      this.render();
      return false;
    }
  }

  // Events

  private onInput(e: Event) {
    const el = e.target as HTMLInputElement | HTMLTextAreaElement;
    const key = el.dataset.key;
    if (el.dataset.path && this.draft) {
      const kind = el.dataset.kind as Kind | undefined;
      const path = el.dataset.path;
      let value: unknown = el.value;
      if (kind === "presence") {
        setPath(this.draft, path, (el as HTMLInputElement).checked ? structuredClone(PRESENCE_DEFAULTS[path]) : null);
        this.scheduleValidation();
        this.render();
        return;
      }
      if (el instanceof HTMLInputElement && el.type === "checkbox") value = el.checked;
      else if (kind === "hex") value = normalizeHex(el.value);
      else if (kind === "hexOpt") value = normalizeHex(el.value) || null;
      else if (kind === "int" || kind === "num") value = el.value.trim() === "" ? null : Number(el.value);
      else if (path.endsWith("read_argument"))
        value = el.value
          .trim()
          .split(/[\s,]+/)
          .filter(Boolean)
          .map((b) => normalizeHex(b));
      setPath(this.draft, path, value);
      this.scheduleValidation();
      return;
    }
    if (key === "ps-title") {
      this.presetDraft.title = el.value;
      const id = this.root.querySelector<HTMLInputElement>('[data-key="ps-id"]');
      if (id) id.placeholder = slug(el.value) || "my-preset";
    } else if (key === "ps-id") this.presetDraft.id = el.value;
    else if (key === "ps-note") this.presetDraft.note = el.value;
    else if (key === "ai-goal") this.ai.goal = el.value;
    else if (key === "ai-reply") this.ai.reply = el.value;
  }

  private async onChange(e: Event) {
    const el = e.target as HTMLInputElement & HTMLSelectElement;
    const key = el.dataset.key;
    if (el.dataset.path && el.tagName === "SELECT" && this.draft) {
      setPath(this.draft, el.dataset.path, el.value);
      this.scheduleValidation();
      return;
    }
    if (key === "forced") {
      if (await this.saveSettings({ profile: el.value || null })) runCommand("read");
    } else if (key === "pf-template") {
      this.templateId = el.value;
    } else if (key === "hid-all") {
      this.showAllHid = el.checked;
      this.render();
    } else if (key === "ps-compatible") {
      this.onlyCompatible = el.checked;
      this.render();
    } else if (key === "ps-scoped") this.presetDraft.scoped = el.checked;
    else if (key?.startsWith("ai-inc-")) (this.ai as Record<string, unknown>)[key.slice(7)] = el.checked;
    else if (key === "gen-capture") {
      await this.saveSettings({ capture_original: el.checked });
      this.render();
    }
  }

  private async onClick(e: Event) {
    const button = (e.target as HTMLElement).closest<HTMLButtonElement>("button[data-act]");
    if (!button || button.disabled) return;
    const act = button.dataset.act!;
    const id = button.dataset.id ?? "";
    const value = (key: string) => this.root.querySelector<HTMLInputElement>(`[data-key="${key}"]`)?.value ?? "";
    button.disabled = true;
    try {
      switch (act) {
        case "read":
          runCommand("read");
          break;
        case "hid-scan":
          this.hid = null;
          this.render();
          await this.scanHid();
          break;
        case "hid-profile":
          this.profileFromHid(this.hid![Number(button.dataset.i)]);
          break;

        case "pf-select":
          this.selectProfile(id);
          this.jsonView = false;
          break;
        case "pf-new": {
          const template = this.template();
          if (!template) break;
          const { source: _s, path: _p, overrides_builtin: _o, ...base } = structuredClone(template) as Entry<Profile>;
          this.editDraft(
            { ...base, id: "my-device", title: t("pf.newTitle"), notes: t("pf.templateNote", { template: template.title }), verified: false },
            null,
            { kind: "info", text: t("pf.newHint") },
          );
          break;
        }
        case "pf-import": {
          const profile = await api.importProfile();
          if (profile) this.editDraft(profile, null, { kind: "info", text: t("pf.imported") });
          break;
        }
        case "pf-duplicate":
          if (this.draft)
            this.editDraft({ ...structuredClone(this.draft), id: `${this.draft.id}-copy`, verified: false }, null, {
              kind: "info",
              text: t("pf.duplicated"),
            });
          break;
        case "pf-json":
          this.jsonView = !this.jsonView;
          break;
        case "pf-json-apply":
          try {
            this.draft = withDefaults(JSON.parse(value("pf-json")));
            this.jsonView = false;
            this.profileMsg = null;
            this.scheduleValidation();
          } catch (err) {
            this.profileMsg = { kind: "error", text: errorText(err) };
          }
          break;
        case "pf-probe":
          if (!this.draft) break;
          this.profileMsg = { kind: "info", text: t("pf.probing") };
          this.render();
          try {
            this.probe = await api.probe(this.draft);
            this.profileMsg = null;
          } catch (err) {
            this.probe = null;
            this.profileMsg = { kind: "error", text: t("pf.probeFailed", { message: errorText(err) }) };
          }
          break;
        case "pf-save": {
          if (!this.draft) break;
          const replacing = store.profiles.find((p) => p.id === this.draft!.id);
          if (replacing && this.editing !== this.draft.id && replacing.source === "user") {
            if (!(await api.confirm(t("pf.overwrite", { id: this.draft.id }), t("settings.title")))) break;
          }
          try {
            const path = await api.saveProfile(this.draft);
            await refreshCatalog();
            this.editing = this.draft.id;
            this.profileMsg = { kind: "ok", text: t("pf.saved", { path }) };
            if (store.device?.id === this.draft.id || !store.device) runCommand("read");
          } catch (err) {
            this.profileMsg = { kind: "error", text: errorText(err) };
          }
          break;
        }
        case "pf-export":
          if (this.draft && (await api.exportProfile(this.draft))) this.profileMsg = { kind: "ok", text: t("pf.exported") };
          break;
        case "pf-use":
          if (this.editing && (await this.saveSettings({ profile: this.editing }))) {
            this.profileMsg = { kind: "ok", text: t("pf.using") };
            runCommand("read");
          }
          break;
        case "pf-delete": {
          if (!this.editing || !(await api.confirm(t("pf.deleteConfirm", { id: this.editing }), t("settings.title")))) break;
          await api.deleteProfile(this.editing);
          if (store.forcedProfile === this.editing && !store.profiles.some((p) => p.id === this.editing && p.source === "builtin"))
            await this.saveSettings({ profile: null });
          await refreshCatalog();
          this.selectProfile(store.profiles.find((p) => p.id === this.editing)?.id ?? null);
          this.profileMsg = { kind: "ok", text: t("pf.deleted") };
          break;
        }

        case "ps-load": {
          const p = store.presets.find((x) => x.id === id);
          if (!p) break;
          const problems = eqProblems(p.eq, store.profile);
          if (problems.length) {
            this.presetMsg = { kind: "error", text: problems.join(" · ") };
            break;
          }
          store.setEq(fromWire(p.eq), { presetId: p.id });
          this.presetMsg = { kind: "ok", text: t("status.preset", { title: presetTitle(p) }) };
          break;
        }
        case "ps-export": {
          const p = store.presets.find((x) => x.id === id);
          if (p) {
            const { source: _s, path: _p, overrides_builtin: _o, ...preset } = p;
            if (await api.exportPreset(preset)) this.presetMsg = { kind: "ok", text: t("preset.exported") };
          }
          break;
        }
        case "ps-delete":
          if (!(await api.confirm(t("preset.deleteConfirm", { id }), t("settings.title")))) break;
          await api.deletePreset(id);
          await refreshCatalog();
          this.presetMsg = { kind: "ok", text: t("preset.deleted") };
          break;
        case "ps-import": {
          const preset = await api.importPreset();
          if (!preset) break;
          const path = await api.savePreset(preset);
          await refreshCatalog();
          this.presetMsg = { kind: "ok", text: t("preset.saved", { path }) };
          break;
        }
        case "ps-save": {
          const d = this.presetDraft;
          const presetId = d.id.trim() || slug(d.title);
          if (!d.title.trim() || !presetId) {
            this.presetMsg = { kind: "error", text: t("preset.needTitle") };
            break;
          }
          if (store.presets.some((p) => p.id === presetId && p.source !== "builtin")) {
            if (!(await api.confirm(t("preset.overwrite", { id: presetId }), t("settings.title")))) break;
          }
          const preset: Preset = {
            id: presetId,
            title: d.title.trim(),
            note: d.note.trim(),
            profiles: d.scoped && store.profile ? [store.profile.id] : [],
            eq: toWire(store.eq),
          };
          const path = await api.savePreset(preset);
          await refreshCatalog();
          store.setMeta({ status: { kind: "ok", key: "preset.saved", params: { path } } });
          this.presetMsg = { kind: "ok", text: t("preset.saved", { path }) };
          this.presetDraft = { title: "", id: "", note: "", scoped: true };
          break;
        }

        case "ai-task":
          this.ai.task = button.dataset.task as AiTask;
          this.ai.prompt = "";
          if (this.ai.task === "profile") this.ai.hid = true;
          break;
        case "ai-build":
          await this.buildPrompt();
          return;
        case "ai-copy":
          await navigator.clipboard.writeText(this.ai.prompt);
          this.aiMsg = { kind: "ok", text: t("ai.copied") };
          break;
        case "ai-load":
          this.loadReply();
          return;

        case "adv-read":
        case "adv-write": {
          const reg = parseHex(normalizeHex(value("adv-reg")));
          if (reg === null || reg > 255) {
            this.advMsg.register = { kind: "error", text: t("adv.badRegister") };
            break;
          }
          if (act === "adv-read") {
            this.advMsg.register = { kind: "ok", text: `${hex(reg)} = ${await api.registerRead(reg)}` };
          } else {
            if (!(await api.confirm(t("adv.confirm"), t("adv.heading")))) break;
            await api.registerWrite(reg, value("adv-value"));
            this.advMsg.register = { kind: "ok", text: t("adv.written", { reg: hex(reg) }) };
          }
          break;
        }
        case "adv-pregain-read":
          this.advMsg.pregain = { kind: "ok", text: `${await api.pregainRead()} dB` };
          break;
        case "adv-pregain-write": {
          const db = Number(value("adv-pregain"));
          if (!Number.isInteger(db) || db < -128 || db > 127) {
            this.advMsg.pregain = { kind: "error", text: t("adv.badPregain") };
            break;
          }
          if (!(await api.confirm(t("adv.confirm"), t("adv.heading")))) break;
          await api.pregainWrite(db);
          this.advMsg.pregain = { kind: "ok", text: t("adv.pregain.written", { db }) };
          break;
        }
        case "adv-raw":
          if (!(await api.confirm(t("adv.confirm"), t("adv.heading")))) break;
          this.advMsg.raw = { kind: "ok", text: `→ ${await api.rawTransact(value("adv-raw"))}` };
          break;
        case "adv-commit":
          if (!(await api.confirm(t("adv.commit.confirm"), t("adv.heading")))) break;
          await api.commit();
          this.advMsg.commit = { kind: "ok", text: t("adv.committed") };
          break;

        case "gen-open":
          await api.reveal(button.dataset.path!);
          break;
        case "gen-backup-pick": {
          const path = await api.pickFolder(store.settingsInfo?.backup_dir);
          if (path) await this.saveSettings({ backup_dir: path });
          break;
        }
        case "gen-udev":
          this.udev = await api.udevRules();
          break;
        case "gen-udev-copy":
          await navigator.clipboard.writeText(this.udev);
          this.generalMsg = { kind: "ok", text: t("gen.udev.copied") };
          break;
        case "gen-backup-default":
          await this.saveSettings({ backup_dir: null });
          break;
      }
    } catch (err) {
      const text = errorText(err);
      if (act.startsWith("adv-")) {
        const slot = act.includes("pregain") ? "pregain" : act === "adv-raw" ? "raw" : act === "adv-commit" ? "commit" : "register";
        this.advMsg[slot] = { kind: "error", text };
      } else if (act.startsWith("ps-")) this.presetMsg = { kind: "error", text };
      else if (act.startsWith("ai-")) this.aiMsg = { kind: "error", text };
      else if (act.startsWith("gen-")) this.generalMsg = { kind: "error", text };
      else this.profileMsg = { kind: "error", text };
    }
    this.render();
  }
}

const STYLE = `
  :host, *, *::before, *::after { box-sizing: border-box; }
  dialog { padding: 0; border: 1px solid var(--border-strong); border-radius: 14px; background: var(--bg); color: var(--text);
    width: min(1040px, calc(100vw - 48px)); height: min(760px, calc(100vh - 48px)); max-width: none; max-height: none;
    box-shadow: var(--shadow); font: 13px/1.45 var(--font); }
  dialog::backdrop { background: rgba(0, 0, 0, .45); }
  .frame { position: relative; display: grid; grid-template-columns: 188px minmax(0, 1fr); height: 100%; }
  nav { display: flex; flex-direction: column; gap: 2px; padding: 16px 10px; border-right: 1px solid var(--border);
    background: color-mix(in srgb, var(--surface) 70%, var(--bg)); }
  nav h2 { font-size: 13px; margin: 2px 10px 12px; color: var(--muted); font-weight: 600; }
  .tab { all: unset; padding: 7px 10px; border-radius: 7px; cursor: pointer; font-weight: 500; }
  .tab:hover { background: var(--surface-2); }
  .tab[aria-current=true] { background: var(--surface-3); color: var(--accent); }
  .tab:focus-visible { outline: 2px solid var(--accent); }
  .body { overflow: auto; padding: 18px 24px 28px; user-select: text; -webkit-user-select: text; }
  .close { position: absolute; top: 10px; right: 10px; width: 28px; height: 28px; padding: 0; justify-content: center; }
  h3 { font-size: 15px; margin: 4px 0 8px; }
  h3:not(:first-child) { margin-top: 22px; }
  p { margin: 6px 0; }
  .hint { color: var(--muted); font-size: 12px; }
  small { display: block; color: var(--muted); font-size: 11.5px; }
  .mono { font-family: var(--mono); font-size: 12px; }
  .err { color: var(--danger); }
  .grow { flex: 1; min-width: 0; }
  button, select, input, textarea { font: inherit; color: inherit; }
  button { display: inline-flex; align-items: center; gap: 6px; height: 28px; padding: 0 11px; border-radius: 7px;
    border: 1px solid var(--border); background: var(--surface-2); cursor: pointer; font-weight: 500; white-space: nowrap; }
  button:hover:not(:disabled) { background: var(--surface-3); border-color: var(--border-strong); }
  button:disabled { opacity: .45; cursor: default; }
  button.primary { background: var(--accent); border-color: transparent; color: var(--accent-ink); font-weight: 600; }
  button.danger { color: var(--danger); }
  button:focus-visible, select:focus-visible, input:focus-visible, textarea:focus-visible { outline: 2px solid var(--accent); outline-offset: 1px; }
  input, select, textarea { width: 100%; min-width: 0; padding: 5px 8px; border-radius: 7px; border: 1px solid var(--border);
    background: var(--surface); }
  input[type=checkbox] { width: auto; accent-color: var(--accent); }
  textarea { resize: vertical; }
  textarea.code { font: 11.5px/1.45 var(--mono); }
  label { display: flex; flex-direction: column; gap: 4px; font-size: 12px; color: var(--muted); }
  label > span { font-weight: 500; }
  label.row { flex-direction: row; align-items: center; gap: 10px; }
  label.row select { max-width: 420px; }
  label.check { flex-direction: row; align-items: center; gap: 7px; color: var(--text); cursor: pointer; }
  .wide { grid-column: 1 / -1; }
  .grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(150px, 1fr)); gap: 10px 12px; }
  .bar { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; margin: 8px 0; }
  .bar.sticky { position: sticky; top: -18px; z-index: 1; padding: 8px 0; margin-top: 0; background: var(--bg); }
  .checks { display: flex; flex-wrap: wrap; gap: 6px 16px; margin-top: 8px; }
  fieldset { border: 1px solid var(--border); border-radius: 10px; padding: 10px 14px 14px; margin: 12px 0; }
  legend { padding: 0 6px; font-weight: 600; }
  fieldset > .hint:first-of-type { margin-top: 0; }
  .card { display: flex; align-items: center; gap: 12px; padding: 12px 14px; border: 1px solid var(--border); border-radius: 10px; background: var(--surface); }
  .card.probe { display: block; margin: 10px 0; }
  .card.probe[data-ok=true] { border-color: color-mix(in srgb, var(--ok) 55%, var(--border)); }
  .card.probe[data-ok=false] { border-color: color-mix(in srgb, var(--danger) 55%, var(--border)); }
  .card.probe ul { margin: 8px 0 0; padding-left: 18px; }
  .dot { width: 10px; height: 10px; border-radius: 50%; background: var(--faint); flex: none; }
  .dot[data-state=connected] { background: var(--ok); }
  .dot[data-state=missing] { background: var(--danger); }
  .badge { display: inline-block; font-size: 10.5px; font-weight: 600; padding: 1px 7px; border-radius: 99px; background: var(--surface-3); color: var(--muted); }
  .badge.ok { background: color-mix(in srgb, var(--ok) 16%, transparent); color: var(--ok); }
  .badge.warn { background: color-mix(in srgb, var(--warn) 16%, transparent); color: var(--warn); }
  .badges { display: flex; flex-wrap: wrap; gap: 4px; margin-top: 4px; }
  .msg { padding: 8px 10px; border-radius: 8px; font-size: 12px; background: var(--surface-2); }
  .msg[data-kind=ok] { color: var(--ok); background: color-mix(in srgb, var(--ok) 10%, transparent); }
  .msg[data-kind=error] { color: var(--danger); background: color-mix(in srgb, var(--danger) 10%, transparent); }
  .msg[data-kind=info] { color: var(--text); }
  table { width: 100%; border-collapse: collapse; font-size: 12px; margin: 8px 0; }
  th, td { text-align: left; padding: 6px 8px; border-bottom: 1px solid var(--border); vertical-align: top; }
  th { color: var(--muted); font-weight: 600; }
  .split { display: grid; grid-template-columns: 240px minmax(0, 1fr); gap: 16px; align-items: start; }
  .list { display: flex; flex-direction: column; gap: 6px; position: sticky; top: 0; }
  .item { all: unset; display: block; padding: 8px 10px; border-radius: 9px; border: 1px solid var(--border); background: var(--surface); cursor: pointer; }
  .item[aria-current=true] { border-color: var(--accent); box-shadow: 0 0 0 1px var(--accent); }
  .item:focus-visible { outline: 2px solid var(--accent); }
  .item.static { display: flex; gap: 12px; align-items: center; cursor: default; }
  .actions { display: flex; gap: 6px; flex: none; }
  .stack { display: flex; flex-direction: column; gap: 6px; }
  .path { padding: 7px 10px; border-radius: 7px; background: var(--surface-2); word-break: break-all; }
  .steps { padding-left: 20px; margin: 10px 0; display: flex; flex-direction: column; gap: 16px; }
  .steps > li::marker { color: var(--accent); font-weight: 700; }
  .segmented { display: inline-flex; border: 1px solid var(--border); border-radius: 8px; overflow: hidden; }
  .segmented button { border: 0; border-radius: 0; background: var(--surface-2); }
  .segmented button[aria-pressed=true] { background: var(--accent); color: var(--accent-ink); }
`;

customElements.define("md-settings", SettingsPanel);
