import { F_MAX, F_MIN, formatFreq, freqToUnit, logSweep, response, unitToFreq } from "../dsp";
import { applyI18n, i18n, t } from "../i18n";
import { store } from "../store";
import { clamp, inkFor, PALETTE, type Band } from "../types";
import { BandCard } from "./band-card";

const SVG = "http://www.w3.org/2000/svg";
const MARGIN = { left: 42, right: 18, top: 16, bottom: 26 };
const LEADER_HEIGHT = 30;
const CARD_GAP = 8;
const CARD_MAX = 176;
/** Narrowest card; below this the lane scrolls sideways instead. */
const CARD_MIN = 132;
const SAMPLES = 480;
const SWEEP = logSweep(SAMPLES);
const MAJOR_FREQS = [20, 50, 100, 200, 500, 1000, 2000, 5000, 10000, 20000];
const MINOR_FREQS = [30, 40, 60, 70, 80, 90, 300, 400, 600, 700, 800, 900, 3000, 4000, 6000, 7000, 8000, 9000];

const el = <K extends keyof SVGElementTagNameMap>(tag: K, attrs: Record<string, string | number> = {}) => {
  const node = document.createElementNS(SVG, tag);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, String(v));
  return node;
};

/**
 * Graph + per-band editors. Each band is a draggable point on the modelled response curve
 * (x: frequency, y: gain, wheel: Q). The band's edit card sits in the lane below, centred on the
 * point's x position where space allows, joined to it by a leader line. Bands can be added
 * (toolbar, or double-click an empty spot on the graph) up to the device's slot count, and removed.
 */
export class EqEditor extends HTMLElement {
  private plot!: SVGSVGElement;
  private grid!: SVGGElement;
  private totalFill!: SVGPathElement;
  private totalPath!: SVGPathElement;
  private bandFill!: SVGPathElement;
  private curvesG!: SVGGElement;
  private stemsG!: SVGGElement;
  private handlesG!: SVGGElement;
  private bandPaths: SVGPathElement[] = [];
  private stems: SVGLineElement[] = [];
  private handles: SVGGElement[] = [];
  private leaders!: SVGSVGElement;
  private leaderPaths: SVGPathElement[] = [];
  private cards: BandCard[] = [];
  private readout!: HTMLElement;
  private lanes!: HTMLElement;
  private track!: HTMLElement;
  private palette!: HTMLElement;
  private customColor!: HTMLInputElement;
  /** Band whose color picker is open. */
  private coloring: number | null = null;

  private width = 0;
  private height = 0;
  private yMin = -12;
  private yMax = 12;
  private dragging: number | null = null;
  private gestures = 0;

