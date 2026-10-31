// מעבר בין מסכים: "בניית הסל" ו"פלט תוצאות"
import * as basket from "./basket.js?v=3";
import { fetchPrices } from "./prices.js?v=3";
import { compareBasket, formatPrice } from "./compare.js?v=3";

const $ = (id) => document.getElementById(id);

let products = [];
let chains = [];
let byBarcode = new Map();
let activeCategory = null;

// החיפוש מתעלם מגרשיים, ממרכאות ומרווחים מיותרים: קוטג' = קוטג
function normalize(text) {
  return text.replace(/['"׳״`]/g, "").replace(/\s+/g, " ").trim().toLowerCase();
}

function label(p) {
  return `${p.name} · ${p.size}`;
}

function announce(text) {
  $("announcer").textContent = text;
}

function countText(n) {
  return n === 1 ? "מוצר אחד" : `${n} מוצרים`;
}

function el(tag, attrs = {}, text) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === false || v == null) continue;
    node.setAttribute(k, v === true ? "" : v);
  }
  if (text != null) node.textContent = text;
  return node;
}

function productInfo(p, withMeta) {
  const info = el("div", { class: "item-info" });
  info.append(el("span", { class: "item-name" }, label(p)));
  // השורה הקטנה: היצרן, ואם אין, הקטגוריה
  if (withMeta) info.append(el("span", { class: "item-meta" }, p.manufacturer || p.category));
  return info;
}

function renderProducts() {
  const query = normalize($("search").value);
  const shown = products.filter(
    (p) => (!activeCategory || p.category === activeCategory) && (!query || normalize(p.name).includes(query))
  );
  const list = $("products");
  list.replaceChildren();

  for (const p of shown) {
    const inBasket = basket.has(p.barcode);
    const li = el("li", { class: "card" });
    const btn = el(
      "button",
      {
        type: "button",
        class: "btn-secondary btn-add",
        "data-action": "add",
        "data-barcode": p.barcode,
        "aria-label": inBasket ? `${p.name} כבר בסל` : `הוסף ${p.name} לסל`,
        disabled: inBasket,
      },
      inBasket ? "בסל ✓" : "הוסף"
    );
    li.append(productInfo(p, true), btn);
    list.append(li);
  }

  $("products-status").textContent = shown.length ? "" : "לא נמצאו מוצרים";
}

// כפתור קטגוריה מסנן את הרשימה. לחיצה נוספת על אותה קטגוריה מבטלת את הסינון.
// שתי שורות: בעליונה, ליד החיפוש, "מזון יבש" ו"לחם". בתחתונה שאר הקטגוריות.
const TOP_CATEGORIES = ["מזון יבש", "לחם"];

function renderCategories() {
  const top = $("categories-top");
  const bottom = $("categories-bottom");
  top.replaceChildren();
  bottom.replaceChildren();
  const rest = [...new Set(products.map((p) => p.category))].filter((c) => !TOP_CATEGORIES.includes(c));
  const categories = [...TOP_CATEGORIES, ...rest];
  categories.forEach((category, i) => {
    const pressed = category === activeCategory;
    const btn = el("button", { type: "button", class: "chip", "aria-pressed": String(pressed) }, category);
    btn.addEventListener("click", () => {
      activeCategory = pressed ? null : category;
      $("search").value = "";
      renderCategories();
      renderProducts();
      document.querySelectorAll(".chip")[i].focus();
    });
    (i < TOP_CATEGORIES.length ? top : bottom).append(btn);
  });
}

function renderBasket() {
  const items = basket.items();
  const list = $("basket");
  list.replaceChildren();

  for (const { barcode, qty } of items) {
    const p = byBarcode.get(barcode);
    const li = el("li", { class: "card" });
    const controls = el("div", { class: "qty-controls" });
    controls.append(
      el("button", { type: "button", class: "btn-qty", "data-action": "inc", "data-barcode": barcode,
        "aria-label": `הגדל כמות של ${p.name}`, disabled: qty >= basket.MAX_QTY }, "+"),
      el("span", { class: "qty", "aria-label": `כמות: ${qty}` }, String(qty)),
      el("button", { type: "button", class: "btn-qty", "data-action": "dec", "data-barcode": barcode,
        "aria-label": `הקטן כמות של ${p.name}`, disabled: qty <= basket.MIN_QTY }, "−"),
      el("button", { type: "button", class: "btn-link", "data-action": "remove", "data-barcode": barcode,
        "aria-label": `הסר ${p.name} מהסל` }, "הסר")
    );
    li.append(productInfo(p, false), controls);
    list.append(li);
  }

  $("basket-title").textContent = `הסל שלי (${countText(items.length)})`;
  $("basket-empty").hidden = items.length > 0;

  const compare = $("btn-compare");
  compare.disabled = items.length === 0;
  compare.textContent = items.length ? "השווה" : "השווה (סל ריק)";
  $("btn-clear").disabled = items.length === 0;
}

function render() {
  renderProducts();
  renderBasket();
}

