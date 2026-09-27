import type { Band } from "./types";

/**
 * RBJ audio-EQ-cookbook biquads evaluated at the profile's sample rate (48 kHz unless it says
 * otherwise). This is a model of the device response for display, not a measurement.
 */
export const DEFAULT_SAMPLE_RATE = 48000;

type Coeffs = [b0: number, b1: number, b2: number, a0: number, a1: number, a2: number];

function coefficients(band: Band, FS: number): Coeffs {
  const A = Math.pow(10, band.gain / 40);
  const w0 = (2 * Math.PI * Math.min(band.freq, FS / 2 - 1)) / FS;
  const cos = Math.cos(w0);
  const alpha = Math.sin(w0) / (2 * band.q);
  switch (band.type) {
    case "peaking":
      return [1 + alpha * A, -2 * cos, 1 - alpha * A, 1 + alpha / A, -2 * cos, 1 - alpha / A];
    case "low_shelf": {
      const s = 2 * Math.sqrt(A) * alpha;
      return [
        A * (A + 1 - (A - 1) * cos + s),
        2 * A * (A - 1 - (A + 1) * cos),
        A * (A + 1 - (A - 1) * cos - s),
        A + 1 + (A - 1) * cos + s,
        -2 * (A - 1 + (A + 1) * cos),
        A + 1 + (A - 1) * cos - s,
      ];
    }
    case "high_shelf": {
      const s = 2 * Math.sqrt(A) * alpha;
      return [
        A * (A + 1 + (A - 1) * cos + s),
        -2 * A * (A - 1 + (A + 1) * cos),
        A * (A + 1 + (A - 1) * cos - s),
        A + 1 - (A - 1) * cos + s,
        2 * (A - 1 - (A + 1) * cos),
        A + 1 - (A - 1) * cos - s,
      ];
    }
    case "low_pass":
      return [(1 - cos) / 2, 1 - cos, (1 - cos) / 2, 1 + alpha, -2 * cos, 1 - alpha];
    case "high_pass":
      return [(1 + cos) / 2, -(1 + cos), (1 + cos) / 2, 1 + alpha, -2 * cos, 1 - alpha];
    case "band_pass":
      return [alpha, 0, -alpha, 1 + alpha, -2 * cos, 1 - alpha];
    case "notch":
      return [1, -2 * cos, 1, 1 + alpha, -2 * cos, 1 - alpha];
  }
}

function magnitudeDb([b0, b1, b2, a0, a1, a2]: Coeffs, freq: number, FS: number): number {
  const w = (2 * Math.PI * freq) / FS;
  const c1 = Math.cos(w);
  const c2 = Math.cos(2 * w);
  const num = b0 * b0 + b1 * b1 + b2 * b2 + 2 * (b0 * b1 + b1 * b2) * c1 + 2 * b0 * b2 * c2;
  const den = a0 * a0 + a1 * a1 + a2 * a2 + 2 * (a0 * a1 + a1 * a2) * c1 + 2 * a0 * a2 * c2;
  return 10 * Math.log10(Math.max(num / den, 1e-12));
}

/** Response in dB of each band and of their sum, sampled at `freqs`. */
export function response(
  bands: Band[],
  freqs: number[],
  sampleRate = DEFAULT_SAMPLE_RATE,
): { total: number[]; perBand: number[][] } {
  const perBand = bands.map((band) => {
    const c = coefficients(band, sampleRate);
    return freqs.map((f) => magnitudeDb(c, f, sampleRate));
  });
  const total = freqs.map((_, i) => perBand.reduce((sum, curve) => sum + curve[i], 0));
  return { total, perBand };
}

export const F_MIN = 20;
export const F_MAX = 20000;
const LOG_SPAN = Math.log10(F_MAX / F_MIN);

/** 0..1 position of a frequency on the log axis, and its inverse. */
export const freqToUnit = (f: number) => Math.log10(f / F_MIN) / LOG_SPAN;
export const unitToFreq = (u: number) => F_MIN * Math.pow(10, u * LOG_SPAN);

export function logSweep(points: number): number[] {
  return Array.from({ length: points }, (_, i) => unitToFreq(i / (points - 1)));
}

export function formatFreq(f: number): string {
  if (f >= 1000) {
    const k = f / 1000;
    return `${k >= 10 ? k.toFixed(k % 1 < 0.05 ? 0 : 1) : k.toFixed(k % 1 < 0.005 ? 0 : 2)}k`;
  }
  return `${Math.round(f)}`;
}