  constructor() {
    super();
    const root = this.attachShadow({ mode: "open" });
    root.innerHTML = `
      <style>
        :host, *, *::before, *::after { box-sizing: border-box; }
        :host { display: flex; flex-direction: column; min-height: 0; position: relative; }
        .graph { position: relative; flex: 1; min-height: 240px; border-radius: 14px; overflow: hidden;
          background:
            radial-gradient(120% 90% at 50% 0%, color-mix(in srgb, var(--accent) 5%, transparent), transparent 60%),
            var(--surface);
          border: 1px solid var(--border); }
        svg.plot { position: absolute; inset: 0; width: 100%; height: 100%; display: block; }
        .grid line { stroke: var(--grid); shape-rendering: crispEdges; }
        .grid line.major { stroke: var(--grid-strong); }
        .grid line.zero { stroke: var(--border-strong); }
        .grid text { fill: var(--faint); font: 10px var(--font); font-variant-numeric: tabular-nums; }
        .grid text.y { text-anchor: end; dominant-baseline: middle; }
        .grid text.x { text-anchor: middle; }
        .band-curve { fill: none; stroke: var(--c); stroke-width: 1.25; opacity: .38; transition: opacity .15s; }
        .band-curve.selected { opacity: .9; stroke-width: 1.5; }
        .band-fill { fill: var(--c); opacity: .12; }
        .total-fill { fill: var(--curve); opacity: .05; }
        .total { fill: none; stroke: var(--curve); stroke-width: 2.25; stroke-linejoin: round; stroke-linecap: round;
          filter: drop-shadow(0 1px 6px color-mix(in srgb, var(--curve) 25%, transparent)); }
        :host([bypassed]) .total { stroke-dasharray: 5 5; opacity: .5; filter: none; }
        :host([bypassed]) .total-fill, :host([bypassed]) .band-fill { opacity: 0; }
        .stem { stroke: var(--c); stroke-width: 1; stroke-dasharray: 2 3; opacity: .35; }
        .stem.selected { opacity: .8; }
        .handle { cursor: grab; outline: none; }
        .handle:active { cursor: grabbing; }
        .handle .hit { fill: transparent; }
        .handle .ring { fill: none; stroke: var(--c); stroke-width: 2; opacity: 0; transition: opacity .15s; }
        .handle .dot { fill: var(--c); stroke: var(--surface); stroke-width: 2;
          transition: r .12s; }
        .handle text { fill: var(--ink, #111); font: 700 10px var(--font); text-anchor: middle; dominant-baseline: central;
          pointer-events: none; }
        .handle:hover .dot, .handle.selected .dot { r: 10; }
        .handle.selected .ring, .handle:focus-visible .ring { opacity: .45; }
        .readout { position: absolute; pointer-events: none; padding: 4px 8px; border-radius: 6px;
          background: var(--surface-3); border: 1px solid var(--border-strong); box-shadow: var(--shadow);
          font: 500 11px var(--mono); white-space: nowrap; color: var(--text); opacity: 0; transform: translate(-50%, -100%);
          transition: opacity .1s; }
        .readout.show { opacity: 1; }
        .bypass { position: absolute; top: 12px; left: 50%; transform: translateX(-50%); padding: 4px 10px;
          border-radius: 99px; font-size: 11px; font-weight: 600; color: var(--warn);
          background: color-mix(in srgb, var(--warn) 14%, transparent); display: none; }
        :host([bypassed]) .bypass { display: block; }
        svg.leaders { display: block; width: 100%; height: ${LEADER_HEIGHT}px; overflow: hidden; }
        .leader { fill: none; stroke: var(--c); stroke-width: 1.25; opacity: .45; transition: opacity .15s; }
        .leader.selected { opacity: 1; stroke-width: 1.75; }
        .anchor { fill: var(--c); }
        .lanes { position: relative; height: 150px; overflow-x: auto; overflow-y: hidden; scrollbar-width: thin; }
        .track { position: relative; height: 100%; min-width: 100%; }
        band-card { position: absolute; top: 0; left: 0; }
        .empty { position: absolute; inset: 0 0 auto; padding-top: 28px; text-align: center; font-size: 12px;
          color: var(--faint); display: none; }
        :host([empty]) .empty { display: block; }
        .palette { position: absolute; z-index: 5; display: none; grid-template-columns: repeat(5, 22px); gap: 6px;
          padding: 8px; border-radius: var(--radius); background: var(--surface-3); border: 1px solid var(--border-strong);
          box-shadow: var(--shadow); }
        .palette.open { display: grid; }
        .palette button, .palette label { all: unset; width: 22px; height: 22px; border-radius: 50%; cursor: pointer;
          background: var(--swatch); box-shadow: inset 0 0 0 1px rgba(0,0,0,.15); display: grid; place-items: center; }
        .palette button:hover, .palette button:focus-visible, .palette label:hover, .palette label:focus-within {
          box-shadow: 0 0 0 2px var(--surface-3), 0 0 0 3.5px var(--swatch); }
        .palette button[aria-checked=true]::after { content: ""; width: 7px; height: 7px; border-radius: 50%; background: var(--ink); }
        .palette label { grid-column: span 5; width: auto; border-radius: 6px; height: 24px; padding: 0 8px;
          --swatch: var(--surface-2); font-size: 11.5px; color: var(--muted); display: flex; gap: 8px; }
        .palette label i { width: 12px; height: 12px; border-radius: 50%; background: conic-gradient(#f25f4c, #e8a317, #2fb872, #3d8fef, #9b6cf0, #f25f4c); }
        .palette input { position: absolute; opacity: 0; width: 0; height: 0; pointer-events: none; }
        :host([ready]) band-card { transition: transform .2s cubic-bezier(.2,.8,.2,1); }
        :host([dragging]) band-card { transition: transform .12s linear; }
      </style>
      <div class="graph">
        <svg class="plot" data-i18n-aria="graph.aria"></svg>
        <div class="bypass" data-i18n="graph.bypass"></div>
        <div class="readout"></div>
      </div>
      <svg class="leaders" aria-hidden="true"></svg>
      <div class="lanes"><div class="track"></div><div class="empty" data-i18n="band.empty"></div></div>
      <div class="palette" role="dialog">
        ${PALETTE.map((c) => `<button role="radio" data-color="${c}" style="--swatch:${c};--ink:${inkFor(c)}"></button>`).join("")}
        <label><i></i><span data-i18n="color.custom"></span><input type="color" /></label>
      </div>`;

    this.plot = root.querySelector("svg.plot")!;
    this.leaders = root.querySelector("svg.leaders")!;
    this.readout = root.querySelector(".readout")!;
    this.lanes = root.querySelector(".lanes")!;
    this.track = root.querySelector(".track")!;
    this.palette = root.querySelector(".palette")!;
    this.customColor = root.querySelector(".palette input")!;
    this.build();
    this.bindPalette();

    this.lanes.addEventListener("band-patch", (e) => {
      const { index, patch, coalesce } = (e as CustomEvent).detail;
      store.updateBand(index, patch, coalesce);
    });
    const translate = () => {
      applyI18n(root);
      this.palette.querySelectorAll<HTMLElement>("button").forEach((b) => b.setAttribute("aria-label", b.dataset.color!));
      this.palette.setAttribute("aria-label", t("tip.color"));
      this.handles.forEach((h, i) => this.labelHandle(h, i));
    };
    i18n.addEventListener("change", translate);
    translate();
    this.lanes.addEventListener("band-select", (e) => store.select((e as CustomEvent).detail.index));
    this.lanes.addEventListener("band-remove", (e) => store.removeBand((e as CustomEvent).detail.index));
    this.lanes.addEventListener("band-color", (e) => {
      const { index, anchor } = (e as CustomEvent).detail;
      if (this.coloring === index) this.closePalette();
      else this.openPalette(index, anchor);
    });
    this.lanes.addEventListener("scroll", () => this.layoutLanes(store.eq.bands));
    this.plot.addEventListener("dblclick", (e) => {
      const rect = this.plot.getBoundingClientRect();
      if (!store.canAddBand) return;
      store.addBand({
        freq: this.freqAt(e.clientX - rect.left),
        gain: clamp(this.dbAt(e.clientY - rect.top), store.limits.gain.min, store.limits.gain.max),
      });
    });
    store.addEventListener("change", (e) => {
      const what = (e as CustomEvent).detail;
      if (what === "eq") this.render();
      else if (what === "selection") this.renderSelection();
      // The active profile bounds the fields and the filter types each card offers.
      else if (what === "meta") {
        for (const card of this.cards) card.setProfile(store.limits, store.filterTypes);
        // The sample rate of the response model comes from the profile too.
        this.render();
      }
    });
    new ResizeObserver(() => this.resize()).observe(this.plot);
    new ResizeObserver(() => this.render()).observe(this.lanes);
  }