// אחרי ציור מחדש מחזירים את הפוקוס לכפתור המתאים, כדי שאפשר יהיה להמשיך עם המקלדת
function focusButton(action, barcode) {
  const btn = document.querySelector(`[data-action="${action}"][data-barcode="${barcode}"]`);
  if (btn && !btn.disabled) btn.focus();
  return Boolean(btn && !btn.disabled);
}

function handleClick(event) {
  const btn = event.target.closest("button[data-action]");
  if (!btn) return;
  const { action, barcode } = btn.dataset;
  const name = byBarcode.get(barcode)?.name;

  if (action === "add") {
    basket.add(barcode);
    render();
    announce(`${name} נוסף לסל. בסל ${countText(basket.items().length)}`);
    focusButton("inc", barcode);
  } else if (action === "inc" || action === "dec") {
    basket.changeQty(barcode, action === "inc" ? 1 : -1);
    render();
    const qty = basket.items().find((it) => it.barcode === barcode).qty;
    announce(`כמות של ${name}: ${qty}`);
    if (!focusButton(action, barcode)) focusButton(action === "inc" ? "dec" : "inc", barcode);
  } else if (action === "remove") {
    basket.remove(barcode);
    render();
    announce(`${name} הוסר מהסל. בסל ${countText(basket.items().length)}`);
    if (!focusButton("add", barcode)) $("search").focus();
  }
}

// מציג מסך אחד ומסתיר את השאר
function showScreen(id) {
  document.querySelectorAll(".screen").forEach((s) => (s.hidden = s.id !== id));
  window.scrollTo(0, 0);
}

function statusText(result) {
  const n = result.missing.length;
  if (n === 0) return `סל מלא · ${countText(basket.items().length)}`;
  return n === 1 ? "חסר מוצר אחד" : `חסרים ${n} מוצרים`;
}

function renderResults(results) {
  const list = $("results");
  list.replaceChildren();
  for (const r of results) {
    const li = el("li", { class: r.cheapest ? "card result cheapest" : "card result" });
    const head = el("div", { class: "result-head" });
    head.append(el("h3", { class: "chain-name" }, r.chain.name));
    if (r.cheapest) head.append(el("span", { class: "tag tag-cheapest" }, "✓ הזול ביותר"));
    li.append(
      head,
      el("p", { class: "chain-store" }, r.chain.store_name),
      el("p", { class: "price" }, formatPrice(r.total)),
      el("p", { class: r.complete ? "result-status" : "result-status partial" }, statusText(r))
    );
    list.append(li);
  }
}

function formatDate(iso) {
  const d = new Date(iso);
  return `${d.getDate()}.${d.getMonth() + 1}.${d.getFullYear()}`;
}

async function compare() {
  const items = basket.items();
  if (!items.length) return;
  showScreen("screen-results");
  $("results").replaceChildren();
  $("results-updated").textContent = "";
  $("results-status").textContent = "מחשבים את עלות הסל...";
  $("results-title").focus();

  try {
    const codes = [...new Set(items.flatMap(({ barcode }) => {
      const p = byBarcode.get(barcode);
      return [p.barcode, ...Object.values(p.chain_codes || {})];
    }))];
    const rows = await fetchPrices(codes, chains.map((c) => c.chain_id));
    const results = compareBasket(items, byBarcode, chains, rows);
    renderResults(results);
    $("results-status").textContent = "";
    const latest = rows.map((r) => r.loaded_at).sort().pop();
    if (latest) $("results-updated").textContent = `המחירים עודכנו ב-${formatDate(latest)}`;
    const best = results.find((r) => r.cheapest);
    announce(best ? `הזול ביותר: ${best.chain.name}, ${formatPrice(best.total)}` : "התוצאות מוכנות");
  } catch {
    $("results-status").textContent = "לא הצלחנו לטעון את המחירים. בדקו את החיבור ונסו שוב.";
  }
}

async function loadJson(path) {
  const res = await fetch(path);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

async function init() {
  try {
    [products, chains] = await Promise.all([
      loadJson("data/products.json?v=3"),
      loadJson("data/chains.json?v=3"),
    ]);
  } catch {
    $("products-status").textContent = "לא הצלחנו לטעון את רשימת המוצרים. נסו לרענן את הדף.";
    return;
  }

  byBarcode = new Map(products.map((p) => [p.barcode, p]));
  basket.load(new Set(byBarcode.keys()));
  renderCategories();
  render();

  // החיפוש תמיד על כל המוצרים: הקלדה מבטלת את סימון הקטגוריה
  $("search").addEventListener("input", () => {
    if (activeCategory) {
      activeCategory = null;
      renderCategories();
    }
    renderProducts();
  });
  $("products").addEventListener("click", handleClick);
  $("basket").addEventListener("click", handleClick);
  // מסך החלופות נבנה במיילסטון 5. בינתיים "השווה" מוביל ישר לתוצאות.
  $("btn-compare").addEventListener("click", compare);
  $("btn-clear").addEventListener("click", () => {
    if (!confirm("לנקות את כל הסל?")) return;
    basket.clear();
    render();
    announce("הסל רוקן");
    $("search").focus();
  });
  $("btn-back").addEventListener("click", () => {
    showScreen("screen-build");
    $("btn-compare").focus();
  });
}

init();
