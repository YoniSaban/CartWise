// הסל וה-localStorage, במפתח אחד: { items: [{ barcode, qty }], decisions: {} }
const STORAGE_KEY = "cartwise_basket";
export const MIN_QTY = 1;
export const MAX_QTY = 99;

let state = { items: [], decisions: {} };

function save() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch {
    // localStorage לא זמין (למשל גלישה פרטית): הסל עובד, רק לא נשמר
  }
}

// טוען את הסל השמור. ברקוד שכבר לא קיים ברשימת המוצרים נזרק בשקט.
export function load(knownBarcodes) {
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
    .map((it) => ({ barcode: it.barcode, qty: clamp(Number(it.qty)) }));
  state.decisions = saved?.decisions && typeof saved.decisions === "object" ? saved.decisions : {};
  save();
}

function clamp(qty) {
  if (!Number.isFinite(qty)) return MIN_QTY;
  return Math.min(MAX_QTY, Math.max(MIN_QTY, Math.round(qty)));
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

export function add(barcode) {
  if (has(barcode)) return;
  state.items.push({ barcode, qty: MIN_QTY });
  save();
}

export function changeQty(barcode, delta) {
  const it = find(barcode);
  if (!it) return;
  it.qty = clamp(it.qty + delta);
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