  private build() {
    this.grid = el("g", { class: "grid" });
    this.bandFill = el("path", { class: "band-fill" });
    this.totalFill = el("path", { class: "total-fill" });
    this.totalPath = el("path", { class: "total" });
    this.curvesG = el("g");
    this.stemsG = el("g");
    this.handlesG = el("g");
    this.plot.append(this.grid, this.bandFill, this.curvesG, this.totalFill, this.totalPath, this.stemsG, this.handlesG);
  }

  /** Create or drop per-band elements so there is one set per band. Elements are keyed by index. */
  private syncBands(count: number) {
    while (this.handles.length < count) {
      const i = this.handles.length;
      const curve = el("path", { class: "band-curve" });
      this.curvesG.append(curve);
      this.bandPaths.push(curve);
      const stem = el("line", { class: "stem" });
      this.stemsG.append(stem);
      this.stems.push(stem);

      const g = el("g", { class: "handle", tabindex: 0, role: "slider" });
      g.append(el("circle", { class: "hit", r: 18 }), el("circle", { class: "ring", r: 15 }), el("circle", { class: "dot", r: 8 }));
      const label = el("text");
      label.textContent = String(i + 1);
      g.append(label);
      this.bindHandle(g, i);
      this.labelHandle(g, i);
      this.handlesG.append(g);
      this.handles.push(g);

      const leader = el("path", { class: "leader" });
      this.leaders.append(leader);
      this.leaderPaths.push(leader);

      const card = new BandCard();
      card.setProfile(store.limits, store.filterTypes);
      this.track.append(card);
      this.cards.push(card);
    }
    while (this.handles.length > count) {
      for (const list of [this.bandPaths, this.stems, this.handles, this.leaderPaths, this.cards] as Element[][]) list.pop()!.remove();
    }
    if (this.coloring !== null && this.coloring >= count) this.closePalette();
    this.toggleAttribute("empty", count === 0);
  }

