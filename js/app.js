// מעבר בין מסכים: "בניית הסל", "המלצת חלופות" ו"פלט תוצאות"
import * as basket from "./basket.js?v=5";
import { fetchPrices } from "./prices.js?v=5";
import { compareBasket, formatPrice } from "./compare.js?v=5";
import { findSubstitutes } from "./substitutes.js?v=5";

const $ = (id) => document.getElementById(id);

let products = [];
let chains = [];
let byBarcode = new Map();
let activeCategory = null;

// ההשוואה האחרונה: הסל, המחירים מ-Supabase, וההצעות לחלופות ("chain:barcode" -> הצעה)
let lastItems = [];
let lastRows = [];
let suggestions = new Map();

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

// counted: מספר המוצרים שנכנסו לחישוב, בלי אלה שלא נמצאו באף רשת
function statusText(result, counted) {
  const n = result.missing.length;
  const s = result.substituted.length;
  if (n === 0 && s === 0) return `סל מלא · ${countText(counted)}`;
  if (n === 0) return s === 1 ? "סל מלא · חלופה אחת אושרה" : `סל מלא · ${s} חלופות אושרו`;
  return n === 1 ? "חלקי, חסר מוצר אחד" : `חלקי, חסרים ${n} מוצרים`;
}

function productNames(barcodes) {
  return barcodes.map((b) => byBarcode.get(b).name).join(", ");
}

function renderResults({ results, notFound }, counted) {
  const list = $("results");
  list.replaceChildren();
  for (const r of results) {
    const li = el("li", { class: r.cheapest ? "card result cheapest" : "card result" });
    const head = el("div", { class: "result-head" });
    head.append(el("h3", { class: "chain-name" }, r.chain.name));
    if (r.cheapest) head.append(el("span", { class: "tag tag-cheapest" }, "✓ הזול ביותר"));
    if (r.substituted.length) head.append(el("span", { class: "tag tag-sub" }, "⇄ חלופה"));
    if (!r.complete) head.append(el("span", { class: "tag tag-partial" }, "חלקי"));
    li.append(
      head,
      el("p", { class: "chain-store" }, r.chain.store_name),
      el("p", { class: "price" }, formatPrice(r.total)),
      el("p", { class: r.complete ? "result-status" : "result-status partial" }, statusText(r, counted))
    );
    for (const { barcode, item } of r.substituted) {
      li.append(el("p", { class: "result-missing" }, `⇄ חלופה: ${item.item_name} במקום ${byBarcode.get(barcode).name}`));
    }
    if (!r.complete) li.append(el("p", { class: "result-missing" }, `חסר ברשת: ${productNames(r.missing)}`));
    list.append(li);
  }

  const box = $("not-found");
  box.replaceChildren();
  if (!notFound.length) {
    box.append(el("p", { class: "note" }, "אין מוצרים כאלה בסל הזה"));
    return;
  }
  box.append(el("p", { class: "note" }, "המוצרים האלה לא נכנסו לאף סכום:"));
  const ul = el("ul", { class: "not-found-list" });
  for (const b of notFound) {
    const p = byBarcode.get(b);
    ul.append(el("li", {}, label(p)));
  }
  box.append(ul);
}

function formatDate(iso) {
  const d = new Date(iso);
  return `${d.getDate()}.${d.getMonth() + 1}.${d.getFullYear()}`;
}

// חלופות שהמשתמש אישר, ושיש להן מחיר ברשת
function approvedSubstitutes() {
  const approved = new Map();
  for (const [k, s] of suggestions) {
    if (s.item && basket.decision(s.chain_id, s.barcode) === "approved") approved.set(k, s.item);
  }
  return approved;
}

function showResults() {
  showScreen("screen-results");
  $("results-status").textContent = "";
  $("results-title").focus();

  const comparison = compareBasket(lastItems, byBarcode, chains, lastRows, approvedSubstitutes());
  const { results, notFound } = comparison;
  renderResults(comparison, lastItems.length - notFound.length);
  $("not-found-section").hidden = false;
  const latest = lastRows.map((r) => r.loaded_at).sort().pop();
  $("results-updated").textContent = latest ? `המחירים עודכנו ב-${formatDate(latest)}` : "";
  const best = results.find((r) => r.cheapest);
  const lost = !notFound.length ? ""
    : notFound.length === 1 ? ". מוצר אחד לא נמצא באף רשת" : `. ${notFound.length} מוצרים לא נמצאו באף רשת`;
  if (best) announce(`הזול ביותר: ${best.chain.name}, ${formatPrice(best.total)}${lost}`);
  else if (notFound.length < lastItems.length) announce(`התוצאות מוכנות. אין רשת עם סל מלא${lost}`);
  else announce("אף מוצר בסל לא נמצא ברשתות");
}

function decisionText(value) {
  if (value === "approved") return "החלופה אושרה";
  if (value === "rejected") return "החלופה נדחתה";
  return "";
}

