// מעבר בין מסכים: "בניית הסל", "המלצת חלופות" ו"פלט תוצאות"
import * as basket from "./basket.js?v=11";
import { fetchPrices } from "./prices.js?v=11";
import { compareBasket, formatPrice, parseChainSize, parseSizeText, unitPrice } from "./compare.js?v=11";
import { findSubstitutes } from "./substitutes.js?v=11";

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

// החיפוש בודק את שם המוצר, מילות המפתח והיצרן: "מיץ" מוצא גם את פריגת
function matches(p, query) {
  return [p.name, p.manufacturer, ...(p.keywords || [])]
    .some((text) => text && normalize(text).includes(query));
}

function label(p) {
  return `${p.name} · ${p.size}`;
}

function announce(text) {
  $("announcer").textContent = text;
}

// כמות להצגה: "3" ליחידות, "1.5 ק"ג" למוצר במשקל
function qtyText(barcode, qty) {
  return byBarcode.get(barcode)?.unit === "kg" ? `${qty} ק"ג` : String(qty);
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
    (p) => (!activeCategory || p.category === activeCategory) && (!query || matches(p, query))
  );
  const list = $("products");
  list.replaceChildren();

  // כרטיס לכל מוצר: תמונה גדולה עם "+" בפינה. כל התמונה היא כפתור אחד שמוסיף לסל
  for (const p of shown) {
    const inBasket = basket.has(p.barcode);
    const li = el("li", { class: inBasket ? "product-card in-basket" : "product-card" });
    const btn = el("button", {
      type: "button",
      class: "product-add",
      "data-action": "add",
      "data-barcode": p.barcode,
      "aria-label": inBasket ? `${p.name} כבר בסל` : `הוסף ${p.name} לסל`,
      // מוצר שכבר בסל: הכפתור נשאר בפוקוס (לא disabled), כדי שאפשר יהיה להמשיך בגריד
      "aria-disabled": inBasket ? "true" : false,
    });
    btn.append(
      el("img", { src: p.image, alt: p.name, loading: "lazy", width: 200, height: 200 }),
      el("span", { class: "add-badge", "aria-hidden": "true" }, inBasket ? "✓" : "+")
    );
    const info = el("div", { class: "product-info" });
    info.append(
      el("span", { class: "item-name" }, p.name),
      el("span", { class: "item-meta" }, [p.size, p.manufacturer].filter(Boolean).join(" · "))
    );
    li.append(btn, info);
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
      $("search-clear").hidden = true;
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
      el("span", { class: p.unit === "kg" ? "qty qty-kg" : "qty", "aria-label": `כמות: ${qtyText(barcode, qty)}` }, qtyText(barcode, qty)),
      el("button", { type: "button", class: "btn-qty", "data-action": "dec", "data-barcode": barcode,
        "aria-label": `הקטן כמות של ${p.name}`, disabled: qty <= basket.minQty(barcode) }, "−"),
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
  compare.textContent = items.length ? `השווה (${countText(items.length)})` : "השווה (סל ריק)";
  $("btn-clear").disabled = items.length === 0;
}

function render() {
  renderProducts();
  renderBasket();
}

// אחרי ציור מחדש מחזירים את הפוקוס לכפתור המתאים, כדי שאפשר יהיה להמשיך עם המקלדת.
// בלי גלילה: המסך נשאר איפה שהמשתמש היה
function focusButton(action, barcode) {
  const btn = document.querySelector(`[data-action="${action}"][data-barcode="${barcode}"]`);
  if (btn && !btn.disabled) btn.focus({ preventScroll: true });
  return Boolean(btn && !btn.disabled);
}