  private labelHandle(h: SVGGElement, i: number) {
    const name = t("band.name", { n: i + 1 });
    h.setAttribute("aria-label", name);
    h.setAttribute("data-tooltip", t("tip.handle", { band: name }));
  }

  // ---- geometry -------------------------------------------------------------------------

  private get plotW() { return Math.max(1, this.width - MARGIN.left - MARGIN.right); }
  private get plotH() { return Math.max(1, this.height - MARGIN.top - MARGIN.bottom); }
  private x(freq: number) { return MARGIN.left + freqToUnit(freq) * this.plotW; }
  private y(db: number) { return MARGIN.top + ((this.yMax - db) / (this.yMax - this.yMin)) * this.plotH; }
  private freqAt(px: number) { return unitToFreq(clamp((px - MARGIN.left) / this.plotW, 0, 1)); }
  private dbAt(py: number) { return this.yMax - ((py - MARGIN.top) / this.plotH) * (this.yMax - this.yMin); }

  private resize() {
    const rect = this.plot.getBoundingClientRect();
    this.width = rect.width;
    this.height = rect.height;
    this.plot.setAttribute("viewBox", `0 0 ${this.width} ${this.height}`);
    this.render();
  }

  /** Grow the y axis to fit the modelled response (e.g. stacked shelves), in 6 dB steps. */
  private fitRange(total: number[]) {
    const lo = Math.min(...total);
    const hi = Math.max(...total);
    this.yMin = Math.max(-48, Math.min(-12, Math.floor((lo - 1) / 6) * 6));
    this.yMax = Math.min(24, Math.max(12, Math.ceil((hi + 1) / 6) * 6));
  }

  private drawGrid() {
    const g = this.grid;
    g.replaceChildren();
    const left = MARGIN.left;
    const right = this.width - MARGIN.right;
    const top = MARGIN.top;
    const bottom = MARGIN.top + this.plotH;
    for (const f of MINOR_FREQS) g.append(el("line", { x1: this.x(f), x2: this.x(f), y1: top, y2: bottom }));
    for (const f of MAJOR_FREQS) {
      const x = this.x(f);
      g.append(el("line", { class: "major", x1: x, x2: x, y1: top, y2: bottom }));
      const t = el("text", { class: "x", x: clamp(x, left + 8, right - 10), y: bottom + 17 });
      t.textContent = f === F_MIN || f === F_MAX ? `${formatFreq(f)}Hz` : formatFreq(f);
      g.append(t);
    }
    const span = this.yMax - this.yMin;
    const step = span > 36 ? 12 : span > 24 ? 6 : 3;
    for (let db = Math.ceil(this.yMin / step) * step; db <= this.yMax; db += step) {
      const y = this.y(db);
      const labelled = db % 6 === 0;
      g.append(el("line", { class: db === 0 ? "zero" : labelled ? "major" : "", x1: left, x2: right, y1: y, y2: y }));
      if (labelled) {
        const t = el("text", { class: "y", x: left - 8, y });
        t.textContent = db > 0 ? `+${db}` : db === 0 ? "0 dB" : `${db}`;
        g.append(t);
      }
    }
  }

