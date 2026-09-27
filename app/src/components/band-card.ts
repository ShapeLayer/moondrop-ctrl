import { applyI18n, i18n, t, type MessageKey } from "../i18n";
import { decimalsFor, DEFAULT_LIMITS, FILTER_TYPES, hasGain, inkFor, type Band, type FilterType, type Limits } from "../types";
import type { NumField } from "./num-field";
import "./num-field";

/**
 * Editor for one band. Emits `band-patch` ({ index, patch }), `band-select` ({ index }),
 * `band-remove` ({ index }) and `band-color` ({ index, anchor }) to open the color picker.
 * Its horizontal position is owned by <eq-editor>, which aligns it under the band's graph point.
 */
export class BandCard extends HTMLElement {
  index = 0;
  private fields!: { gain: NumField; freq: NumField; q: NumField };
  private typeSelect!: HTMLSelectElement;
  private numberEl!: HTMLButtonElement;
  private removeEl!: HTMLButtonElement;

  constructor() {
    super();
    const root = this.attachShadow({ mode: "open" });
    const options = FILTER_TYPES
      .map((t) => `<option value="${t}" data-i18n="filter.${t}"></option>`)
      .join("");
    root.innerHTML = `
      <style>
        :host, *, *::before, *::after { box-sizing: border-box; }
        :host { display: flex; flex-direction: column; gap: 5px; padding: 8px; border-radius: var(--radius);
          background: var(--surface); border: 1px solid var(--border); box-shadow: 0 1px 0 rgba(0,0,0,.08);
          transition: border-color .15s, box-shadow .15s, opacity .15s; }
        :host([selected]) { border-color: var(--band-color);
          box-shadow: 0 0 0 1px var(--band-color), var(--shadow); }
        :host([muted]) { opacity: .55; }
        header { display: flex; align-items: center; gap: 6px; height: 24px; }
        .n { all: unset; flex: none; width: 20px; height: 20px; border-radius: 50%; display: grid; place-items: center;
          font: 700 11px var(--font); background: var(--band-color); color: var(--band-ink); cursor: pointer;
          transition: box-shadow .12s; }
        .n:hover, .n:focus-visible { box-shadow: 0 0 0 2px var(--surface), 0 0 0 3.5px var(--band-color); }
        .x { all: unset; flex: none; width: 20px; height: 20px; border-radius: 6px; display: grid; place-items: center;
          color: var(--faint); cursor: pointer; transition: color .12s, background .12s; }
        .x:hover { color: var(--danger); background: color-mix(in srgb, var(--danger) 12%, transparent); }
        .x:focus-visible { outline: 1px solid var(--danger); }
        select { all: unset; flex: 1; min-width: 0; height: 24px; padding: 0 20px 0 6px; border-radius: 6px;
          font-size: 12px; font-weight: 500; color: var(--text); cursor: pointer;
          background: var(--surface-2) url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='8' height='5'%3E%3Cpath d='M0 0l4 5 4-5z' fill='%238a93a0'/%3E%3C/svg%3E") no-repeat right 7px center; }
        select:focus-visible { outline: 1px solid var(--band-color); }
        num-field { --band-color: inherit; }
      </style>
      <header>
        <button class="n" data-i18n-tip="tip.color"></button>
        <select data-i18n-aria="band.type" data-i18n-tip="tip.type">${options}</select>
        <button class="x"><svg viewBox="0 0 12 12" width="10" height="10" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" aria-hidden="true"><path d="M2.5 2.5l7 7m0-7-7 7" /></svg></button>
      </header>
      <num-field data-k="gain" data-i18n-label="field.gain" unit="dB" signed precision="1"></num-field>
      <num-field data-k="freq" data-i18n-label="field.freq" unit="Hz" scale="log" precision="0"></num-field>
      <num-field data-k="q" data-i18n-label="field.q" precision="3"></num-field>`;

    const translate = () => {
      applyI18n(root);
      this.labelButtons();
      root.querySelectorAll<HTMLElement>("[data-i18n-label]").forEach((f) => {
        f.setAttribute("label", t(f.dataset.i18nLabel as MessageKey));
        f.setAttribute("tip", t("tip.field"));
      });
    };
    const get = (k: string) => root.querySelector<NumField>(`[data-k=${k}]`)!;
    this.fields = { gain: get("gain"), freq: get("freq"), q: get("q") };
    this.typeSelect = root.querySelector("select")!;
    this.numberEl = root.querySelector(".n")!;
    this.removeEl = root.querySelector(".x")!;
    this.numberEl.addEventListener("click", () =>
      this.emit("band-color", { index: this.index, anchor: this.numberEl.getBoundingClientRect() }),
    );
    this.removeEl.addEventListener("click", () => this.emit("band-remove", { index: this.index }));
    i18n.addEventListener("change", translate);
    this.setProfile(DEFAULT_LIMITS, FILTER_TYPES);
    translate();

    for (const [key, field] of Object.entries(this.fields)) {
      field.addEventListener("value-change", (e) => {
        e.stopPropagation();
        this.patch({ [key]: (e as CustomEvent<number>).detail }, `field-${this.index}-${key}`);
      });
    }
    this.typeSelect.addEventListener("change", () => this.patch({ type: this.typeSelect.value as FilterType }));
    this.addEventListener("focusin", () => this.emitSelect());
    this.addEventListener("pointerdown", () => this.emitSelect());
  }

