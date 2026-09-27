/** Wire format shared with moondrop-core (serde). Natural units; the device's resolution comes from the profile. */
export type FilterType = "peaking" | "low_shelf" | "high_shelf" | "low_pass" | "high_pass" | "band_pass" | "notch";

export interface WireBand {
  gain_db: number;
  frequency_hz: number;
  q: number;
  filter_type: FilterType;
  /** `#rrggbb`. Only presets and JSON files carry colors; the device ignores them. */
  color?: string;
}

export interface WireEqState {
  /** Custom EQ on; off bypasses it. */
  enabled: boolean;
  bands: WireBand[];
}

/** One value inside a band's bytes: wire value = natural value / step. */
export interface EncodedField {
  offset: number;
  size: number;
  step: number;
  signed: boolean;
}

/** Hex strings such as "0x31B2" (the core also accepts plain numbers). */
export type Hex = string;
export interface Range {
  min: number;
  max: number;
}

/** Device profile (schemas/profile.schema.json). */
export interface Profile {
  id: string;
  title: string;
  notes: string;
  /** Writes, readback and commit confirmed on real hardware. */
  verified: boolean;
  usb: { vendor_id: Hex; product_id: Hex; usage_page?: Hex | null; usage?: Hex | null };
  protocol: {
    report_id: Hex;
    frame: {
      length: number;
      register_offset: number;
      command_offset: number;
      value_offset: number;
      value_length: number;
      echo_length: number;
    };
    read_command: Hex;
    write_command: Hex;
    commit_command: Hex | null;
    commit_register: Hex;
    /** null: the device has no EQ on/off switch (always on). */
    eq_switch: { register: Hex; read_argument: Hex[]; on: Hex; off: Hex } | null;
    bands: { count: number; first_register: Hex; stride: number; registers_per_band: number };
    band_encoding: {
      byte_order: "little" | "big";
      gain: EncodedField;
      frequency: EncodedField;
      q: EncodedField;
      filter: EncodedField;
    };
    filter_codes: Partial<Record<FilterType, Hex | null>>;
    unused_band: Omit<WireBand, "color">;
    pregain_register: Hex | null;
    timing: { response_timeout_ms: number; reconnect_timeout_ms: number };
  };
  limits: { gain_db: Range; frequency_hz: Range; q: Range };
  /** Display model only. */
  dsp: { sample_rate_hz: number };
}

export type Source = "builtin" | "user" | "snapshot";
export type Entry<T> = T & { source: Source; path: string | null; overrides_builtin: boolean };
export interface Listing<T> {
  items: Entry<T>[];
  issues: { path: string; message: string }[];
}

export interface Preset {
  id: string;
  title: string;
  note: string;
  /** Profile IDs it is meant for; empty = any device it fits. */
  profiles: string[];
  eq: WireEqState;
}

export interface ReadReport {
  profile: Profile;
  eq: WireEqState;
  /** Path of the original snapshot this read created, if any. */
  snapshot: string | null;
}

export interface ApplyReport {
  profile: Profile;
  changed: boolean;
  committed: boolean;
  backup: string | null;
}

export interface Settings {
  profile: string | null;
  backup_dir: string | null;
  capture_original: boolean;
}
export interface SettingsInfo {
  settings: Settings;
  home: string;
  backup_dir: string;
  default_backup_dir: string;
}

export interface HidDevice {
  vendor_id: number;
  product_id: number;
  usage_page: number;
  usage: number;
  manufacturer: string;
  product: string;
  /** IDs of profiles matching this interface. */
  profiles: string[];
}

export interface RegisterRead {
  register: number;
  value: string | null;
  error: string | null;
}
export interface ProbeReport {
  profile: string;
  eq_switch: RegisterRead | null;
  enabled: boolean | null;
  bands: { registers: RegisterRead[]; band: Omit<WireBand, "color"> | null; error: string | null }[];
  pregain: RegisterRead | null;
  ok: boolean;
  findings: string[];
}

/**
 * Fills the optional profile sections with the core's defaults (the CHU II DSP layout), as the
 * Rust side does when it reads a profile file. Use it on profiles that did not come from Rust,
 * such as one pasted from an AI reply.
 */