  // ---- rendering ------------------------------------------------------------------------

  private render() {
    if (!this.width) return;
    const { bands, enabled } = store.eq;
    this.syncBands(bands.length);
    this.toggleAttribute("bypassed", !enabled);
    const { total, perBand } = response(bands, SWEEP, store.sampleRate);
    if (this.dragging === null) this.fitRange(total);
    this.drawGrid();

    const xs = SWEEP.map((f) => this.x(f).toFixed(1));
    const line = (curve: number[]) => curve.map((db, i) => `${i ? "L" : "M"}${xs[i]},${this.y(clamp(db, this.yMin - 6, this.yMax + 6)).toFixed(1)}`).join("");
    const area = (curve: number[]) => `${line(curve)}L${xs[xs.length - 1]},${this.y(0)}L${xs[0]},${this.y(0)}Z`;

    this.totalPath.setAttribute("d", line(total));
    this.totalFill.setAttribute("d", area(total));
    perBand.forEach((curve, i) => this.bandPaths[i].setAttribute("d", line(curve)));

    const bottom = MARGIN.top + this.plotH;
    bands.forEach((band, i) => {
      for (const node of [this.bandPaths[i], this.stems[i], this.handles[i], this.leaderPaths[i]]) node.style.setProperty("--c", band.color);
      this.handles[i].style.setProperty("--ink", inkFor(band.color));
      const x = this.x(band.freq);
      const y = this.y(band.gain);
      this.handles[i].setAttribute("transform", `translate(${x.toFixed(1)},${y.toFixed(1)})`);
      this.handles[i].setAttribute("aria-valuetext", describe(band));
      Object.entries({ x1: x, x2: x, y1: y + 10, y2: bottom }).forEach(([k, v]) => this.stems[i].setAttribute(k, String(v)));
      this.cards[i].update(i, band);
    });
    this.layoutLanes(bands);
    this.renderSelection();
    // Animate card reordering only after the first real layout, not the slide-in from x = 0.
    if (!this.hasAttribute("ready")) requestAnimationFrame(() => this.setAttribute("ready", ""));
    if (this.dragging !== null) this.showReadout(this.dragging);
    if (this.coloring !== null) this.markColor(bands[this.coloring].color);
  }

  private renderSelection() {
    const s = store.selected;
    this.handles.forEach((h, i) => h.classList.toggle("selected", i === s));
    this.bandPaths.forEach((p, i) => p.classList.toggle("selected", i === s));
    this.stems.forEach((p, i) => p.classList.toggle("selected", i === s));
    this.leaderPaths.forEach((p, i) => p.classList.toggle("selected", i === s));
    this.cards.forEach((c, i) => c.toggleAttribute("selected", i === s));
    // Keep the selected handle on top where points overlap. Only move it when needed: moving a
    // node releases its pointer capture mid-drag.
    const handle = this.handles[s];
    if (handle?.parentNode && handle.parentNode.lastChild !== handle) handle.parentNode.append(handle);
    const band = store.eq.bands[s];
    if (!band) this.bandFill.removeAttribute("d");
    else if (this.width) {
      const { perBand } = response([band], SWEEP, store.sampleRate);
      const xs = SWEEP.map((f) => this.x(f).toFixed(1));
      const d = perBand[0].map((db, i) => `${i ? "L" : "M"}${xs[i]},${this.y(clamp(db, this.yMin - 6, this.yMax + 6)).toFixed(1)}`).join("");
      this.bandFill.setAttribute("d", `${d}L${xs[xs.length - 1]},${this.y(0)}L${xs[0]},${this.y(0)}Z`);
      this.bandFill.style.setProperty("--c", band.color);
    }
  }

