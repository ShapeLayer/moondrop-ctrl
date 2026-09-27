import { DEFAULT_SAMPLE_RATE, freqToUnit, unitToFreq } from "./dsp";
import type { MessageKey } from "./i18n";
import {
  filterTypesOf,
  limitsOf,
  nextColor,
  quantize,
  sameEq,
  sameSettings,
  type Band,
  type Entry,
  type Eq,
  type FilterType,
  type Limits,
  type Preset,
  type Profile,
  type SettingsInfo,
} from "./types";

export type Connection = "unknown" | "connected" | "missing";

/** Stored as a message key so the status bar re-translates when the language changes. */
export interface StatusMessage {
  kind: "info" | "ok" | "error" | "busy";
  key?: MessageKey;
  params?: Record<string, string | number>;
  detail?: string;
}

interface Snapshot {
  eq: Eq;
  presetId: string;
}

/** Consecutive edits with the same key within this window form one undo step. */
const COALESCE_MS = 1000;
const HISTORY_LIMIT = 200;

/** Shown until a device or preset is loaded: EQ on, no bands (the earphone's own tuning). */
export const EMPTY_EQ: Eq = { enabled: true, bands: [] };

/** Band limit before any profile is known: the C ABI's and the core's maximum. */
const MAX_PROFILE_BANDS = 16;

/**
 * Single source of truth for the editor. Components mutate through methods and listen for
 * "change"; `detail` names what changed so the graph can skip work while other state updates.
 */
export class Store extends EventTarget {
  eq: Eq = structuredClone(EMPTY_EQ);
  /** Last EQ known to be on the device (read or applied), for the "unsaved" indicator. */
  deviceEq: Eq | null = null;
  selected = 0;
  connection: Connection = "unknown";
  /** Profile of the connected device, once detected. */
  device: Profile | null = null;
  /** Every known profile (built-in and user). */
  profiles: Entry<Profile>[] = [];
  /** Profile chosen in the settings instead of auto-detection. */
  forcedProfile: string | null = null;
  /** Built-in, user, and snapshot presets. */
  presets: Entry<Preset>[] = [];
  settingsInfo: SettingsInfo | null = null;
  /** Data-folder files that could not be loaded. */
  issues: { path: string; message: string }[] = [];
  busy: string | null = null;
  status: StatusMessage = { kind: "info" };
  presetId = "";

  private past: Snapshot[] = [];
  private future: Snapshot[] = [];
  private lastEdit = { key: "", at: 0 };
  /** The placeholder EQ shown before anything is loaded is never an undo target. */
  private pristine = true;

  private emit(what: "eq" | "selection" | "meta") {
    this.dispatchEvent(new CustomEvent("change", { detail: what }));
  }

  get dirty() {
    return this.deviceEq !== null && !sameSettings(this.eq, this.deviceEq);
  }
  /**
   * The profile the editor is bounded by: the connected device's, else the one chosen in the
   * settings, else the only known profile. Null when that is ambiguous.
   */
  get profile(): Profile | null {
    if (this.device) return this.device;
    const forced = this.profiles.find((p) => p.id === this.forcedProfile);
    if (forced) return forced;
    return this.profiles.length === 1 ? this.profiles[0] : null;
  }
  get limits(): Limits {
    return limitsOf(this.profile);
  }
  get filterTypes(): FilterType[] {
    return filterTypesOf(this.profile);
  }
  /** Whether the EQ can be switched off (the profile has an EQ switch). */
  get canBypass() {
    return !this.profile || this.profile.protocol.eq_switch !== null;
  }
  get sampleRate() {
    return this.profile?.dsp?.sample_rate_hz ?? DEFAULT_SAMPLE_RATE;
  }
  /** Most bands the editor may hold: the active profile's slots, else the largest profile's. */
  get maxBands() {
    if (this.profile) return this.profile.protocol.bands.count;
    return this.profiles.length ? Math.max(...this.profiles.map((p) => p.protocol.bands.count)) : MAX_PROFILE_BANDS;
  }
  get canAddBand() {
    return this.eq.bands.length < this.maxBands;
  }
  get canUndo() {
    return this.past.length > 0;
  }
  get canRedo() {
    return this.future.length > 0;
  }

