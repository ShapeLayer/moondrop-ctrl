import { clamp } from "../types";

/**
 * Compact numeric field: type a value (Enter/blur commits), ArrowUp/Down to step (Shift ×10),
 * or drag horizontally on the label to scrub. `scale="log"` steps multiplicatively (frequency).
 * Emits `value-change` with `detail: number` whenever the value is committed.
 */
export class NumField extends HTMLElement {
  static observedAttributes = ["label", "unit", "tip"];
  private input: HTMLInputElement;
  private labelEl: HTMLElement;
  private unitEl: HTMLElement;
  private current = 0;

  constructor() {
    super();
    const root = this.attachShadow({ mode: "open" });
    root.innerHTML = `
      <style>
        :host, *, *::before, *::after { box-sizing: border-box; }
        :host { display: grid; grid-template-columns: auto 1fr auto; align-items: center; gap: 6px;
          height: 30px; padding: 0 8px; border-radius: var(--radius-sm); background: var(--surface-2);
          border: 1px solid var(--border); transition: border-color .15s, background .15s; }
        :host(:focus-within) { border-color: var(--band-color, var(--accent)); background: var(--surface); }
        label { font-size: 10.5px; font-weight: 600; letter-spacing: .04em; text-transform: uppercase;
          color: var(--muted); cursor: ew-resize; touch-action: none; }
        label:hover { color: var(--text); }
        input { all: unset; min-width: 0; text-align: right; font: 500 13px var(--mono);
          font-variant-numeric: tabular-nums; color: var(--text); cursor: text; user-select: text; -webkit-user-select: text; }
        .unit { font-size: 11px; color: var(--faint); min-width: 1.6em; }
        .unit:empty { display: none; }
      </style>
      <label part="label"></label><input inputmode="decimal" spellcheck="false" /><span class="unit"></span>`;
    this.input = root.querySelector("input")!;
    this.labelEl = root.querySelector("label")!;
    this.unitEl = root.querySelector(".unit")!;

    this.input.addEventListener("keydown", (e) => this.onKey(e));
    this.input.addEventListener("blur", () => this.commitText());
    this.input.addEventListener("focus", () => this.input.select());
    this.labelEl.addEventListener("pointerdown", (e) => this.scrub(e));
  }

  attributeChangedCallback() {
    this.labelEl.textContent = this.getAttribute("label") ?? "";
    this.unitEl.textContent = this.getAttribute("unit") ?? "";
    this.input.setAttribute("aria-label", this.getAttribute("label") ?? "");
    // The scrub gesture on the label is otherwise undiscoverable.
    if (this.hasAttribute("tip")) this.labelEl.dataset.tooltip = this.getAttribute("tip")!;
  }

  private num(name: string, fallback: number) {
    const v = Number(this.getAttribute(name));
    return this.hasAttribute(name) && Number.isFinite(v) ? v : fallback;
  }
  private get min() { return this.num("min", -Infinity); }
  private get max() { return this.num("max", Infinity); }
  private get step() { return this.num("step", 1); }
  private get precision() { return this.num("precision", 0); }
  private get log() { return this.getAttribute("scale") === "log"; }

  get value() {
    return this.current;
  }
  set value(v: number) {
    // Leave text being typed alone unless the value really changed elsewhere (drag, undo).
    if (v === this.current && this.shadowRoot!.activeElement === this.input) return;
    this.current = v;
    this.render();
  }

  private render() {
    const p = this.precision;
    const text = this.current.toFixed(p);
    this.input.value = this.hasAttribute("signed") && this.current > 0 ? `+${text}` : text;
  }

  private commit(v: number) {
    const p = Math.pow(10, this.precision);
    const next = Math.round(clamp(v, this.min, this.max) * p) / p;
    const changed = next !== this.current;
    this.current = next;
    this.render();
    if (changed) this.dispatchEvent(new CustomEvent("value-change", { detail: next, bubbles: true, composed: true }));
  }

  private commitText() {
    const parsed = parseNumber(this.input.value);
    if (parsed === null) this.render();
    else this.commit(parsed);
  }

  private stepBy(direction: number, big: boolean) {
    if (this.log) {
      const factor = Math.pow(2, (big ? 1 / 3 : 1 / 24) * direction);
      this.commit(this.current * factor);
    } else {
      this.commit(this.current + direction * this.step * (big ? 10 : 1));
    }
  }

  private onKey(e: KeyboardEvent) {
    if (e.key === "Enter") {
      this.commitText();
      this.input.select();
    } else if (e.key === "Escape") {
      this.render();
      this.input.blur();
    } else if (e.key === "ArrowUp" || e.key === "ArrowDown") {
      e.preventDefault();
      this.commitText();
      this.stepBy(e.key === "ArrowUp" ? 1 : -1, e.shiftKey);
      this.input.select();
    }
  }

  private scrub(e: PointerEvent) {
    e.preventDefault();
    const start = this.current;
    const x0 = e.clientX;
    this.labelEl.setPointerCapture(e.pointerId);
    const move = (ev: PointerEvent) => {
      const dx = ev.clientX - x0;
      const fine = ev.altKey ? 0.2 : 1;
      this.commit(this.log ? start * Math.pow(2, (dx * fine) / 80) : start + dx * fine * this.step);
    };
    const up = () => {
      this.labelEl.removeEventListener("pointermove", move);
      this.labelEl.removeEventListener("pointerup", up);
      this.labelEl.removeEventListener("pointercancel", up);
    };
    this.labelEl.addEventListener("pointermove", move);
    this.labelEl.addEventListener("pointerup", up);
    this.labelEl.addEventListener("pointercancel", up);
  }
}

/** Accepts "1.5", "+3", "−2" (Unicode minus), and "1.2k" for kilohertz. */
function parseNumber(text: string): number | null {
  const t = text.trim().replace(/−/g, "-").replace(/,/g, "").toLowerCase();
  const m = /^([+-]?\d*\.?\d+)\s*(k)?/.exec(t);
  if (!m) return null;
  const v = Number(m[1]) * (m[2] ? 1000 : 1);
  return Number.isFinite(v) ? v : null;
}

customElements.define("num-field", NumField);