// כרטיס לכל מוצר שחסר ברשת: עם חלופה, "✓ אשר" ו"דחה". בלי חלופה, "חסר ברשת" בלי כפתורים.
function renderSubs(pairs) {
  const list = $("subs");
  list.replaceChildren();
  for (const { chain, barcode } of pairs) {
    const s = suggestions.get(`${chain.chain_id}:${barcode}`);
    const p = byBarcode.get(barcode);
    const li = el("li", { class: "card sub" });
    const head = el("div", { class: "result-head" });
    head.append(el("h3", { class: "chain-name" }, chain.name));
    head.append(s?.item
      ? el("span", { class: "tag tag-sub" }, "⇄ חלופה")
      : el("span", { class: "tag tag-missing" }, "חסר ברשת"));
    li.append(head, el("p", { class: "sub-missing" }, `חסר ברשת: ${label(p)}`));

    if (!s?.item) {
      li.append(el("p", { class: "sub-none" }, s?.error ? "לא הצלחנו לבדוק חלופה כרגע" : "לא נמצאה חלופה מתאימה ברשת"));
      list.append(li);
      continue;
    }

    const value = basket.decision(chain.chain_id, barcode);
    li.append(el("p", { class: "sub-offer" }, `חלופה מוצעת: ${s.item.item_name}`));
    if (s.reason) li.append(el("p", { class: "sub-reason" }, s.reason));
    const buttons = el("div", { class: "sub-actions" });
    buttons.append(
      el("button", { type: "button", class: "btn-approve", "data-sub": "approved", "data-chain": chain.chain_id,
        "data-barcode": barcode, "aria-pressed": String(value === "approved"),
        "aria-label": `אשר ${s.item.item_name} במקום ${p.name} ב${chain.name}` }, "✓ אשר"),
      el("button", { type: "button", class: "btn-reject", "data-sub": "rejected", "data-chain": chain.chain_id,
        "data-barcode": barcode, "aria-pressed": String(value === "rejected"),
        "aria-label": `דחה את החלופה ל${p.name} ב${chain.name}` }, "דחה")
    );
    li.append(buttons);
    const state = decisionText(value);
    li.append(el("p", { class: value === "approved" ? "sub-state approved" : "sub-state" }, state));
    list.append(li);
  }
}

let subsPairs = [];

function handleDecision(event) {
  const btn = event.target.closest("button[data-sub]");
  if (!btn) return;
  const { sub, chain, barcode } = btn.dataset;
  basket.decide(chain, barcode, sub);
  renderSubs(subsPairs);
  document.querySelector(`[data-sub="${sub}"][data-chain="${chain}"][data-barcode="${barcode}"]`)?.focus();
  announce(decisionText(sub));
}

async function compare() {
  const items = basket.items();
  if (!items.length) return;
  showScreen("screen-results");
  $("results").replaceChildren();
  $("not-found-section").hidden = true;
  $("results-updated").textContent = "";
  $("results-status").textContent = "מחשבים את עלות הסל...";
  $("results-title").focus();

  try {
    const codes = [...new Set(items.flatMap(({ barcode }) => {
      const p = byBarcode.get(barcode);
      return [p.barcode, ...Object.values(p.chain_codes || {})];
    }))];
    lastRows = await fetchPrices(codes, chains.map((c) => c.chain_id));
    lastItems = items;
  } catch {
    $("results-status").textContent = "לא הצלחנו לטעון את המחירים. בדקו את החיבור ונסו שוב.";
    return;
  }

  // מוצר שחסר ברשת אחת לפחות (ולא בכולן) מוביל למסך החלופות. אחרת ישר לתוצאות.
  const { results } = compareBasket(lastItems, byBarcode, chains, lastRows);
  subsPairs = results.flatMap((r) => r.missing.map((barcode) => ({ chain: r.chain, barcode })));
  suggestions = new Map();
  if (!subsPairs.length) {
    showResults();
    return;
  }

  showScreen("screen-subs");
  $("subs").replaceChildren();
  $("btn-to-results").disabled = true;
  $("subs-status").textContent = "מחפשים חלופות ברשתות...";
  $("subs-title").focus();
  try {
    suggestions = await findSubstitutes(subsPairs.map(({ chain, barcode }) => ({ chain_id: chain.chain_id, barcode })));
    $("subs-status").textContent = "";
  } catch {
    $("subs-status").textContent = "לא הצלחנו לבדוק חלופות כרגע. אפשר להמשיך לתוצאות עם סל חלקי.";
  }
  renderSubs(subsPairs);
  $("btn-to-results").disabled = false;
  const offered = [...suggestions.values()].filter((s) => s.item).length;
  announce(offered ? `נמצאו ${offered === 1 ? "חלופה אחת" : `${offered} חלופות`}. אשרו או דחו כל חלופה` : "לא נמצאו חלופות");
}

async function loadJson(path) {
  const res = await fetch(path);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

async function init() {
  try {
    [products, chains] = await Promise.all([
      loadJson("data/products.json?v=5"),
      loadJson("data/chains.json?v=5"),
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
  $("btn-compare").addEventListener("click", compare);
  $("subs").addEventListener("click", handleDecision);
  $("btn-to-results").addEventListener("click", showResults);
  $("btn-subs-back").addEventListener("click", () => {
    showScreen("screen-build");
    $("btn-compare").focus();
  });
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
