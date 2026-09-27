/**
 * AI assistant prompts. The templates are the Markdown files in docs/ai/ (also usable by hand);
 * this fills their {{PLACEHOLDERS}} from the app's state and reads JSON back out of a reply.
 */
import deviceProfileTemplate from "../../docs/ai/device-profile.md?raw";
import eqPresetTemplate from "../../docs/ai/eq-preset.md?raw";
import troubleshootTemplate from "../../docs/ai/troubleshoot.md?raw";
import profileSchema from "../../schemas/profile.schema.json?raw";
import pkg from "../package.json";
import { filterTypesOf, hex, limitsOf, normalizeBand, type HidDevice, type Preset, type ProbeReport, type Profile, type WireEqState } from "./types";

export type AiTask = "eq" | "profile" | "troubleshoot";
const TEMPLATES: Record<AiTask, string> = {
  eq: eqPresetTemplate,
  profile: deviceProfileTemplate,
  troubleshoot: troubleshootTemplate,
};

/** Context the user chose to include; null means "not included". */
export interface AiContext {
  goal: string;
  language: string;
  profile: Profile | null;
  eq: WireEqState | null;
  hid: HidDevice[] | null;
  probe: ProbeReport | null;
  settings: object | null;
  connection: string;
  status: string;
}

const NOT_INCLUDED = "(not included)";
const json = (v: unknown) => JSON.stringify(v, null, 2);
const id16 = (n: number) => n.toString(16).toUpperCase().padStart(4, "0");

function hidTable(list: HidDevice[]): string {
  if (!list.length) return "(no HID devices found)";
  const rows = list.map(
    (d) =>
      `| ${id16(d.vendor_id)}:${id16(d.product_id)} | ${id16(d.usage_page)}:${id16(d.usage)} | ${d.manufacturer || "-"} | ${d.product || "-"} | ${d.profiles.join(", ") || "-"} |`,
  );
  return ["| VID:PID | Usage page:usage | Manufacturer | Product | Matching profiles |", "| --- | --- | --- | --- | --- |", ...rows].join("\n");
}

function probeText(report: ProbeReport): string {
  const reg = (r: { register: number; value: string | null; error: string | null }) =>
    `${hex(r.register)} = ${r.value ?? `error: ${r.error}`}`;
  const lines = [
    `Profile: ${report.profile} · all registers decoded: ${report.ok ? "yes" : "no"}`,
    report.eq_switch
      ? `EQ switch: ${reg(report.eq_switch)} → ${report.enabled === null ? "not decodable" : report.enabled ? "on" : "off"}`
      : "EQ switch: none in this profile (always on)",
    ...report.bands.map(
      (b, i) =>
        `Band ${i + 1}: ${b.registers.map(reg).join(", ")} → ${b.band ? JSON.stringify(b.band) : `error: ${b.error}`}`,
    ),
    ...(report.pregain ? [`Pregain: ${reg(report.pregain)}`] : []),
    "Findings:",
    ...report.findings.map((f) => `- ${f}`),
  ];
  return "```text\n" + lines.join("\n") + "\n```";
}

function profileSummary(p: Profile): string {
  const l = limitsOf(p);
  return [
    `- Model: ${p.title} (profile \`${p.id}\`, ${p.verified ? "verified on hardware" : "NOT verified on hardware"})`,
    `- Bands: up to ${p.protocol.bands.count}`,
    `- Filter types: ${filterTypesOf(p).join(", ")}`,
    `- Gain ${l.gain.min} to ${l.gain.max} dB in ${l.gainStep} dB steps, frequency ${l.freq.min} to ${l.freq.max} Hz in ${l.freqStep} Hz steps, Q ${l.q.min} to ${l.q.max} in ${l.qStep} steps`,
    `- EQ on/off switch: ${p.protocol.eq_switch ? "yes" : "no (the EQ is always on; keep \"enabled\": true)"}`,
    `- Response model sample rate: ${p.dsp?.sample_rate_hz ?? 48000} Hz`,
    ...(p.notes ? [`- Notes: ${p.notes}`] : []),
  ].join("\n");
}

export function buildPrompt(task: AiTask, ctx: AiContext): string {
  const p = ctx.profile;
  const l = limitsOf(p);
  const values: Record<string, string> = {
    GOAL: ctx.goal.trim() || "(The user did not describe a goal. Ask what they want before proposing changes.)",
    LANGUAGE: ctx.language,
    PROFILE_ID: p?.id ?? "PROFILE_ID",
    PROFILE_JSON: p ? json(p) : NOT_INCLUDED,
    PROFILE_SUMMARY: p ? profileSummary(p) : "(No device profile is active; assume the limits below.)",
    BAND_COUNT: String(p?.protocol.bands.count ?? 16),
    FILTER_TYPES: filterTypesOf(p).join(", "),
    GAIN_RANGE: `${l.gain.min} to ${l.gain.max}`,
    FREQ_RANGE: `${l.freq.min} to ${l.freq.max}`,
    Q_RANGE: `${l.q.min} to ${l.q.max}`,
    GAIN_STEP: String(l.gainStep),
    Q_STEP: String(l.qStep),
    FREQ_STEP: String(l.freqStep),
    EQ_JSON: ctx.eq ? json(ctx.eq) : NOT_INCLUDED,
    HID_DEVICES: ctx.hid ? hidTable(ctx.hid) : NOT_INCLUDED,
    PROBE: ctx.probe ? probeText(ctx.probe) : "(No probe has been run yet.)",
    PROFILE_SCHEMA: profileSchema.trim(),
    APP_VERSION: pkg.version,
    PLATFORM: navigator.userAgent,
    CONNECTION: ctx.connection,
    STATUS: ctx.status || "(none)",
    SETTINGS: ctx.settings ? "`" + JSON.stringify(ctx.settings) + "`" : NOT_INCLUDED,
  };
  return TEMPLATES[task].replace(/\{\{([A-Z_]+)\}\}/g, (all, key: string) => values[key] ?? all);
}

export type AiResult =
  | { kind: "profile"; profile: Profile }
  | { kind: "preset"; preset: Preset }
  | { kind: "eq"; eq: WireEqState };

/** JSON candidates in a reply: fenced blocks first, then the outermost {...} span. */
function candidates(text: string): string[] {
  const fenced = [...text.matchAll(/```(?:json|JSON)?\s*\n([\s\S]*?)```/g)].map((m) => m[1]);
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  return start >= 0 && end > start ? [...fenced, text.slice(start, end + 1)] : fenced;
}

/** The first JSON object in an AI reply that looks like a profile, a preset, or an EQ. */
export function parseReply(text: string): AiResult {
  for (const candidate of candidates(text)) {
    let value: unknown;
    try {
      value = JSON.parse(candidate);
    } catch {
      continue;
    }
    if (!value || typeof value !== "object") continue;
    const v = value as Record<string, unknown>;
    if (v.usb && v.protocol) return { kind: "profile", profile: v as unknown as Profile };
    if (v.eq && typeof v.eq === "object") {
      const preset = v as unknown as Preset;
      return { kind: "preset", preset: { ...preset, eq: { ...preset.eq, bands: (preset.eq.bands ?? []).map(normalizeBand) } } };
    }
    if (Array.isArray(v.bands)) {
      // 0.2 files use slot 3/2 instead of enabled.
      const enabled = typeof v.enabled === "boolean" ? v.enabled : v.slot !== 2;
      return { kind: "eq", eq: { enabled, bands: (v.bands as WireEqState["bands"]).map(normalizeBand) } };
    }
  }
  throw new Error("no profile, preset, or EQ JSON found in the reply");
}
