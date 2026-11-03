// הסל וה-localStorage, במפתח אחד: { items: [{ barcode, qty }], decisions: {} }
// מוצר במשקל: הכמות בק"ג, בקפיצות של חצי ק"ג. שאר המוצרים: יחידות שלמות.
const STORAGE_KEY = "cartwise_basket";
export const MAX_QTY = 99;
const KG_STEP = 0.5;

let state = { items: [], decisions: {} };
let weighted = new Set();

function save() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch {
    // localStorage לא זמין (למשל גלישה פרטית): הסל עובד, רק לא נשמר
  }
}

// טוען את הסל השמור. ברקוד שכבר לא קיים ברשימת המוצרים נזרק בשקט.
// kgBarcodes: הברקודים של המוצרים במשקל
export function load(knownBarcodes, kgBarcodes = new Set()) {
  weighted = kgBarcodes;
  let saved = null;
  try {
    saved = JSON.parse(localStorage.getItem(STORAGE_KEY));
  } catch {
    saved = null;
  }

  const items = Array.isArray(saved?.items) ? saved.items : [];
  const seen = new Set();
  state.items = items
    .filter((it) => knownBarcodes.has(it?.barcode) && !seen.has(it.barcode) && seen.add(it.barcode))
    .map((it) => ({ barcode: it.barcode, qty: clamp(it.barcode, Number(it.qty)) }));
  state.decisions = saved?.decisions && typeof saved.decisions === "object" ? saved.decisions : {};
  save();
}

function step(barcode) {
  return weighted.has(barcode) ? KG_STEP : 1;
}

// הכמות הקטנה ביותר: יחידה אחת, או חצי ק"ג
export function minQty(barcode) {
  return step(barcode);
}

function clamp(barcode, qty) {
  const s = step(barcode);
  if (!Number.isFinite(qty)) return weighted.has(barcode) ? 1 : s;
  return Math.min(MAX_QTY, Math.max(s, Math.round(qty / s) * s));
}

function find(barcode) {
  return state.items.find((it) => it.barcode === barcode);
}

export function items() {
  return state.items.map((it) => ({ ...it }));
}

export function has(barcode) {
  return Boolean(find(barcode));
}

// מוצר חדש נכנס עם כמות 1: יחידה אחת, או ק"ג אחד
export function add(barcode) {
  if (has(barcode)) return;
  state.items.push({ barcode, qty: 1 });
  save();
}

// direction: 1 להגדלה, -1 להקטנה, בקפיצה אחת
export function changeQty(barcode, direction) {
  const it = find(barcode);
  if (!it) return;
  it.qty = clamp(barcode, it.qty + direction * step(barcode));
  save();
}

export function clear() {
  state.items = [];
  save();
}

export function remove(barcode) {
  state.items = state.items.filter((it) => it.barcode !== barcode);
  save();
}

// החלטות על חלופות, לכל רשת ומוצר: "approved" או "rejected". בלי החלטה: לא אושרה.
export function decision(chainId, barcode) {
  return state.decisions[`${chainId}:${barcode}`] ?? null;
}

export function decide(chainId, barcode, value) {
  state.decisions[`${chainId}:${barcode}`] = value;
  save();
}