function handleClick(event) {
  const btn = event.target.closest("button[data-action]");
  if (!btn) return;
  const { action, barcode } = btn.dataset;
  const name = byBarcode.get(barcode)?.name;

  if (action === "add") {
    // הוספה משאירה את המשתמש בגריד של המוצרים, על אותו כרטיס
    if (basket.has(barcode)) return announce(`${name} כבר בסל`);
    basket.add(barcode);
    render();
    announce(`${name} נוסף לסל. בסל ${countText(basket.items().length)}`);
    focusButton("add", barcode);
  } else if (action === "inc" || action === "dec") {
    basket.changeQty(barcode, action === "inc" ? 1 : -1);
    render();
    const qty = basket.items().find((it) => it.barcode === barcode).qty;
    announce(`כמות של ${name}: ${qtyText(barcode, qty)}`);
    if (!focusButton(action, barcode)) focusButton(action === "inc" ? "dec" : "inc", barcode);
  } else if (action === "remove") {
    basket.remove(barcode);
    render();
    announce(`${name} הוסר מהסל. בסל ${countText(basket.items().length)}`);
    if (!focusButton("add", barcode)) $("search").focus();
  }
}

// מציג מסך אחד ומסתיר את השאר.
// כל מעבר מסך נרשם בהיסטוריה של הדפדפן, כדי שכפתור "חזרה" של הטלפון יחזור למסך הקודם
// ולא יצא מהאתר. nav: "push" מסך חדש, "replace" במקום הנוכחי, "none" (כשחוזרים בהיסטוריה).
function showScreen(id, nav = "push") {
  document.querySelectorAll(".screen").forEach((s) => (s.hidden = s.id !== id));
  window.scrollTo(0, 0);
  const depth = history.state?.depth ?? 0;
  if (nav === "push" && history.state?.screen !== id) history.pushState({ screen: id, depth: depth + 1 }, "");
  else if (nav === "replace") history.replaceState({ screen: id, depth }, "");
}

// חזרה לבניית הסל: אחורה בהיסטוריה עד המסך הראשון, כדי שהיסטוריה לא תתארך
function goBuild() {
  const depth = history.state?.depth ?? 0;
  if (depth > 0) history.go(-depth);
  else showScreen("screen-build", "replace");
}