const fill = <T extends object>(defaults: T, given: Partial<T> | undefined): T => ({ ...defaults, ...given });
export function withDefaults(p: Profile): Profile {
  const q = structuredClone(p);
  const proto = q.protocol ?? ({} as Profile["protocol"]);
  proto.frame = fill(
    { length: 11, register_offset: 1, command_offset: 5, value_offset: 7, value_length: 4, echo_length: 7 },
    proto.frame,
  );
  if (proto.bands) proto.bands.registers_per_band ??= 2;
  proto.commit_register ??= "0x00";
  proto.commit_command ??= null;
  proto.pregain_register ??= null;
  proto.eq_switch = proto.eq_switch
    ? { ...proto.eq_switch, read_argument: proto.eq_switch.read_argument ?? [] }
    : null;
  const field = (offset: number, size: number, step: number, signed: boolean): EncodedField => ({ offset, size, step, signed });
  const enc = proto.band_encoding ?? ({} as Partial<Profile["protocol"]["band_encoding"]>);
  proto.band_encoding = {
    byte_order: enc.byte_order ?? "little",
    gain: fill(field(0, 2, 0.1, true), enc.gain),
    frequency: fill(field(2, 2, 1, false), enc.frequency),
    q: fill(field(4, 2, 0.001, false), enc.q),
    filter: fill(field(6, 1, 1, false), enc.filter),
  };
  if (proto.unused_band) proto.unused_band = normalizeBand(proto.unused_band);
  proto.timing = fill({ response_timeout_ms: 1000, reconnect_timeout_ms: 5000 }, proto.timing);
  q.protocol = proto;
  q.dsp = fill({ sample_rate_hz: 48000 }, q.dsp);
  q.notes ??= "";
  q.verified ??= false;
  return q;
}

/** A band in natural units; also accepts the fixed-point fields of 0.2 files. */
export function normalizeBand<T extends Partial<WireBand> & { gain_tenths_db?: number; q_thousandths?: number }>(b: T): T & WireBand {
  const { gain_tenths_db, q_thousandths, ...rest } = b;
  return {
    ...rest,
    gain_db: b.gain_db ?? (gain_tenths_db !== undefined ? gain_tenths_db / 10 : NaN),
    q: b.q ?? (q_thousandths !== undefined ? q_thousandths / 1000 : NaN),
  } as T & WireBand;
}

export const parseHex = (v: Hex | number | null | undefined): number | null => {
  if (v === null || v === undefined || v === "") return null;
  if (typeof v === "number") return v;
  const s = v.trim();
  const n = /^0x/i.test(s) ? parseInt(s.slice(2), 16) : Number(s);
  return Number.isFinite(n) ? n : null;
};
export const hex = (n: number, width = 2) => "0x" + n.toString(16).toUpperCase().padStart(width, "0");
export const usbId = (p: Profile) =>
  `${(parseHex(p.usb.vendor_id) ?? 0).toString(16).toUpperCase().padStart(4, "0")}:${(parseHex(p.usb.product_id) ?? 0)
    .toString(16)
    .toUpperCase()
    .padStart(4, "0")}`;

/** Editor model in natural units. */
export interface Band {
  gain: number;
  freq: number;
  q: number;
  type: FilterType;
  /** Display color, `#rrggbb`. */
  color: string;
}

export interface Eq {
  enabled: boolean;
  bands: Band[];
}

/**
 * Default band colors, picked in order for bands without one. Mid-tones so they read on both
 * the light and the dark theme.
 */
export const PALETTE = [
  "#f25f4c", "#e8a317", "#2fb872", "#3d8fef", "#9b6cf0",
  "#e0569c", "#1fb5b5", "#8fb82e", "#f08a24", "#6f7ff5",
] as const;

/** First palette color not used by `taken`, cycling once every color is in use. */
export function nextColor(taken: readonly string[]): string {
  const used = new Set(taken.map((c) => c.toLowerCase()));
  return PALETTE.find((c) => !used.has(c)) ?? PALETTE[taken.length % PALETTE.length];
}

export const isColor = (c: unknown): c is string => typeof c === "string" && /^#[0-9a-f]{6}$/i.test(c);

