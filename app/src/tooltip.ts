/**
 * One tooltip for the whole app. Any element (also inside open shadow roots) with a
 * `data-tooltip` attribute gets it; `data-shortcut` adds a key hint. Shown after a short hover
 * delay (instantly when moving between controls), or on keyboard focus.
 */
const SHOW_DELAY_MS = 450;
const WARM_MS = 400;
const GAP = 8;
const EDGE = 8;

let bubble: HTMLDivElement;
let owner: Element | null = null;
let suppressed: Element | null = null;
let timer = 0;
let lastHiddenAt = 0;

function findTarget(e: Event): Element | null {
  for (const node of e.composedPath()) {
    if (node instanceof Element && node.hasAttribute("data-tooltip")) return node;
    if (node === document.body) break;
  }
  return null;
}

function render(target: Element) {
  bubble.replaceChildren(document.createTextNode(target.getAttribute("data-tooltip") ?? ""));
  const shortcut = target.getAttribute("data-shortcut");
  if (shortcut) {
    const kbd = document.createElement("kbd");
    kbd.textContent = shortcut;
    bubble.append(kbd);
  }
}

function place(target: Element) {
  const r = target.getBoundingClientRect();
  const b = bubble.getBoundingClientRect();
  const below = r.bottom + GAP + b.height <= window.innerHeight - EDGE;
  const top = below ? r.bottom + GAP : r.top - GAP - b.height;
  const left = Math.min(Math.max(r.left + r.width / 2 - b.width / 2, EDGE), window.innerWidth - b.width - EDGE);
  bubble.style.transform = `translate(${Math.round(left)}px, ${Math.round(top)}px)`;
  bubble.dataset.side = below ? "below" : "above";
}

function show(target: Element) {
  clearTimeout(timer);
  const text = target.getAttribute("data-tooltip");
  if (!text) return hide();
  owner = target;
  render(target);
  bubble.classList.add("visible");
  place(target);
}

function hide() {
  clearTimeout(timer);
  if (owner) lastHiddenAt = performance.now();
  owner = null;
  bubble.classList.remove("visible");
}

function schedule(target: Element) {
  clearTimeout(timer);
  const warm = owner !== null || performance.now() - lastHiddenAt < WARM_MS;
  if (warm) show(target);
  else timer = window.setTimeout(() => show(target), SHOW_DELAY_MS);
}

export function installTooltips() {
  bubble = document.createElement("div");
  bubble.className = "md-tooltip";
  bubble.setAttribute("role", "tooltip");
  document.body.append(bubble);

  // Track on pointermove rather than pointerover: it also covers a pointer that appears over an
  // element without crossing a boundary, and only does work when the hovered control changes.
  let hovered: Element | null = null;
  window.addEventListener(
    "pointermove",
    (e) => {
      if (e.pointerType === "touch" || e.buttons) return;
      const target = findTarget(e);
      if (target === hovered) return;
      hovered = target;
      if (target !== suppressed) suppressed = null;
      if (!target || target === suppressed) return hide();
      schedule(target);
    },
    { capture: true, passive: true },
  );
  document.documentElement.addEventListener("pointerleave", () => {
    hovered = null;
    hide();
  });
  // Clicking or dragging a control dismisses its tooltip until the pointer leaves it.
  window.addEventListener(
    "pointerdown",
    (e) => {
      suppressed = findTarget(e);
      hide();
    },
    true,
  );
  window.addEventListener(
    "focusin",
    (e) => {
      const target = findTarget(e);
      const el = e.composedPath()[0];
      if (target && el instanceof Element && el.matches(":focus-visible")) show(target);
    },
    true,
  );
  window.addEventListener("focusout", () => hide(), true);
  window.addEventListener("keydown", (e) => e.key === "Escape" && hide(), true);
  window.addEventListener("wheel", hide, { capture: true, passive: true });
  window.addEventListener("resize", hide);

  // Keep the text current if it changes while shown (language switch, connection state).
  new MutationObserver(() => owner && (owner.isConnected ? (render(owner), place(owner)) : hide())).observe(document.documentElement, {
    attributes: true,
    attributeFilter: ["lang"],
  });
}

