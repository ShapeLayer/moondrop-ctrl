import { invoke, isTauri } from "@tauri-apps/api/core";
import { ask, open, save } from "@tauri-apps/plugin-dialog";
import chu2Profile from "../../crates/moondrop-core/profiles/chu2-dsp.json";
import chu2Quiet from "../../crates/moondrop-core/presets/chu2-quiet-18db.json";
import flatPreset from "../../crates/moondrop-core/presets/flat.json";
import { t } from "./i18n";
import type {
  ApplyReport,
  Entry,
  HidDevice,
  Listing,
  Preset,
  ProbeReport,
  Profile,
  ReadReport,
  Settings,
  SettingsInfo,
  Source,
  WireEqState,
} from "./types";
import { parseHex, withDefaults } from "./types";

/** Bridge to the Rust commands in src-tauri. Outside Tauri (plain `vite` dev) a mock device is used. */
export interface Api {
  readonly mock: boolean;
  /** Profile of the connected device, or null when no supported device is found. */
  device(): Promise<Profile | null>;
  /** OS preferred languages, most preferred first. */
  systemLocales(): Promise<string[]>;
  readEq(): Promise<ReadReport>;
  applyEq(state: WireEqState, commit: boolean): Promise<ApplyReport>;
  /** Returns false when the user cancelled the file dialog. */
  exportJson(state: WireEqState): Promise<boolean>;
  importJson(): Promise<WireEqState | null>;

  profiles(): Promise<Listing<Profile>>;
  saveProfile(profile: Profile): Promise<string>;
  deleteProfile(id: string): Promise<void>;
  /** Throws the validation error, if any. */
  checkProfile(profile: Profile): Promise<void>;
  importProfile(): Promise<Profile | null>;
  exportProfile(profile: Profile): Promise<boolean>;
  hidDevices(): Promise<HidDevice[]>;
  probe(profile: Profile): Promise<ProbeReport>;

  presets(): Promise<Listing<Preset>>;
  savePreset(preset: Preset): Promise<string>;
  deletePreset(id: string): Promise<void>;
  importPreset(): Promise<Preset | null>;
  exportPreset(preset: Preset): Promise<boolean>;

  settings(): Promise<SettingsInfo>;
  setSettings(settings: Settings): Promise<SettingsInfo>;
  /** Folder picker; null when cancelled. */
  pickFolder(start?: string): Promise<string | null>;
  reveal(path: string): Promise<void>;
  confirm(message: string, title: string): Promise<boolean>;

  registerRead(register: number): Promise<string>;
  registerWrite(register: number, value: string): Promise<void>;
  rawTransact(report: string): Promise<string>;
  /** Linux udev rules for every known profile's USB vendor. */
  udevRules(): Promise<string>;
  pregainRead(): Promise<number>;
  pregainWrite(db: number): Promise<void>;
  commit(): Promise<void>;
}

const jsonFilter = () => [{ name: t("file.filter"), extensions: ["json"] }];
const EQ_FILE_NAME = "eq-preset.json";

async function pickOpen(): Promise<string | null> {
  const path = await open({ multiple: false, directory: false, filters: jsonFilter() });
  return typeof path === "string" ? path : null;
}

const tauriApi: Api = {
  mock: false,
  device: () => invoke("device_profile"),
  systemLocales: () => invoke("system_locales"),
  readEq: () => invoke("read_eq"),
  applyEq: (state, commit) => invoke("apply_eq", { state, commit }),
  async exportJson(state) {
    const path = await save({ defaultPath: EQ_FILE_NAME, filters: jsonFilter() });
    if (!path) return false;
    await invoke("export_json", { path, state });
    return true;
  },
  async importJson() {
    const path = await pickOpen();
    return path ? invoke("import_json", { path }) : null;
  },

  profiles: () => invoke("list_profiles"),
  saveProfile: (profile) => invoke("save_profile", { profile }),
  deleteProfile: (id) => invoke("delete_profile", { id }),
  checkProfile: (profile) => invoke("check_profile", { profile }),
  async importProfile() {
    const path = await pickOpen();
    return path ? invoke("import_profile", { path }) : null;
  },
  async exportProfile(profile) {
    const path = await save({ defaultPath: `${profile.id}.json`, filters: jsonFilter() });
    if (!path) return false;
    await invoke("export_profile", { path, profile });
    return true;
  },
  hidDevices: () => invoke("hid_devices"),
  probe: (profile) => invoke("probe", { profile }),

  presets: () => invoke("list_presets"),
  savePreset: (preset) => invoke("save_preset", { preset }),
  deletePreset: (id) => invoke("delete_preset", { id }),
  async importPreset() {
    const path = await pickOpen();
    return path ? invoke("import_preset", { path }) : null;
  },
  async exportPreset(preset) {
    const path = await save({ defaultPath: `${preset.id}.json`, filters: jsonFilter() });
    if (!path) return false;
    await invoke("export_preset", { path, preset });
    return true;
  },

  settings: () => invoke("get_settings"),
  setSettings: (settings) => invoke("set_settings", { settings }),
  async pickFolder(start) {
    const path = await open({ directory: true, multiple: false, defaultPath: start });
    return typeof path === "string" ? path : null;
  },
  reveal: (path) => invoke("reveal", { path }),
  confirm: (message, title) => ask(message, { title, kind: "warning" }),

  registerRead: (register) => invoke("register_read", { register }),
  registerWrite: (register, value) => invoke("register_write", { register, value }),
  rawTransact: (report) => invoke("raw_transact", { report }),
  udevRules: () => invoke("udev_rules"),
  pregainRead: () => invoke("pregain_read"),
  pregainWrite: (db) => invoke("pregain_write", { db }),
  commit: () => invoke("commit"),
};