  /**
   * Centre each card under its point, then resolve overlaps in x order: push right past the
   * previous card, then pull left from the right edge. When the cards do not fit at their
   * narrowest, the lane becomes wider than the view and scrolls; leaders follow the scroll.
   */
  private layoutLanes(bands: Band[]) {
    const n = bands.length;
    const view = this.lanes.clientWidth;
    const width = clamp((view - CARD_GAP * (n - 1)) / n, CARD_MIN, CARD_MAX);
    const total = Math.max(view, n * width + CARD_GAP * (n - 1));
    this.track.style.width = `${total}px`;
    const scroll = this.lanes.scrollLeft;
    const order = bands.map((b, i) => ({ i, x: this.x(b.freq) })).sort((a, b) => a.x - b.x || a.i - b.i);
    const left = order.map((o) => o.x - width / 2);
    for (let k = 0; k < left.length; k++) left[k] = Math.max(left[k], k ? left[k - 1] + width + CARD_GAP : 0);
    for (let k = left.length - 1; k >= 0; k--)
      left[k] = Math.min(left[k], k < left.length - 1 ? left[k + 1] - width - CARD_GAP : total - width);

    const h = LEADER_HEIGHT;
    order.forEach(({ i, x }, k) => {
      const card = this.cards[i];
      card.style.width = `${width}px`;
      card.style.transform = `translateX(${left[k].toFixed(1)}px)`;
      const cx = left[k] + width / 2 - scroll;
      this.leaderPaths[i].setAttribute("d", `M${x.toFixed(1)},0 C${x.toFixed(1)},${h * 0.6} ${cx.toFixed(1)},${h * 0.4} ${cx.toFixed(1)},${h}`);
    });
  }

  private showReadout(i: number) {
    const band = store.eq.bands[i];
    this.readout.textContent = describe(band);
    const x = clamp(this.x(band.freq), 80, this.width - 80);
    this.readout.style.left = `${x}px`;
    this.readout.style.top = `${Math.max(34, this.y(band.gain) - 18)}px`;
    this.readout.classList.add("show");
  }

  // ---- interaction ----------------------------------------------------------------------

  private bindHandle(g: SVGGElement, i: number) {
    g.addEventListener("pointerdown", (e) => {
      e.preventDefault();
      g.focus({ preventScroll: true });
      store.select(i);
      const band = store.eq.bands[i];
      const rect = this.plot.getBoundingClientRect();
      // Keep the grab offset so the point does not jump under the cursor.
      const dx = e.clientX - rect.left - this.x(band.freq);
      const dy = e.clientY - rect.top - this.y(band.gain);
      const startX = e.clientX;
      const startY = e.clientY;
      let axis: "x" | "y" | null = null;
      const gesture = `drag-${i}-${++this.gestures}`;
      g.setPointerCapture(e.pointerId);
      this.dragging = i;
      this.toggleAttribute("dragging", true);
      this.showReadout(i);

      const move = (ev: PointerEvent) => {
        // Shift locks to the dominant axis of the gesture.
        if (ev.shiftKey && !axis) axis = Math.abs(ev.clientX - startX) > Math.abs(ev.clientY - startY) ? "x" : "y";
        if (!ev.shiftKey) axis = null;
        const patch: Partial<Band> = {};
        if (axis !== "y") patch.freq = this.freqAt(ev.clientX - rect.left - dx);
        if (axis !== "x") patch.gain = clamp(this.dbAt(ev.clientY - rect.top - dy), store.limits.gain.min, store.limits.gain.max);
        store.updateBand(i, patch, gesture);
      };
      const up = () => {
        g.removeEventListener("pointermove", move);
        g.removeEventListener("lostpointercapture", up);
        this.dragging = null;
        store.endGesture();
        this.toggleAttribute("dragging", false);
        this.readout.classList.remove("show");
        this.render();
      };
      g.addEventListener("pointermove", move);
      // Fires after pointerup/pointercancel, and also if capture is lost for any other reason.
      g.addEventListener("lostpointercapture", up);
    });

    g.addEventListener("dblclick", (e) => {
      // Not a double-click on the graph, which adds a band.
      e.stopPropagation();
      store.updateBand(i, { gain: 0 });
    });

    g.addEventListener(
      "wheel",
      (e) => {
        e.preventDefault();
        store.select(i);
        const q = store.eq.bands[i].q * Math.exp(-clamp(e.deltaY, -60, 60) * 0.004);
        store.updateBand(i, { q }, `wheel-${i}`);
      },
      { passive: false },
    );

    g.addEventListener("keydown", (e) => {
      if (e.key === "Delete" || e.key === "Backspace") {
        e.preventDefault();
        store.removeBand(i);
        this.handles[store.selected]?.focus({ preventScroll: true });
        return;
      }
      const band = store.eq.bands[i];
      const big = e.shiftKey;
      const patches: Record<string, Partial<Band>> = {
        ArrowUp: { gain: band.gain + (big ? 1 : 0.1) },
        ArrowDown: { gain: band.gain - (big ? 1 : 0.1) },
        ArrowRight: { freq: band.freq * Math.pow(2, big ? 1 / 3 : 1 / 24) },
        ArrowLeft: { freq: band.freq / Math.pow(2, big ? 1 / 3 : 1 / 24) },
        "]": { q: band.q * 1.1 },
        "[": { q: band.q / 1.1 },
        "0": { gain: 0 },
      };
      const patch = patches[e.key];
      if (!patch) return;
      e.preventDefault();
      store.updateBand(i, patch, `key-${i}`);
    });
    g.addEventListener("focus", () => store.select(i));
  }