  /**
   * Every editor change goes through here. `coalesce` names a continuous gesture (a drag, typing
   * into one field, wheel on one point) whose updates collapse into a single undo step.
   */
  private commit(next: Snapshot, coalesce?: string) {
    if (sameEq(next.eq, this.eq) && next.presetId === this.presetId) return;
    const now = performance.now();
    const merge =
      this.pristine || (!!coalesce && coalesce === this.lastEdit.key && now - this.lastEdit.at < COALESCE_MS);
    this.pristine = false;
    if (!merge) {
      this.past.push({ eq: this.eq, presetId: this.presetId });
      if (this.past.length > HISTORY_LIMIT) this.past.shift();
    }
    this.future = [];
    this.lastEdit = { key: coalesce ?? "", at: now };
    this.eq = next.eq;
    this.presetId = next.presetId;
    this.clampSelection();
    this.emit("eq");
  }

  /** Keep the selection on an existing band (0 when there are none). */
  private clampSelection() {
    this.selected = Math.max(0, Math.min(this.selected, this.eq.bands.length - 1));
  }

  setEq(eq: Eq, opts: { fromDevice?: boolean; presetId?: string } = {}) {
    const next = { enabled: eq.enabled, bands: eq.bands.map((b) => quantize(b, this.limits)) };
    if (opts.fromDevice) this.deviceEq = structuredClone(next);
    this.commit({ eq: next, presetId: opts.presetId ?? "" });
    // A device read that matches the editor adds no history but must refresh the sync badge.
    if (opts.fromDevice) this.emit("eq");
  }

  updateBand(index: number, patch: Partial<Band>, coalesce?: string) {
    const bands = this.eq.bands.slice();
    bands[index] = quantize({ ...bands[index], ...patch }, this.limits);
    this.commit({ eq: { ...this.eq, bands }, presetId: "" }, coalesce);
  }

  /**
   * Append a band and select it. Without a position it goes to the middle of the widest gap
   * between existing bands on the log frequency axis, flat, so adding it changes nothing audible.
   */
  addBand(at: Partial<Pick<Band, "freq" | "gain">> = {}) {
    if (!this.canAddBand) return;
    const bands = this.eq.bands;
    const band: Band = {
      gain: at.gain ?? 0,
      freq: at.freq ?? widestGap(bands.map((b) => b.freq)),
      q: 1,
      type: "peaking",
      color: nextColor(bands.map((b) => b.color)),
    };
    this.commit({ eq: { ...this.eq, bands: [...bands, quantize(band, this.limits)] }, presetId: "" });
    this.select(bands.length);
  }

  removeBand(index: number) {
    if (!this.eq.bands[index]) return;
    const bands = this.eq.bands.filter((_, i) => i !== index);
    // Keep the same band selected when an earlier one goes away.
    if (index < this.selected) this.selected--;
    this.commit({ eq: { ...this.eq, bands }, presetId: "" });
    this.emit("selection");
  }

  setEnabled(enabled: boolean) {
    this.commit({ eq: { ...this.eq, enabled }, presetId: this.presetId });
  }

  /** Records what is now on the device (after a successful apply) without touching history. */
  setDeviceEq(eq: Eq) {
    this.deviceEq = structuredClone(eq);
    this.emit("eq");
  }

  /** Marks the end of a gesture so the next edit starts a new undo step. */
  endGesture() {
    this.lastEdit = { key: "", at: 0 };
  }

  undo() {
    this.step(this.past, this.future);
  }
  redo() {
    this.step(this.future, this.past);
  }
  private step(from: Snapshot[], to: Snapshot[]) {
    const target = from.pop();
    if (!target) return;
    to.push({ eq: this.eq, presetId: this.presetId });
    this.eq = target.eq;
    this.presetId = target.presetId;
    this.endGesture();
    this.clampSelection();
    this.emit("eq");
  }

  select(index: number) {
    if (index === this.selected) return;
    this.selected = index;
    this.emit("selection");
  }

  setMeta(patch: Partial<Pick<Store, "connection" | "device" | "profiles" | "forcedProfile" | "presets" | "settingsInfo" | "issues" | "busy" | "status">>) {
    Object.assign(this, patch);
    this.emit("meta");
  }
}

/** Middle of the widest gap between `freqs` and the axis ends, on the log axis. */
function widestGap(freqs: number[]): number {
  const units = [0, ...freqs.map(freqToUnit).sort((a, b) => a - b), 1];
  let best = 0;
  for (let i = 1; i < units.length; i++) if (units[i] - units[i - 1] > units[best + 1] - units[best]) best = i - 1;
  return unitToFreq((units[best] + units[best + 1]) / 2);
}

export const store = new Store();