  private emit(type: string, detail: object) {
    this.dispatchEvent(new CustomEvent(type, { detail, bubbles: true }));
  }
  private patch(patch: Partial<Band>, coalesce?: string) {
    this.emit("band-patch", { index: this.index, patch, coalesce });
  }
  private emitSelect() {
    this.emit("band-select", { index: this.index });
  }
  private labelButtons() {
    const name = t("band.name", { n: this.index + 1 });
    this.numberEl.setAttribute("aria-label", t("band.color", { band: name }));
    this.removeEl.setAttribute("aria-label", t("action.removeBand", { band: name }));
    this.removeEl.dataset.tooltip = t("action.removeBand", { band: name });
  }

  /** Field ranges and filter types of the active device profile. */
  setProfile(limits: Limits, types: FilterType[]) {
    const ranges = { gain: limits.gain, freq: limits.freq, q: limits.q };
    for (const [key, range] of Object.entries(ranges) as [keyof typeof ranges, Limits["gain"]][]) {
      this.fields[key].setAttribute("min", String(range.min));
      this.fields[key].setAttribute("max", String(range.max));
    }
    // Arrow keys step by the device's resolution (at least 0.1 dB / 0.01 Q), and fields show
    // as many decimals as that resolution has.
    this.fields.gain.setAttribute("step", String(Math.max(0.1, limits.gainStep)));
    this.fields.q.setAttribute("step", String(Math.max(0.01, limits.qStep)));
    this.fields.gain.setAttribute("precision", String(Math.max(1, decimalsFor(limits.gainStep))));
    this.fields.freq.setAttribute("precision", String(decimalsFor(limits.freqStep)));
    this.fields.q.setAttribute("precision", String(Math.max(3, decimalsFor(limits.qStep))));
    for (const option of this.typeSelect.options) option.hidden = option.disabled = !types.includes(option.value as FilterType);
  }

  update(index: number, band: Band) {
    if (index !== this.index || !this.numberEl.textContent) {
      this.index = index;
      this.numberEl.textContent = String(index + 1);
      this.labelButtons();
    }
    this.style.setProperty("--band-color", band.color);
    this.style.setProperty("--band-ink", inkFor(band.color));
    this.fields.gain.value = band.gain;
    this.fields.freq.value = band.freq;
    this.fields.q.value = band.q;
    if (this.typeSelect.value !== band.type) this.typeSelect.value = band.type;
    // Pass, band-pass and notch filters have no gain.
    this.fields.gain.toggleAttribute("inert", !hasGain(band.type));
    this.fields.gain.style.opacity = hasGain(band.type) ? "" : "0.4";
  }
}

customElements.define("band-card", BandCard);