  // ---- color picker --------------------------------------------------------------------

  private bindPalette() {
    this.palette.addEventListener("click", (e) => {
      const color = (e.target as HTMLElement).closest<HTMLElement>("button")?.dataset.color;
      if (!color || this.coloring === null) return;
      store.updateBand(this.coloring, { color });
      this.closePalette();
    });
    this.customColor.addEventListener("input", () => {
      if (this.coloring !== null) store.updateBand(this.coloring, { color: this.customColor.value }, `color-${this.coloring}`);
    });
    this.palette.addEventListener("keydown", (e) => {
      if (e.key === "Escape") this.closePalette();
    });
    // Close on any press outside the picker. The swatch that opened it toggles it itself.
    window.addEventListener("pointerdown", (e) => {
      if (this.coloring === null) return;
      const path = e.composedPath();
      if (!path.includes(this.palette) && !path.some((n) => n instanceof HTMLElement && n.classList.contains("n"))) this.closePalette();
    });
  }

  private openPalette(index: number, anchor: DOMRect) {
    this.coloring = index;
    store.select(index);
    this.markColor(store.eq.bands[index].color);
    this.palette.classList.add("open");
    const host = this.getBoundingClientRect();
    const pop = this.palette.getBoundingClientRect();
    // Cards sit at the bottom of the editor, so the picker opens above the swatch.
    this.palette.style.left = `${clamp(anchor.left - host.left - 8, 0, host.width - pop.width)}px`;
    this.palette.style.top = `${Math.max(0, anchor.top - host.top - pop.height - 8)}px`;
    this.palette.querySelector<HTMLElement>("[aria-checked=true], button")!.focus({ preventScroll: true });
  }

  private closePalette() {
    this.coloring = null;
    this.palette.classList.remove("open");
    store.endGesture();
  }

  private markColor(color: string) {
    this.palette.querySelectorAll<HTMLElement>("button").forEach((b) => b.setAttribute("aria-checked", String(b.dataset.color === color)));
    this.customColor.value = color;
  }
}

function describe(b: Band) {
  const gain = `${b.gain > 0 ? "+" : ""}${b.gain.toFixed(1)} dB`;
  return `${formatFreq(b.freq)}Hz  ${gain}  Q ${b.q.toFixed(2)}`;
}

customElements.define("eq-editor", EqEditor);
