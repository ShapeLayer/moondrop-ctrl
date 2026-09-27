/** Loads profiles, presets and settings from the data folder into the store. */
import { api } from "./api";
import { t, tMaybe } from "./i18n";
import { store } from "./store";
import type { Preset, Profile, WireEqState } from "./types";
import { filterTypesOf, limitsOf, normalizeBand } from "./types";

export async function refreshCatalog() {
  const [profiles, presets, info] = await Promise.all([
    api.profiles(),
    api.presets(),
    api.settings().catch((e) => {
      store.setMeta({ status: { kind: "error", key: "status.error", params: { message: String(e) } } });
      return null;
    }),
  ]);
  store.setMeta({
    profiles: profiles.items,
    presets: presets.items,
    settingsInfo: info,
    forcedProfile: info?.settings.profile ?? null,
    issues: [...profiles.issues, ...presets.issues],
  });
}

const SNAPSHOT_PREFIX = "original-";

/** Built-in presets have translated titles; snapshots are named after their device. */
export function presetTitle(p: Preset): string {
  if (p.id.startsWith(SNAPSHOT_PREFIX)) {
    const id = p.id.slice(SNAPSHOT_PREFIX.length);
    const device = store.profiles.find((x) => x.id === id)?.title ?? id;
    return t("preset.original.title", { device });
  }
  return tMaybe(`preset.${p.id}.title`, p.title);
}
export function presetNote(p: Preset): string {
  if (p.id.startsWith(SNAPSHOT_PREFIX)) return p.note;
  return tMaybe(`preset.${p.id}.note`, p.note);
}

/** Whether `p` is meant for `profile` (or for any device). */
export const presetFor = (p: Preset, profile: Profile | null) =>
  !profile || p.profiles.length === 0 || p.profiles.includes(profile.id);

/** Why `eq` cannot be sent to a device with `profile`; empty when it can. */
export function eqProblems(eq: WireEqState, profile: Profile | null): string[] {
  const problems: string[] = [];
  const max = profile?.protocol.bands.count ?? 16;
  if (!Array.isArray(eq.bands)) return [t("check.bands")];
  if (eq.bands.length > max) problems.push(t("check.count", { max, count: eq.bands.length }));
  const l = limitsOf(profile);
  const types = filterTypesOf(profile);
  eq.bands.map(normalizeBand).forEach((b, i) => {
    const n = i + 1;
    const gain = b.gain_db;
    const q = b.q;
    if (![gain, b.frequency_hz, q].every(Number.isFinite)) problems.push(t("check.integer", { n }));
    if (gain < l.gain.min || gain > l.gain.max) problems.push(t("check.gain", { n, value: gain, min: l.gain.min, max: l.gain.max }));
    if (b.frequency_hz < l.freq.min || b.frequency_hz > l.freq.max)
      problems.push(t("check.freq", { n, value: b.frequency_hz, min: l.freq.min, max: l.freq.max }));
    if (q < l.q.min || q > l.q.max) problems.push(t("check.q", { n, value: q, min: l.q.min, max: l.q.max }));
    if (!types.includes(b.filter_type)) problems.push(t("check.type", { n, type: String(b.filter_type) }));
  });
  return problems;
}