/** Strips the `$schema` key the bundled JSON files carry. */
const plain = <T>(value: object): T => {
  const { $schema: _, ...rest } = value as Record<string, unknown>;
  return structuredClone(rest) as T;
};

/** The device stores no colors, and a read reports only the bands in use. */
const deviceCopy = (state: WireEqState): WireEqState => ({
  enabled: state.enabled,
  bands: state.bands.map(({ color: _, ...b }) => b),
});

/** A browser-only stand-in for the Rust side, backed by the built-in profile and presets. */
function mockApi(): Api {
  const builtinProfile = withDefaults(plain<Profile>(chu2Profile));
  const mockProfile: Profile = { ...builtinProfile, title: `${builtinProfile.title} (mock)` };
  const builtinPresets = [plain<Preset>(flatPreset), plain<Preset>(chu2Quiet)];
  const userProfiles: Profile[] = [];
  const userPresets: Preset[] = [];
  let settings: Settings = { profile: null, backup_dir: null, capture_original: true };
  let device = deviceCopy(builtinPresets[1].eq);
  const registers = new Map<number, string>();
  const delay = <T>(value: T, ms = 250) => new Promise<T>((r) => setTimeout(() => r(structuredClone(value)), ms));
  const entry = <T extends { id: string }>(item: T, source: Source, builtins: { id: string }[] = []): Entry<T> => ({
    ...item,
    source,
    path: source === "builtin" ? null : `~/mock/${item.id}.json`,
    overrides_builtin: source === "user" && builtins.some((b) => b.id === item.id),
  });
  const merge = <T extends { id: string }>(builtins: T[], users: T[]): Entry<T>[] => [
    ...builtins.filter((b) => !users.some((u) => u.id === b.id)).map((b) => entry(b, "builtin")),
    ...users.map((u) => entry(u, "user", builtins)),
  ];
  const info = (): SettingsInfo => ({
    settings,
    home: "~/Library/Application Support/moondrop-ctrl",
    backup_dir: settings.backup_dir ?? "~/Documents/Moondrop Ctrl Backups",
    default_backup_dir: "~/Documents/Moondrop Ctrl Backups",
  });
  const download = (name: string, value: unknown) => {
    const url = URL.createObjectURL(new Blob([JSON.stringify(value, null, 2)], { type: "application/json" }));
    Object.assign(document.createElement("a"), { href: url, download: name }).click();
    URL.revokeObjectURL(url);
    return true;
  };
  const upload = <T>(): Promise<T | null> =>
    new Promise((resolve, reject) => {
      const input = Object.assign(document.createElement("input"), { type: "file", accept: ".json" });
      input.onchange = async () => {
        const file = input.files?.[0];
        if (!file) return resolve(null);
        try {
          resolve(JSON.parse(await file.text()));
        } catch (e) {
          reject(e);
        }
      };
      input.click();
    });
  const check = (p: Profile) => {
    if (!/^[a-z0-9_-]{1,64}$/.test(p.id)) throw new Error("id must be 1-64 characters of a-z, 0-9, - and _");
    if (!p.title.trim()) throw new Error("title is empty");
    if (p.protocol.bands.count < 1 || p.protocol.bands.count > 16) throw new Error("bands.count must be 1 to 16");
    // The full checks live in the Rust core; the mock only mirrors the common ones.
  };
  return {
    mock: true,
    device: () => delay(mockProfile, 0),
    systemLocales: () => delay([...navigator.languages], 0),
    readEq: () => delay({ profile: mockProfile, eq: device, snapshot: null }),
    async applyEq(state, commit) {
      if (state.bands.length > mockProfile.protocol.bands.count)
        throw new Error(`${mockProfile.title} supports at most ${mockProfile.protocol.bands.count} bands`);
      const next = deviceCopy(state);
      const changed = JSON.stringify(next) !== JSON.stringify(device);
      device = next;
      return delay({ profile: mockProfile, changed, committed: commit, backup: changed ? "~/mock-backup.json" : null }, commit ? 1200 : 400);
    },
    exportJson: async (state) => download(EQ_FILE_NAME, state),
    async importJson() {
      const value = await upload<Record<string, unknown>>();
      if (!value) return null;
      return ("eq" in value ? value.eq : value) as WireEqState;
    },

    profiles: () => delay({ items: merge([builtinProfile], userProfiles), issues: [] }, 0),
    async saveProfile(profile) {
      check(profile);
      profile = withDefaults(profile);
      const i = userProfiles.findIndex((p) => p.id === profile.id);
      if (i >= 0) userProfiles[i] = profile;
      else userProfiles.push(profile);
      return delay(`~/mock/profiles/${profile.id}.json`);
    },
    async deleteProfile(id) {
      const i = userProfiles.findIndex((p) => p.id === id);
      if (i < 0) throw new Error(`${id} is not a user profile`);
      userProfiles.splice(i, 1);
    },
    checkProfile: async (profile) => check(profile),
    importProfile: async () => {
      const profile = await upload<Profile>();
      return profile && withDefaults(profile);
    },
    exportProfile: async (profile) => download(`${profile.id}.json`, profile),
    hidDevices: () => {
      const vid = parseHex(builtinProfile.usb.vendor_id) ?? 0;
      const pid = parseHex(builtinProfile.usb.product_id) ?? 0;
      return delay([
        { vendor_id: vid, product_id: pid, usage_page: 0x0c, usage: 1, manufacturer: "Mock", product: builtinProfile.title, profiles: [builtinProfile.id] },
        { vendor_id: vid, product_id: pid + 1, usage_page: 0x0c, usage: 1, manufacturer: "Mock", product: "Unknown DSP model", profiles: [] },
        { vendor_id: 0x1234, product_id: 0x0001, usage_page: 1, usage: 6, manufacturer: "Mock", product: "Keyboard", profiles: [] },
      ]);
    },
    probe: (profile) =>
      delay({
        profile: profile.id,
        eq_switch: profile.protocol.eq_switch
          ? { register: parseHex(profile.protocol.eq_switch.register) ?? 0, value: "(mock)", error: null }
          : null,
        enabled: true,
        bands: Array.from({ length: profile.protocol.bands.count }, (_, i) => {
          const first = (parseHex(profile.protocol.bands.first_register) ?? 0) + i * profile.protocol.bands.stride;
          return {
            registers: Array.from({ length: profile.protocol.bands.registers_per_band ?? 2 }, (_, k) => ({
              register: first + k,
              value: "(mock)",
              error: null,
            })),
            band: device.bands[i] ?? profile.protocol.unused_band,
            error: null,
          };
        }),
        pregain: null,
        ok: true,
        findings: ["Mock probe: every described register answered and decoded."],
      } as ProbeReport),

    presets: () => delay({ items: merge(builtinPresets, userPresets), issues: [] }, 0),
    async savePreset(preset) {
      const i = userPresets.findIndex((p) => p.id === preset.id);
      if (i >= 0) userPresets[i] = preset;
      else userPresets.push(preset);
      return delay(`~/mock/presets/${preset.id}.json`);
    },
    async deletePreset(id) {
      const i = userPresets.findIndex((p) => p.id === id);
      if (i < 0) throw new Error(`${id} is not a user preset`);
      userPresets.splice(i, 1);
    },
    importPreset: () => upload<Preset>(),
    exportPreset: async (preset) => download(`${preset.id}.json`, preset),

    settings: () => delay(info(), 0),
    async setSettings(next) {
      settings = structuredClone(next);
      return delay(info());
    },
    pickFolder: async () => prompt("Folder path (mock)"),
    reveal: async () => undefined,
    confirm: async (message) => window.confirm(message),

    registerRead: async (register) => delay(registers.get(register) ?? "00 00 00 00"),
    async registerWrite(register, value) {
      registers.set(register, value.toUpperCase());
    },
    rawTransact: async (report) => delay(report.toUpperCase()),
    udevRules: async () => {
      const vendors = [...new Set([builtinProfile, ...userProfiles].map((p) => (parseHex(p.usb.vendor_id) ?? 0).toString(16).padStart(4, "0")))];
      return vendors.map((v) => `KERNEL=="hidraw*", ATTRS{idVendor}=="${v}", TAG+="uaccess"`).join("\n");
    },
    pregainRead: () => delay(0),
    pregainWrite: async () => undefined,
    commit: () => delay(undefined, 600),
  };
}

export const api: Api = isTauri() ? tauriApi : mockApi();