/** Dark or light text, whichever reads better on `color`. */
export function inkFor(color: string): string {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(color.slice(i, i + 2), 16) / 255);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b > 0.45 ? "#111" : "#fff";
}
export interface Limits {
  gain: Range;
  freq: Range;
  q: Range;
  /** Device resolution. */
  gainStep: number;
  freqStep: number;
  qStep: number;
}
/** Used while no profile is known: the widest ranges the editor can express. */
export const DEFAULT_LIMITS: Limits = {
  gain: { min: -24, max: 24 },
  freq: { min: 20, max: 20000 },
  q: { min: 0.1, max: 20 },
  gainStep: 0.1,
  freqStep: 1,
  qStep: 0.001,
};
export const limitsOf = (p: Profile | null): Limits =>
  p
    ? {
        gain: p.limits.gain_db,
        freq: p.limits.frequency_hz,
        q: p.limits.q,
        gainStep: p.protocol.band_encoding?.gain?.step ?? 0.1,
        freqStep: p.protocol.band_encoding?.frequency?.step ?? 1,
        qStep: p.protocol.band_encoding?.q?.step ?? 0.001,
      }
    : DEFAULT_LIMITS;
/** Decimal places that show a value in `step`s exactly (at most 6). */
export const decimalsFor = (step: number) => {
  for (let d = 0; d < 6; d++) if (Math.abs(Math.round(step * 10 ** d) - step * 10 ** d) < 1e-9) return d;
  return 6;
};

export const FILTER_TYPES: FilterType[] = ["peaking", "low_shelf", "high_shelf", "low_pass", "high_pass", "band_pass", "notch"];
export const filterTypesOf = (p: Profile | null): FilterType[] =>
  p ? FILTER_TYPES.filter((t) => parseHex(p.protocol.filter_codes[t]) !== null) : FILTER_TYPES;
/** Whether the gain value changes this filter's response. */
export const hasGain = (t: FilterType) => t === "peaking" || t === "low_shelf" || t === "high_shelf";

export const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
/** Round to a multiple of `step`, then to 6 decimals like the core's canonical values. */
const snap = (v: number, step: number) => Math.round(Math.round(v / step) * step * 1e6) / 1e6;

/** Round to the device's resolution so the editor never shows unsendable values. */
export function quantize(band: Band, limits: Limits = DEFAULT_LIMITS): Band {
  return {
    type: band.type,
    color: band.color.toLowerCase(),
    gain: snap(clamp(band.gain, limits.gain.min, limits.gain.max), limits.gainStep),
    freq: snap(clamp(band.freq, limits.freq.min, limits.freq.max), limits.freqStep),
    q: snap(clamp(band.q, limits.q.min, limits.q.max), limits.qStep),
  };
}

/**
 * Bands without a color (device reads, plain JSON) take `inherit[i]` when given, e.g. the
 * editor's colors so a device read keeps them, and otherwise the next unused palette color.
 */
export function fromWire(state: WireEqState, inherit: readonly string[] = []): Eq {
  const colors: string[] = [];
  state.bands.forEach((b, i) => colors.push(isColor(b.color) ? b.color.toLowerCase() : (inherit[i] ?? "")));
  colors.forEach((c, i) => (colors[i] = c || nextColor(colors.filter(Boolean))));
  return {
    enabled: state.enabled,
    bands: state.bands.map(normalizeBand).map((b, i) => ({
      gain: b.gain_db,
      freq: b.frequency_hz,
      q: b.q,
      type: b.filter_type,
      color: colors[i],
    })),
  };
}

export function toWire(eq: Eq): WireEqState {
  return {
    enabled: eq.enabled,
    bands: eq.bands.map((b) => ({
      gain_db: b.gain,
      frequency_hz: b.freq,
      q: b.q,
      filter_type: b.type,
      color: b.color,
    })),
  };
}

/** Same editor state, colors included. */
export const sameEq = (a: Eq | null, b: Eq | null) =>
  !!a && !!b && JSON.stringify(toWire(a)) === JSON.stringify(toWire(b));

/** Same device settings: colors never reach the device, so they are ignored. */
export function sameSettings(a: Eq | null, b: Eq | null) {
  const plain = (eq: Eq) => JSON.stringify(toWire(eq).bands.map(({ color: _, ...band }) => band)) + eq.enabled;
  return !!a && !!b && plain(a) === plain(b);
}