// כפתור "חזרה" (או "קדימה") של הדפדפן. מסך שאין לו נתונים (למשל אחרי רענון): בניית הסל
function handlePopState(event) {
  const screen = event.state?.screen ?? "screen-build";
  if (screen === "screen-subs" && subsPairs.length) {
    showScreen("screen-subs", "none");
    renderSubs(subsPairs);
    $("subs-title").focus();
  } else if (screen === "screen-results" && lastItems.length) {
    showResults("none");
  } else {
    showScreen("screen-build", "none");
    render();
    $("btn-compare").focus();
  }
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

// מחירים של רשת שלא התעדכנו יותר מיומיים נחשבים ישנים
const STALE_MS = 2 * 24 * 60 * 60 * 1000;

// התאריך של העדכון האחרון בכל רשת, מהשורות של הסל: chain_id -> loaded_at
function updatedByChain(rows) {
  const latest = new Map();
  for (const r of rows) {
    if (r.loaded_at && !(latest.get(r.chain_id) >= r.loaded_at)) latest.set(r.chain_id, r.loaded_at);
  }
  return latest;
}

function renderResults({ results, notFound }, counted) {
  const list = $("results");
  list.replaceChildren();
  const updated = updatedByChain(lastRows);
  // החיסכון: ההפרש בין הזולה ליקרה, רק בין רשתות שהסל מלא בהן
  const complete = results.filter((r) => r.complete);
  const saving = complete.length > 1
    ? Math.max(...complete.map((r) => r.total)) - Math.min(...complete.map((r) => r.total)) : 0;
  for (const r of results) {
    const li = el("li", { class: r.cheapest ? "card result cheapest" : "card result" });
    const head = el("div", { class: "result-head" });
    // הלוגו דקורטיבי: השם נשאר לידו. לוגו שלא נטען מוסתר
    if (r.chain.logo) {
      const logo = el("img", { class: "chain-logo", src: r.chain.logo, alt: "", width: 96, height: 28 });
      logo.addEventListener("error", () => { logo.hidden = true; });
      head.append(logo);
    }
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
    if (r.cheapest && saving > 0) {
      li.append(el("p", { class: "result-saving" }, `חיסכון של ${formatPrice(saving)} לעומת הרשת היקרה`));
    }
    const at = updated.get(r.chain.chain_id);
    if (at && Date.now() - new Date(at) > STALE_MS) {
      li.append(el("p", { class: "result-updated stale" }, `⚠ מחירים ישנים: עודכנו לאחרונה ב-${formatDate(at)}`));
    } else if (at) {
      li.append(el("p", { class: "result-updated" }, `המחירים עודכנו ב-${formatDate(at)}`));
    }
    // מוצר במשקל: הכמות והמחיר לק"ג ברשת הזו
    for (const { barcode, qty, perKg } of r.weighted) {
      li.append(el("p", { class: "result-weighted" },
        `${byBarcode.get(barcode).name} ${qtyText(barcode, qty)} · ${formatPrice(perKg)} לק"ג`));
    }
    if (r.weighted.length) li.append(el("p", { class: "result-note" }, "מוצרים במשקל: מחיר משוער לפי ק\"ג"));
    for (const { barcode, item } of r.substituted) {
      li.append(el("p", { class: "result-missing" }, `⇄ חלופה: ${item.item_name} במקום ${byBarcode.get(barcode).name}`));
    }
    if (!r.complete) li.append(el("p", { class: "result-missing" }, `חסר ברשת: ${productNames(r.missing)}`));
    li.append(breakdown(r));
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

// פירוט המחירים ברשת: שורה לכל מוצר, סגור עד לחיצה
function breakdown(r) {
  const details = el("details", { class: "breakdown" });
  details.append(el("summary", {}, "פירוט מחירים"));
  const ul = el("ul", { class: "breakdown-list" });
  for (const { barcode, qty, amount, sub } of r.lines) {
    const li = el("li", amount == null ? { class: "missing" } : {});
    const name = sub ? `⇄ ${sub.item_name}` : byBarcode.get(barcode).name;
    li.append(
      el("span", { class: "breakdown-name" }, `${name} × ${qtyText(barcode, qty)}`),
      el("span", { class: "breakdown-price" }, amount == null ? "חסר ברשת" : formatPrice(amount))
    );
    ul.append(li);
  }
  details.append(ul);
  return details;
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

function showResults(nav = "push") {
  showScreen("screen-results", nav);
  $("results-status").textContent = "";
  $("results-title").focus();

  const comparison = compareBasket(lastItems, byBarcode, chains, lastRows, approvedSubstitutes());
  const { results, notFound } = comparison;
  renderResults(comparison, lastItems.length - notFound.length);
  $("not-found-section").hidden = false;
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
    for (const line of subPriceLines(s.item, p)) li.append(el("p", { class: "sub-price" }, line));
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

// גודל להצגה: { amount: 1500, base: "ml" } -> "1.5 ליטר"
function sizeText({ amount, base }) {
  if (amount >= 1000) return `${+(amount / 1000).toFixed(2)} ${base === "g" ? 'ק"ג' : "ליטר"}`;
  return `${+amount.toFixed(1)} ${base === "g" ? "גרם" : 'מ"ל'}`;
}

// המחיר של החלופה, הגודל שלה, ומחיר ל-100 גרם או 100 מ"ל מול המוצר המקורי ברשת הזולה ביותר שיש בה אותו.
// גודל שלא מזוהה: רק המחיר, בלי השוואה.
function subPriceLines(item, product) {
  const parts = [`מחיר: ${formatPrice(Math.round(Number(item.price) * 100))}`];
  const size = parseChainSize(item.quantity, item.unit);
  const original = parseSizeText(product.size);
  if (size) parts.push(`גודל: ${sizeText(size)} (המקורי: ${product.size})`);
  if (!size || !original || size.base !== original.base) return parts;

  const per = size.base === "g" ? "ל-100 גרם" : 'ל-100 מ"ל';
  parts.push(`מחיר ${per}: ${formatPrice(unitPrice(item.price, size))}`);
  const codes = new Set([product.barcode, ...Object.values(product.chain_codes || {})]);
  const prices = lastRows.filter((r) => codes.has(r.item_code) && r.price != null).map((r) => Number(r.price));
  if (prices.length) parts.push(`המקורי ברשת אחרת, ${per}: ${formatPrice(unitPrice(Math.min(...prices), original))}`);
  return parts;
}

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
    showResults("replace");
    return;
  }

  // מסך הטעינה של התוצאות מוחלף במסך החלופות, כדי ש"חזרה" ממנו תגיע לבניית הסל
  showScreen("screen-subs", "replace");
  $("subs").replaceChildren();
  $("btn-to-results").disabled = true;
  $("subs-status").textContent = "מחפשים חלופות ברשתות...";
  $("subs-title").focus();
  // למוצרים במשקל אין חלופות בגרסה הזו: הם לא נשלחים לבדיקה, והכרטיס שלהם "חסר ברשת"
  const ask = subsPairs.filter(({ barcode }) => byBarcode.get(barcode).unit !== "kg");
  try {
    if (ask.length) suggestions = await findSubstitutes(ask.map(({ chain, barcode }) => ({ chain_id: chain.chain_id, barcode })));
    $("subs-status").textContent = "";
  } catch (err) {
    $("subs-status").textContent = err.rateLimited
      ? "היו הרבה השוואות בזמן קצר. אפשר להמשיך לתוצאות עם סל חלקי, ולנסות חלופות שוב בעוד כמה דקות."
      : "לא הצלחנו לבדוק חלופות כרגע. אפשר להמשיך לתוצאות עם סל חלקי.";
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
      loadJson("data/products.json?v=46"),
      loadJson("data/chains.json?v=13"),
    ]);
  } catch {
    $("products-status").textContent = "לא הצלחנו לטעון את רשימת המוצרים. נסו לרענן את הדף.";
    return;
  }

  byBarcode = new Map(products.map((p) => [p.barcode, p]));
  basket.load(new Set(byBarcode.keys()), new Set(products.filter((p) => p.unit === "kg").map((p) => p.barcode)));
  renderCategories();
  render();

  // החיפוש תמיד על כל המוצרים: הקלדה מבטלת את סימון הקטגוריה
  $("search").addEventListener("input", () => {
    if (activeCategory) {
      activeCategory = null;
      renderCategories();
    }
    $("search-clear").hidden = !$("search").value;
    renderProducts();
  });
  // ה-X של הדפדפן לא מופיע בכל טלפון, ולכן כפתור משלנו
  $("search-clear").addEventListener("click", () => {
    $("search").value = "";
    $("search-clear").hidden = true;
    renderProducts();
    $("search").focus();
  });
  $("products").addEventListener("click", handleClick);
  $("basket").addEventListener("click", handleClick);
  $("btn-compare").addEventListener("click", compare);
  $("subs").addEventListener("click", handleDecision);
  $("btn-to-results").addEventListener("click", () => showResults());
  $("btn-subs-back").addEventListener("click", goBuild);
  // אישור בתוך הדף (לחיצה שנייה), כי confirm() חסום בחלק מהדפדפנים המובנים באפליקציות
  let clearTimer = null;
  const resetClear = () => {
    clearTimeout(clearTimer);
    clearTimer = null;
    $("btn-clear").textContent = "נקה סל";
    $("btn-clear").classList.remove("confirming");
  };
  $("btn-clear").addEventListener("click", () => {
    if (!clearTimer) {
      $("btn-clear").textContent = "בטוח? לחץ שוב";
      $("btn-clear").classList.add("confirming");
      announce("לחץ שוב על הכפתור כדי לנקות את הסל");
      clearTimer = setTimeout(resetClear, 4000);
      return;
    }
    resetClear();
    basket.clear();
    render();
    announce("הסל רוקן");
    $("search").focus();
  });
  $("btn-back").addEventListener("click", goBuild);
  history.replaceState({ screen: "screen-build", depth: 0 }, "");
  window.addEventListener("popstate", handlePopState);
}

init();
