// מעבר בין מסכים: "בניית סל", "הסל שלי", "המלצת חלופות" ו"פלט תוצאות"
import * as basket from "./basket.js?v=12";
import { fetchAutoBasket, fetchChainUpdates, fetchMatches, fetchPrices, fetchPromos } from "./prices.js?v=17";
import { allCodes, codeIn, compareBasket, formatPrice, parseChainSize, parseSizeText, splitBasket, splitUnavailable, unitPrice } from "./compare.js?v=17";
import { findSubstitutes } from "./substitutes.js?v=12";
import * as auth from "./auth.js?v=1";
import * as community from "./community.js?v=3";

const $ = (id) => document.getElementById(id);

let products = [];
// כל הסניפים מ-chains.json, והסניפים של העיר שנבחרה. ההשוואה רק מול הסניפים של העיר
let allChains = [];
let chains = [];
let byBarcode = new Map();
let matchesReady = Promise.resolve();
let activeCategory = null;
let autoBarcodes = [];

// ההשוואה האחרונה: הסל, המחירים מ-Supabase, וההצעות לחלופות ("chain:barcode" -> הצעה)
let lastItems = [];
let lastRows = [];
// המבצעים בתוקף של הסל (מיילסטון 14). null: לא נטענו, ואז מחירי מדף בלבד
let lastPromos = null;
// מוצרים שהרשת הפסיקה למכור ("chain_id:item_code"), והעדכון האחרון של כל רשת (chain_id -> loaded_at)
let lastUnavailable = new Set();
let lastUpdates = new Map();
let suggestions = new Map();
// דיווחי "מצאתי זול יותר" מאושרים ובתוקף: "chain_id:barcode" -> מחיר בשקלים
let lastReports = new Map();
// "פופולריים השבוע" בעיר שנבחרה (ברקודים), והאם כבר נספרה קנייה במונה בהשוואה הנוכחית ("chain" / "split")
let popularBarcodes = [];
let lastSaved = null;

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
      // לחיצה על מוצר שכבר בסל מוציאה אותו מהסל
      "aria-label": inBasket ? `${p.name} בסל. לחצו כדי להסיר` : `הוסף ${p.name} לסל`,
      "aria-pressed": String(inBasket),
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
  $("request-hint").hidden = Boolean(shown.length) || !query;
}

// ---- פופולריים השבוע ----

const POPULAR_COUNT = 8;
const ADDS_KEY = "cartwise-adds";
const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

// הוספה ידנית לסל נשלחת ל-Supabase בלי זהות: עיר וברקוד.
// אותו מוצר מאותו דפדפן נספר פעם בשבוע, כדי שהוספה והסרה חוזרות לא ינפחו את הדירוג
function trackAdd(barcode) {
  const city = $("city").value;
  const key = `${city}:${barcode}`;
  const now = Date.now();
  let seen = {};
  try {
    seen = JSON.parse(localStorage.getItem(ADDS_KEY)) || {};
  } catch {
    seen = {};
  }
  for (const k of Object.keys(seen)) if (!(now - seen[k] < WEEK_MS)) delete seen[k];
  if (seen[key]) return;
  seen[key] = now;
  try {
    localStorage.setItem(ADDS_KEY, JSON.stringify(seen));
  } catch {
    // localStorage לא זמין: נספר בכל זאת
  }
  community.logBasketAdd(city, barcode).catch(() => {});
}

// שורה של 8 כרטיסים קטנים. לחיצה מוסיפה לסל, ולחיצה נוספת מסירה, כמו בגריד
function renderPopular() {
  const list = $("popular");
  list.replaceChildren();
  $("popular-section").hidden = !popularBarcodes.length;
  for (const b of popularBarcodes) {
    const p = byBarcode.get(b);
    const inBasket = basket.has(b);
    const li = el("li", { class: inBasket ? "popular-card in-basket" : "popular-card" });
    const btn = el("button", {
      type: "button",
      class: "popular-add",
      "data-action": "pop",
      "data-barcode": b,
      "aria-label": inBasket ? `${p.name} בסל. לחצו כדי להסיר` : `הוסף ${p.name} לסל`,
      "aria-pressed": String(inBasket),
    });
    btn.append(
      el("img", { src: p.image, alt: "", loading: "lazy", width: 96, height: 96 }),
      el("span", { class: "add-badge", "aria-hidden": "true" }, inBasket ? "✓" : "+"),
      el("span", { class: "popular-name" }, p.name)
    );
    li.append(btn);
    list.append(li);
  }
}

// 8 המוצרים שנוספו הכי הרבה ב-7 הימים האחרונים בעיר. כשאין מספיק, משלימים מהסל האוטומטי של העיר.
// טעינה שנכשלה מסתירה את השורה. החלפת עיר בזמן טעינה: רק התשובה האחרונה מוצגת
let popularRequest = 0;
async function loadPopular() {
  const request = ++popularRequest;
  let top = null;
  try {
    top = (await community.fetchPopular($("city").value)).filter((b) => byBarcode.has(b)).slice(0, POPULAR_COUNT);
  } catch {
    top = null;
  }
  if (request !== popularRequest) return;
  if (top) {
    for (const b of autoBarcodes) {
      if (top.length >= POPULAR_COUNT) break;
      if (!top.includes(b)) top.push(b);
    }
  }
  popularBarcodes = top ?? [];
  renderPopular();
}

// כפתור קטגוריה מסנן את הרשימה. לחיצה נוספת על אותה קטגוריה מבטלת את הסינון.
// שתי שורות: בעליונה, ליד החיפוש, "שתייה", "מזון יבש" ו"לחם". בתחתונה שאר הקטגוריות.
const TOP_CATEGORIES = ["שתייה", "מזון יבש", "לחם"];

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

  const n = items.length;
  $("basket-count").textContent = n ? countText(n) : "הסל ריק";
  $("basket-empty").hidden = n > 0;
  $("btn-to-basket").textContent = `הסל שלי (${n})`;
  $("btn-to-basket").setAttribute("aria-label", `הסל שלי, ${n ? countText(n) : "ריק"}`);

  // "השווה" ו"נקה סל" רק בדף "הסל שלי"
  document.querySelectorAll(".js-compare").forEach((btn) => {
    btn.disabled = n === 0;
    btn.textContent = n ? `השווה (${countText(n)})` : "השווה (סל ריק)";
  });
  document.querySelectorAll(".js-clear").forEach((btn) => (btn.disabled = n === 0));
}

function render() {
  renderPopular();
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

  const removeIndex = action === "remove"
    ? [...document.querySelectorAll('#basket [data-action="remove"]')].indexOf(btn) : 0;

  if (action === "add" || action === "pop") {
    // לחיצה מוסיפה, לחיצה נוספת מסירה. המשתמש נשאר בגריד (או בשורת הפופולריים), על אותו כרטיס
    const had = basket.has(barcode);
    if (had) basket.remove(barcode);
    else {
      basket.add(barcode);
      trackAdd(barcode);
    }
    render();
    announce(`${name} ${had ? "הוסר מהסל" : "נוסף לסל"}. בסל ${countText(basket.items().length)}`);
    focusButton(action, barcode);
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
    // הפוקוס עובר ל"הסר" של המוצר הבא בסל, ואם אין, לכותרת הדף
    const removes = [...document.querySelectorAll('#basket [data-action="remove"]')];
    (removes[0] ? removes[Math.min(removeIndex, removes.length - 1)] : $("basket-title")).focus({ preventScroll: true });
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

// מעבר לדף "הסל שלי", עם רישום בהיסטוריה: "חזרה" של הטלפון מחזיר לגריד
function goBasket() {
  showScreen("screen-basket");
  render();
  $("basket-title").focus();
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
  } else if (screen === "screen-basket") {
    showScreen("screen-basket", "none");
    render();
    $("basket-title").focus();
  } else {
    showScreen("screen-build", "none");
    render();
    $("build-title").focus({ preventScroll: true });
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

// האם המוצר לא זמין ברשת: הרשת הפסיקה למכור אותו, ולא סתם אין אותו
function isUnavailable(chain, barcode) {
  return lastUnavailable.has(`${chain.chain_id}:${codeIn(chain, byBarcode.get(barcode))}`);
}

// "חסר" או "לא זמין" לכל מוצר שאין לו מחיר ברשת
function missingWord(chain, barcode) {
  return isUnavailable(chain, barcode) ? "לא זמין" : "חסר ברשת";
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
  const updated = lastUpdates.size ? lastUpdates : updatedByChain(lastRows);
  // החיסכון: ההפרש בין הזולה ליקרה, רק בין רשתות שהסל מלא בהן
  const complete = results.filter((r) => r.complete);
  const saving = complete.length > 1
    ? Math.max(...complete.map((r) => r.total)) - Math.min(...complete.map((r) => r.total)) : 0;
  for (const r of results) {
    const li = el("li", { class: r.cheapest ? "card result cheapest" : r.cheapestPartial ? "card result cheapest-partial" : "card result" });
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
    if (r.promoSaving > 0) head.append(el("span", { class: "tag tag-promo" }, "מבצע!"));
    if (r.cheapestPartial) head.append(el("span", { class: "tag tag-cheapest-partial" }, "✓ הזול מבין החלקיים"));
    if (!r.complete) head.append(el("span", { class: "tag tag-partial" }, "חלקי"));
    li.append(
      head,
      el("p", { class: "chain-store" }, r.chain.store_name),
      el("p", { class: "price" }, formatPrice(r.total)),
      el("p", { class: r.complete ? "result-status" : "result-status partial" }, statusText(r, counted))
    );
    if (r.promoSaving > 0) li.append(el("p", { class: "result-promo" }, `חסכת במבצעים ${formatPrice(r.promoSaving)}`));
    if (r.cheapest && saving > 0) {
      li.append(el("p", { class: "result-saving" }, `חיסכון של ${formatPrice(saving)} לעומת הרשת היקרה`));
      li.append(boughtButton("קניתי כאן ✓", { amount: saving, kind: "chain", chainId: r.chain.chain_id }));
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
    const gone = r.missing.filter((b) => isUnavailable(r.chain, b));
    const absent = r.missing.filter((b) => !isUnavailable(r.chain, b));
    if (absent.length) li.append(el("p", { class: "result-missing" }, `חסר ברשת: ${productNames(absent)}`));
    if (gone.length) li.append(el("p", { class: "result-missing" }, `לא זמין ברשת (הרשת הפסיקה למכור): ${productNames(gone)}`));
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

// כרטיס "סל מפוצל": הסל הזול ביותר בשתי רשתות. split: מ-splitBasket, null מסתיר את הכרטיס
// maxComplete: הסל היקר ביותר מבין הרשתות עם סל מלא (באגורות). ממנו נספר החיסכון במונה
function renderSplit(split, maxComplete = 0) {
  const box = $("split");
  box.replaceChildren();
  box.hidden = !split;
  if (!split) return;
  const names = split.parts.map((p) => p.chain.name).join(" + ");
  const head = el("div", { class: "result-head" });
  head.append(el("h2", { class: "chain-name" }, "סל מפוצל: 2 רשתות"), el("span", { class: "tag tag-split" }, "⇆ הכי זול"));
  box.append(
    head,
    el("p", { class: "chain-store" }, names),
    el("p", { class: "price" }, formatPrice(split.total)),
    el("p", { class: "result-saving" }, split.base
      ? `חיסכון של ${formatPrice(split.saving)} לעומת הסל הזול ברשת אחת (${split.base.name})`
      : "משלים את כל הסל בשתי רשתות")
  );
  const vsExpensive = maxComplete - split.total;
  if (vsExpensive > 0) {
    box.append(
      el("p", { class: "bought-note" }, `ייספר במונה: חיסכון של ${formatPrice(vsExpensive)} לעומת הרשת היקרה`),
      boughtButton("קניתי בסל המפוצל ✓", { amount: vsExpensive, kind: "split", chainId: null })
    );
  }
  for (const part of split.parts) {
    const sec = el("div", { class: "split-part" });
    const ph = el("div", { class: "result-head" });
    if (part.chain.logo) {
      const logo = el("img", { class: "chain-logo", src: part.chain.logo, alt: "", width: 96, height: 28 });
      logo.addEventListener("error", () => { logo.hidden = true; });
      ph.append(logo);
    }
    ph.append(el("h3", { class: "chain-name" }, part.chain.name), el("span", { class: "split-subtotal" }, formatPrice(part.total)));
    const ul = el("ul", { class: "breakdown-list" });
    for (const { barcode, qty, amount, promo } of part.lines) {
      const li = el("li");
      li.append(
        el("span", { class: "breakdown-name" }, `${byBarcode.get(barcode).name} × ${qtyText(barcode, qty)}`),
        el("span", { class: "breakdown-price" }, formatPrice(amount))
      );
      const tags = promoTags(promo, null, null);
      if (tags) li.append(tags);
      ul.append(li);
    }
    // רשימת המוצרים סגורה עד לחיצה, כמו "פירוט מחירים"
    const details = el("details", { class: "breakdown" });
    details.append(el("summary", {}, `מה קונים כאן (${countText(part.lines.length)})`), ul);
    sec.append(ph, el("p", { class: "chain-store" }, part.chain.store_name), details);
    box.append(sec);
  }
}

// תגיות המבצע של שורה: "מבצע!" עם התיאור מהקובץ, "קנו ..." למבצע כמות שעוד לא חל, ו"למועדון"
// הטקסט נבנה מהמספרים בקובץ, ולא מהתיאור החופשי של הרשת, כדי שיהיה אחיד בכל הרשתות
function dealText(p) {
  const n = Number(p.min_qty) || 1;
  const nis = (v) => formatPrice(Math.round(Number(v) * 100));
  let text = p.kind === "bundle" ? `${n} ב-${nis(p.bundle_price)}`
    : p.kind === "percent" ? (n > 1 ? `ה-${n} ב-${Number(p.discount_rate)}% הנחה` : `${Number(p.discount_rate)}% הנחה`)
    : n > 1 ? `${nis(p.bundle_price)} ליחידה, בקנייה של ${n}` : `${nis(p.bundle_price)} ליחידה`;
  if (p.max_qty) text += `, עד ${Number(p.max_qty)} יחידות`;
  return text;
}

function promoTags(promo, hint, club) {
  if (!promo && !hint && !club) return null;
  const box = el("span", { class: "breakdown-promo" });
  if (promo) box.append(el("span", { class: "tag tag-promo" }, "מבצע!"), ` ${dealText(promo)}`);
  else if (hint) box.append(el("span", { class: "tag tag-promo" }, "מבצע!"), ` ${dealText(hint)}. כדאי להוסיף לסל`);
  if (club) box.append(el("span", { class: "tag tag-club" }, "למועדון"), ` ${dealText(club)}`);
  return box;
}

// פירוט המחירים ברשת: שורה לכל מוצר, סגור עד לחיצה
// מחיר מדווח ומאושר, רק כשהוא עדיין נמוך מהמחיר הרשמי. לא משנה את סכום הסל
function officialPrice(chain, product) {
  const code = codeIn(chain, product);
  const row = lastRows.find((x) => x.chain_id === chain.chain_id && x.item_code === code);
  const value = product.unit === "kg" ? row?.price_per_kg : row?.price;
  return value == null ? null : Number(value);
}

function reportedPrice(chain, barcode) {
  const price = lastReports.get(`${chain.chain_id}:${barcode}`);
  const product = byBarcode.get(barcode);
  const official = officialPrice(chain, product);
  if (price == null || official == null || price >= official) return "";
  const per = product.unit === "kg" ? ' לק"ג' : "";
  return `דווח: ${formatPrice(Math.round(price * 100))}${per} · מאושר ע״י מנהל`;
}

function breakdown(r) {
  const details = el("details", { class: "breakdown" });
  details.append(el("summary", {}, "פירוט מחירים"));
  const ul = el("ul", { class: "breakdown-list" });
  for (const { barcode, qty, amount, regular, sub, promo, hint, club } of r.lines) {
    const li = el("li", amount == null ? { class: "missing" } : {});
    const name = sub ? `⇄ ${sub.item_name}` : byBarcode.get(barcode).name;
    const price = el("span", { class: "breakdown-price" });
    if (amount == null) price.append(missingWord(r.chain, barcode));
    else if (promo) {
      // מחיר המדף מחוק, ולידו המחיר אחרי המבצע
      price.append(el("s", { class: "breakdown-regular" }, formatPrice(regular)), " ", formatPrice(amount));
    } else price.append(formatPrice(amount));
    li.append(el("span", { class: "breakdown-name" }, `${name} × ${qtyText(barcode, qty)}`), price);
    const tags = promoTags(promo, hint, club);
    if (tags) li.append(tags);
    const reported = !sub && amount != null && reportedPrice(r.chain, barcode);
    if (reported) li.append(el("span", { class: "breakdown-report" }, reported));
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

  const comparison = compareBasket(lastItems, byBarcode, chains, lastRows, approvedSubstitutes(), lastPromos ?? new Map());
  const { results, notFound } = comparison;
  renderResults(comparison, lastItems.length - notFound.length);
  const split = splitBasket(lastItems, byBarcode, chains, lastRows, lastPromos ?? new Map());
  $("price-note").textContent = lastPromos
    ? "כולל מבצעים לכל הלקוחות. מבצעי מועדון מסומנים ולא נכללים במחיר"
    : "מחירי מדף, לא כולל מבצעים";
  const complete = results.filter((r) => r.complete);
  renderSplit(split, complete.length ? Math.max(...complete.map((r) => r.total)) : 0);
  $("not-found-section").hidden = false;
  const best = results.find((r) => r.cheapest);
  const lost = !notFound.length ? ""
    : notFound.length === 1 ? ". מוצר אחד לא נמצא באף רשת" : `. ${notFound.length} מוצרים לא נמצאו באף רשת`;
  const bestPartial = results.find((r) => r.cheapestPartial);
  const partialText = !bestPartial ? ""
    : `. הזול מבין החלקיים: ${bestPartial.chain.name}, ${formatPrice(bestPartial.total)}, ${statusText(bestPartial, 0).replace("חלקי, ", "")}`;
  if (best) announce(`הזול ביותר: ${best.chain.name}, ${formatPrice(best.total)}${partialText}${lost}`);
  else if (bestPartial) announce(`אין רשת עם סל מלא${partialText}${lost}`);
  else if (notFound.length < lastItems.length) announce(`התוצאות מוכנות. אין רשת עם סל מלא${lost}`);
  else announce("אף מוצר בסל לא נמצא ברשתות");
  if (split) announce(`סל מפוצל: ${split.parts.map((p) => p.chain.name).join(" ו")}, ${formatPrice(split.total)}`);
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
  // "אשר הכל" ו"דחה הכל": רק כשיש לפחות חלופה אחת
  const offered = pairs.filter(({ chain, barcode }) => suggestions.get(`${chain.chain_id}:${barcode}`)?.item);
  $("subs-bulk").hidden = !offered.length;
  const all = (v) => offered.length > 0 && offered.every(({ chain, barcode }) => basket.decision(chain.chain_id, barcode) === v);
  $("btn-approve-all").setAttribute("aria-pressed", String(all("approved")));
  $("btn-reject-all").setAttribute("aria-pressed", String(all("rejected")));
  for (const { chain, barcode } of pairs) {
    const s = suggestions.get(`${chain.chain_id}:${barcode}`);
    const p = byBarcode.get(barcode);
    const li = el("li", { class: "card sub" });
    const head = el("div", { class: "result-head" });
    head.append(el("h3", { class: "chain-name" }, chain.name));
    head.append(s?.item
      ? el("span", { class: "tag tag-sub" }, "⇄ חלופה")
      : el("span", { class: "tag tag-missing" }, missingWord(chain, barcode)));
    li.append(head, el("p", { class: "sub-missing" }, `${missingWord(chain, barcode)}: ${label(p)}`));

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

// החלטה אחת לכל החלופות שהוצעו
function decideAll(value) {
  let n = 0;
  for (const { chain, barcode } of subsPairs) {
    if (!suggestions.get(`${chain.chain_id}:${barcode}`)?.item) continue;
    basket.decide(chain.chain_id, barcode, value);
    n++;
  }
  renderSubs(subsPairs);
  announce(value === "approved"
    ? (n === 1 ? "החלופה אושרה" : `כל ${n} החלופות אושרו`)
    : (n === 1 ? "החלופה נדחתה" : `כל ${n} החלופות נדחו`));
}

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
  const codes = new Set(allCodes(product));
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
  lastSaved = null;
  showScreen("screen-results");
  $("results").replaceChildren();
  $("not-found-section").hidden = true;
  $("split").hidden = true;
  $("results-status").textContent = "מחשבים את עלות הסל...";
  $("results-title").focus();
  $("results-loader").hidden = false;
  // העגלה מוצגת לפחות שנייה, כדי שלא תהבהב כשהמחירים מגיעים מהר
  const minShow = new Promise((r) => setTimeout(r, 1000));

  try {
    // התאמות המוצרים נטענות ברקע מתחילת הדף. אם נכשלו, ההשוואה כמו קודם
    await matchesReady;
    const codes = [...new Set(items.flatMap(({ barcode }) => allCodes(byBarcode.get(barcode))))];
    const ids = chains.map((c) => c.chain_id);
    // דיווחים מאושרים: אם נכשל, ההשוואה ממשיכה בלעדיהם
    // מבצעים: אם נכשל, ההשוואה ממשיכה במחירי מדף
    const [rows, updates, reports, promos] = await Promise.all([
      fetchPrices(codes, ids),
      fetchChainUpdates(ids),
      community.fetchApprovedReports(ids).catch(() => new Map()),
      fetchPromos(codes, ids).catch(() => null),
      minShow,
    ]);
    lastReports = reports;
    lastPromos = promos;
    // מוצר שהרשת הפסיקה למכור לא נכנס לחישוב, ומוצג "לא זמין"
    dropReturnedMatches(rows);
    ({ fresh: lastRows, unavailable: lastUnavailable } = splitUnavailable(rows, updates));
    lastUpdates = updates;
    lastItems = items;
  } catch {
    $("results-loader").hidden = true;
    $("results-status").textContent = "לא הצלחנו לטעון את המחירים. בדקו את החיבור ונסו שוב.";
    return;
  }

  $("results-loader").hidden = true;

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
  $("subs-bulk").hidden = true;
  $("btn-to-results").disabled = true;
  $("subs-status").textContent = "מחפשים חלופות ברשתות...";
  $("subs-loader").hidden = false;
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
  $("subs-loader").hidden = true;
  renderSubs(subsPairs);
  $("btn-to-results").disabled = false;
  const offered = [...suggestions.values()].filter((s) => s.item).length;
  announce(offered ? `נמצאו ${offered === 1 ? "חלופה אחת" : `${offered} חלופות`}. אשרו או דחו כל חלופה` : "לא נמצאו חלופות");
}

// התאמה של סוכן התאמת המוצרים: המוצר בסניף עם קוד אחר. נשמרת על המוצר ב-match_codes (chain_id -> item_code)
function applyMatches(list) {
  for (const m of list) {
    const p = byBarcode.get(m.barcode);
    if (!p || p.unit === "kg") continue;
    p.match_codes = { ...(p.match_codes || {}), [m.chain_id]: m.item_code };
  }
}

// הברקוד המקורי חזר לסניף: הוא קודם להתאמה
function dropReturnedMatches(rows) {
  const has = new Set(rows.map((r) => `${r.chain_id}:${r.item_code}`));
  for (const p of byBarcode.values()) {
    if (!p.match_codes) continue;
    for (const chainId of Object.keys(p.match_codes)) {
      if (has.has(`${chainId}:${p.barcode}`)) delete p.match_codes[chainId];
    }
  }
}

async function loadJson(path) {
  const res = await fetch(path);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

async function refreshAutoBasket() {
  autoBarcodes = await loadAutoBasket();
  // טקסט קצר, כדי שייכנס בשורה אחת ליד "נקה סל". העיר נשמעת בקורא המסך
  $("btn-auto").textContent = `🛒 סל אוטומטי (${autoBarcodes.length})`;
  $("btn-auto").setAttribute("aria-label", `סל אוטומטי ל${$("city").value}: ${countText(autoBarcodes.length)}`);
  $("btn-auto").hidden = autoBarcodes.length === 0;
}

async function loadAutoBasket() {
  try {
    const list = (await fetchAutoBasket($("city").value)).filter((b) => byBarcode.has(b));
    if (list.length) return list;
  } catch {
    // ממשיכים לקובץ הגיבוי
  }
  try {
    const backup = await loadJson("data/auto-basket.json?v=1");
    return (backup.barcodes ?? []).filter((b) => byBarcode.has(b));
  } catch {
    return [];
  }
}

// העיר נשמרת בדפדפן. אם אין שמירה, או שהעיר כבר לא קיימת: העיר הראשונה ב-chains.json
const CITY_KEY = "cartwise-city";
function setupCity() {
  const cities = [...new Set(allChains.map((c) => c.city))];
  let saved = null;
  try {
    saved = localStorage.getItem(CITY_KEY);
  } catch {
    // localStorage לא זמין: העיר לא נשמרת
  }
  const select = $("city");
  select.replaceChildren(...cities.map((city) => el("option", { value: city }, city)));
  select.value = cities.includes(saved) ? saved : cities[0];
  const apply = () => {
    chains = allChains.filter((c) => c.city === select.value);
  };
  apply();
  select.addEventListener("change", () => {
    apply();
    try {
      localStorage.setItem(CITY_KEY, select.value);
    } catch {
      // לא נשמר, אבל הבחירה עובדת עד רענון הדף
    }
    announce(`העיר: ${select.value}. ההשוואה תהיה מול ${chains.length} סניפים`);
  });
}

// ---- התחברות (רק לתורמים. ההשוואה פתוחה לכולם) ----

// פעולות שדורשות התחברות. אחרי החזרה מ-Google הפעולה שהתחילה ממשיכה
const ACTIONS = {
  report: () => openReport(),
  requests: () => openRequests(sessionStorage.getItem(DRAFT_KEY) || ""),
  saving: () => sendPendingSaving(),
};
const DRAFT_KEY = "cartwise-request-draft";

let dialogOpener = null;

function openDialog(id) {
  dialogOpener = document.activeElement;
  $(id).showModal();
}

function closeDialog(id) {
  $(id).close();
}

function showInfo(title, text) {
  $("info-title").textContent = title;
  $("info-text").textContent = text;
  openDialog("info-dialog");
}

// מפעיל פעולה של תורם: מחובר, מיד. לא מחובר, חלון הכניסה
let pendingAction = null;
function requireLogin(action) {
  if (auth.getUser()) {
    ACTIONS[action]();
    return;
  }
  pendingAction = action;
  openDialog("login-dialog");
}

function renderProfile(user) {
  $("profile").hidden = !user;
  if (!user) {
    closeProfileMenu(false);
    return;
  }
  $("profile-name").textContent = user.name;
  $("profile-email").textContent = user.email;
  $("profile-initial").textContent = (user.name || "?").trim().charAt(0);
  const img = $("profile-img");
  if (user.avatar) {
    img.src = user.avatar;
    img.hidden = false;
    $("profile-initial").hidden = true;
  } else {
    img.hidden = true;
    $("profile-initial").hidden = false;
  }
  $("profile-btn").setAttribute("aria-label", `תפריט החשבון של ${user.name}`);
}

function openProfileMenu() {
  loadSavings();
  $("profile-menu").hidden = false;
  $("profile-btn").setAttribute("aria-expanded", "true");
  $("profile-menu").querySelector(".profile-item").focus();
}

function closeProfileMenu(focus = true) {
  if ($("profile-menu").hidden) return;
  $("profile-menu").hidden = true;
  $("profile-btn").setAttribute("aria-expanded", "false");
  $("profile-status").textContent = "";
  resetDelete();
  if (focus) $("profile-btn").focus();
}

let deleteTimer = null;
function resetDelete() {
  clearTimeout(deleteTimer);
  deleteTimer = null;
  $("btn-delete-account").textContent = "מחיקת חשבון";
  $("btn-delete-account").classList.remove("confirming");
}

async function handleDeleteAccount() {
  const btn = $("btn-delete-account");
  // אישור בתוך הדף (לחיצה שנייה), כמו "נקה סל"
  if (!deleteTimer) {
    btn.textContent = "כל המידע שלך יימחק. לחץ שוב לאישור";
    btn.classList.add("confirming");
    announce("כל המידע שלך יימחק, ואי אפשר לבטל. לחץ שוב כדי למחוק את החשבון");
    deleteTimer = setTimeout(resetDelete, 6000);
    return;
  }
  resetDelete();
  btn.disabled = true;
  $("profile-status").textContent = "מוחק...";
  try {
    await auth.deleteAccount();
    announce("החשבון נמחק");
    showInfo("החשבון נמחק", "החשבון וכל המידע שלו נמחקו. אפשר להמשיך להשוות סלים בלי התחברות.");
  } catch {
    $("profile-status").textContent = "המחיקה לא הצליחה. נסו שוב.";
  } finally {
    btn.disabled = false;
  }
}

// ---- מונה חיסכון אישי ----

// הקנייה ממתינה כאן בזמן המעבר ל-Google, ונספרת אחרי החזרה
const SAVING_KEY = "cartwise-pending-saving";

function shekelText(value) {
  return formatPrice(Math.round(value * 100));
}

// כפתור "קניתי" בכרטיס התוצאה. purchase.amount באגורות.
// בכל השוואה נספרת קנייה אחת: אחרי הספירה שני הכפתורים (רשת וסל מפוצל) נסגרים
// אחרי הספירה מופיע "ביטול", שמוריד את הקנייה מהמונה ופותח את הכפתורים מחדש
function boughtButton(text, purchase) {
  const wrap = el("div", { class: "bought" });
  const row = el("div", { class: "bought-row" });
  const btn = el("button", { type: "button", class: "btn-bought", "data-label": text }, lastSaved === purchase.kind ? "נספר במונה ✓" : text);
  btn.disabled = Boolean(lastSaved);
  const undoBtn = el("button", { type: "button", class: "btn-undo", "aria-label": "ביטול: הורדת הקנייה מהמונה" }, "ביטול");
  undoBtn.hidden = lastSaved !== purchase.kind;
  const status = el("p", { class: "bought-status", "aria-live": "polite" });
  btn.addEventListener("click", () => buy({ ...purchase, amount: purchase.amount / 100, city: $("city").value }, btn, undoBtn, status));
  undoBtn.addEventListener("click", () => undoBought(btn, undoBtn, status));
  row.append(btn, undoBtn);
  wrap.append(row, status);
  return wrap;
}

// מחזיר את כפתורי "קניתי" במסך התוצאות למצב לפני ספירה
function resetBought() {
  lastSaved = null;
  document.querySelectorAll(".btn-bought").forEach((b) => {
    b.disabled = false;
    b.textContent = b.dataset.label;
  });
  document.querySelectorAll(".btn-undo").forEach((b) => (b.hidden = true));
}

async function undoBought(btn, undoBtn, status) {
  undoBtn.disabled = true;
  status.textContent = "מבטלים...";
  try {
    const res = await community.undoLastSaving();
    if (res !== "ok" && res !== "none") throw new Error(res);
    resetBought();
    status.textContent = "בוטל. הקנייה הוסרה מהמונה";
    btn.focus();
  } catch {
    status.textContent = "לא הצלחנו לבטל. נסו שוב.";
  }
  undoBtn.disabled = false;
}

async function buy(purchase, btn, undoBtn, status) {
  if (!auth.getUser()) {
    try {
      sessionStorage.setItem(SAVING_KEY, JSON.stringify(purchase));
    } catch {
      // בלי sessionStorage הקנייה לא תיספר אחרי הכניסה
    }
    requireLogin("saving");
    return;
  }
  btn.disabled = true;
  status.textContent = "סופרים...";
  const result = await savePurchase(purchase);
  status.textContent = result.text;
  if (result.ok) {
    lastSaved = purchase.kind;
    document.querySelectorAll(".btn-bought").forEach((b) => (b.disabled = true));
    btn.textContent = "נספר במונה ✓";
    undoBtn.hidden = false;
  } else if (!result.limit) {
    btn.disabled = false;
  }
}

// amount בשקלים. מחזיר { ok, limit, text }
async function savePurchase(purchase) {
  const failed = { ok: false, text: "לא הצלחנו לספור את הקנייה. נסו שוב." };
  try {
    const res = await community.recordSaving(purchase);
    if (res === "limit") return { ok: false, limit: true, text: "אפשר לספור עד 3 קניות ביום. נסו שוב מחר." };
    if (res !== "ok") return failed;
    const total = await community.mySavings().then((s) => s.total).catch(() => null);
    return {
      ok: true,
      text: `נוסף למונה: ${shekelText(purchase.amount)}.` + (total === null ? "" : ` חסכתם עד היום ${shekelText(total)}`),
    };
  } catch {
    return failed;
  }
}

// אחרי החזרה מ-Google: הקנייה שנלחצה לפני הכניסה נספרת, והתוצאה בחלון הודעה
async function sendPendingSaving() {
  let purchase = null;
  try {
    purchase = JSON.parse(sessionStorage.getItem(SAVING_KEY));
    sessionStorage.removeItem(SAVING_KEY);
  } catch {
    purchase = null;
  }
  if (!(purchase?.amount > 0)) return;
  const result = await savePurchase(purchase);
  showInfo(result.ok ? "החיסכון נספר" : "החיסכון לא נספר", result.text);
}

// המונה בראש תפריט הפרופיל. נטען בכל פתיחה של התפריט
async function loadSavings() {
  const total = $("savings-total");
  const meta = $("savings-meta");
  total.textContent = "החיסכון שלי";
  meta.textContent = "טוען...";
  $("btn-undo-saving").hidden = true;
  try {
    const s = await community.mySavings();
    $("btn-undo-saving").hidden = !s.purchases;
    total.textContent = `החיסכון שלי: ${shekelText(s.total)}`;
    meta.textContent = s.purchases
      ? `${s.purchases === 1 ? "קנייה אחת" : `${s.purchases} קניות`} · ${shekelText(s.month)} החודש`
      : "עוד לא ספרנו חיסכון. אחרי השוואה, לחצו \"קניתי כאן\"";
  } catch {
    meta.textContent = "לא הצלחנו לטעון את המונה";
  }
}

// ביטול מהתפריט: גם לקנייה שנספרה אחרי החזרה מ-Google, כשמסך התוצאות כבר לא פתוח
async function undoFromMenu() {
  const btn = $("btn-undo-saving");
  btn.disabled = true;
  try {
    const res = await community.undoLastSaving();
    if (res !== "ok" && res !== "none") throw new Error(res);
    resetBought();
    await loadSavings();
    $("profile-status").textContent = "הקנייה האחרונה הוסרה מהמונה";
  } catch {
    $("profile-status").textContent = "לא הצלחנו לבטל. נסו שוב.";
  }
  btn.disabled = false;
}

// ---- קהילה: "מצאתי זול יותר", בקשות מוצרים והצבעה ----

const STATUS_TEXT = { pending: "ממתין לאישור", approved: "מאושר", rejected: "לא אושר", added: "נוסף לקטלוג 🎉", expired: "פג תוקף" };
const REPORT_DAYS = 3;

function chainById(id) {
  return allChains.find((c) => c.chain_id === id);
}

function shekels(value) {
  return formatPrice(Math.round(Number(value) * 100));
}

function setStatus(id, text, kind = "") {
  $(id).textContent = text;
  $(id).className = `form-status ${kind}`.trim();
}

// "12,90" או "12.9" -> 12.9. לא תקין: null
function parsePrice(text) {
  const clean = text.trim().replace(/[₪\s]/g, "").replace(",", ".");
  if (!/^\d{1,4}(\.\d{1,2})?$/.test(clean)) return null;
  const value = Number(clean);
  return value > 0 ? value : null;
}

// --- טופס הדיווח ---

function reportProduct() {
  return byBarcode.get($("report-product").value);
}

function reportChain() {
  return chains.find((c) => c.chain_id === $("report-chain").value);
}

let officialRequest = 0;
async function updateOfficial() {
  const product = reportProduct();
  const chain = reportChain();
  if (!product || !chain) return;
  $("report-price-label").textContent = product.unit === "kg" ? 'המחיר שמצאתם לק"ג (₪)' : "המחיר שמצאתם (₪)";
  $("report-official").textContent = "בודקים את המחיר הרשמי...";
  const ticket = ++officialRequest;
  try {
    const rows = await fetchPrices([codeIn(chain, product)], [chain.chain_id]);
    if (ticket !== officialRequest) return;
    const row = rows[0];
    const value = product.unit === "kg" ? row?.price_per_kg : row?.price;
    $("report-official").textContent = value == null
      ? "אין לנו מחיר רשמי למוצר הזה ברשת הזו, ולכן אי אפשר לדווח עליו."
      : `המחיר הרשמי כאן: ${shekels(value)}${product.unit === "kg" ? ' לק"ג' : ""}`;
  } catch {
    if (ticket === officialRequest) $("report-official").textContent = "";
  }
}

function openReport() {
  const select = $("report-product");
  select.replaceChildren();
  const inBasket = basket.items().map((i) => i.barcode).filter((b) => byBarcode.has(b));
  const group = (title, list) => {
    if (!list.length) return;
    const g = el("optgroup", { label: title });
    list.forEach((p) => g.append(el("option", { value: p.barcode }, label(p))));
    select.append(g);
  };
  const byName = (a, b) => a.name.localeCompare(b.name, "he");
  group("מהסל שלי", inBasket.map((b) => byBarcode.get(b)).sort(byName));
  group("כל המוצרים", products.filter((p) => !inBasket.includes(p.barcode)).sort(byName));

  $("report-chain").replaceChildren(...chains.map((c) => el("option", { value: c.chain_id }, `${c.name}, ${c.store_name}`)));
  $("report-price").value = "";
  setStatus("report-status", "");
  updateOfficial();
  openDialog("report-dialog");
}

async function sendReport(event) {
  event.preventDefault();
  const product = reportProduct();
  const chain = reportChain();
  const price = parsePrice($("report-price").value);
  if (!product || !chain) return;
  if (price == null) {
    setStatus("report-status", "כתבו מחיר במספרים, למשל 12.90", "error");
    $("report-price").focus();
    return;
  }
  const btn = $("btn-report-send");
  btn.disabled = true;
  setStatus("report-status", "שולחים...");
  try {
    const result = await community.submitReport({
      barcode: product.barcode,
      chainId: chain.chain_id,
      itemCode: codeIn(chain, product),
      perKg: product.unit === "kg",
      price,
    });
    const messages = {
      ok: ["תודה! הדיווח יופיע באתר אחרי אישור.", "ok"],
      updated: ["עדכנו את הדיווח שלכם מהיום על המוצר הזה. הוא יופיע אחרי אישור.", "ok"],
      limit: ["הגעתם ל-5 דיווחים היום. אפשר לדווח שוב מחר.", "error"],
      not_cheaper: ["המחיר הזה לא נמוך מהמחיר הרשמי, אז אין מה לדווח.", "error"],
      no_price: ["אין לנו מחיר רשמי למוצר הזה ברשת הזו, ולכן אי אפשר לדווח עליו.", "error"],
    };
    const [text, kind] = messages[result] || ["השליחה לא הצליחה. נסו שוב.", "error"];
    setStatus("report-status", text, kind);
    announce(text);
    if (kind === "ok") $("report-price").value = "";
  } catch (err) {
    if (err.signedOut) {
      closeDialog("report-dialog");
      requireLogin("report");
    } else {
      setStatus("report-status", "השליחה לא הצליחה. בדקו את החיבור ונסו שוב.", "error");
    }
  } finally {
    btn.disabled = false;
  }
}

// --- בקשות מוצרים והצבעה ---

let requestList = [];

function votesText(n) {
  return Number(n) === 1 ? "קול אחד" : `${n} קולות`;
}

function votesLeftText(used) {
  const left = Math.max(0, 5 - used);
  return left === 1 ? "(נשאר לכם קול אחד)" : `(נשארו לכם ${left} קולות)`;
}

function voteButton(r) {
  return el("button", {
    type: "button",
    class: r.my_vote ? "btn-vote voted" : "btn-vote",
    "data-request": r.id,
    "aria-pressed": String(r.my_vote),
    "aria-label": r.my_vote ? `ביטול הקול על ${r.name}` : `הצבעה על ${r.name}`,
  }, r.my_vote ? "✓ הצבעתי" : "הצבעה");
}

function requestItem(r) {
  const li = el("li", { class: "request-item" });
  const info = el("div", { class: "request-info" });
  info.append(el("span", { class: "request-name" }, r.name), el("span", { class: "request-votes" }, votesText(r.votes)));
  li.append(info, voteButton(r));
  return li;
}

function renderRequests() {
  $("requests-list").replaceChildren(...requestList.map(requestItem));
  renderSimilar();
}

async function loadRequests() {
  $("requests-list-status").textContent = "טוענים...";
  try {
    const [list, used] = await Promise.all([
      community.listRequests(),
      auth.getUser() ? community.myActiveVotes() : Promise.resolve(null),
    ]);
    requestList = list;
    $("votes-left").textContent = used == null ? "" : votesLeftText(used);
    $("requests-list-status").textContent = list.length ? "" : "עוד אין בקשות שאושרו. היו הראשונים לבקש!";
    renderRequests();
  } catch {
    $("requests-list-status").textContent = "לא הצלחנו לטעון את הבקשות. נסו שוב.";
  }
}

// בקשה דומה שכבר אושרה, או מוצר שכבר בקטלוג: מציעים אותם לפני בקשה חדשה
function renderSimilar() {
  const box = $("request-similar");
  box.replaceChildren();
  const query = normalize($("request-name").value);
  if (query.length < 2) {
    box.hidden = true;
    return;
  }
  const words = query.split(" ").filter((w) => w.length >= 3);
  const similar = requestList.filter((r) => {
    const name = normalize(r.name);
    return name.includes(query) || query.includes(name) || words.some((w) => name.includes(w));
  }).slice(0, 3);
  const inCatalog = products.filter((p) => matches(p, query)).slice(0, 2);
  if (!similar.length && !inCatalog.length) {
    box.hidden = true;
    return;
  }
  for (const p of inCatalog) box.append(el("p", {}, `כבר בקטלוג: ${label(p)}`));
  if (similar.length) {
    box.append(el("p", {}, "אולי התכוונתם לבקשה שכבר קיימת? אפשר להצביע עליה:"));
    box.append(el("ul", { class: "requests-list" }));
    box.lastChild.append(...similar.map(requestItem));
  }
  box.hidden = false;
}

function openRequests(prefill = "") {
  sessionStorage.removeItem(DRAFT_KEY);
  $("request-name").value = prefill;
  setStatus("request-status", "");
  $("votes-left").textContent = "";
  requestList = [];
  renderRequests();
  openDialog("requests-dialog");
  loadRequests();
}

// לא מחובר: שומרים את מה שהוקלד, סוגרים את החלון, וממשיכים אחרי הכניסה
function loginForRequests() {
  sessionStorage.setItem(DRAFT_KEY, $("request-name").value);
  closeDialog("requests-dialog");
  requireLogin("requests");
}

async function sendRequest(event) {
  event.preventDefault();
  if (!auth.getUser()) {
    loginForRequests();
    return;
  }
  const name = $("request-name").value.trim();
  if (name.length < 2) {
    setStatus("request-status", "כתבו שם של מוצר, לפחות 2 אותיות.", "error");
    $("request-name").focus();
    return;
  }
  const btn = $("btn-request-send");
  btn.disabled = true;
  setStatus("request-status", "שולחים...");
  try {
    const result = await community.submitRequest(name);
    const messages = {
      ok: ["תודה! הבקשה תופיע ברשימה אחרי אישור, ואחרים יוכלו להצביע עליה. הקול שלכם כבר עליה.", "ok"],
      ok_no_vote: ["תודה! הבקשה תופיע אחרי אישור. לא נשאר לכם קול פנוי להצביע עליה.", "ok"],
      limit: ["הגעתם ל-5 בקשות היום. אפשר לבקש שוב מחר.", "error"],
      invalid: ["כתבו שם של מוצר, בין 2 ל-60 תווים.", "error"],
    };
    const [text, kind] = messages[result] || ["השליחה לא הצליחה. נסו שוב.", "error"];
    setStatus("request-status", text, kind);
    announce(text);
    if (kind === "ok") {
      $("request-name").value = "";
      loadRequests();
    }
  } catch (err) {
    if (err.signedOut) loginForRequests();
    else setStatus("request-status", "השליחה לא הצליחה. בדקו את החיבור ונסו שוב.", "error");
  } finally {
    btn.disabled = false;
  }
}

async function toggleVote(btn, statusId, reload) {
  if (!auth.getUser()) {
    loginForRequests();
    return;
  }
  const id = Number(btn.dataset.request);
  const voted = btn.getAttribute("aria-pressed") === "true";
  btn.disabled = true;
  try {
    if (voted) await community.unvote(id);
    else await community.vote(id);
    announce(voted ? "הקול בוטל" : "הצבעתם. תודה!");
    await reload();
  } catch (err) {
    const text = err.voteLimit
      ? "נגמרו 5 הקולות שלכם. בטלו קול על בקשה אחרת כדי להצביע."
      : "לא הצלחנו לשמור את ההצבעה. נסו שוב.";
    setStatus(statusId, text, "error");
    announce(text);
    btn.disabled = false;
  }
}

// --- הדיווחים והבקשות שלי (מתפריט הפרופיל) ---

function reportStatus(r) {
  if (r.status === "approved" && Date.now() - new Date(r.decided_at) > REPORT_DAYS * 864e5) return STATUS_TEXT.expired;
  return STATUS_TEXT[r.status] || r.status;
}

function mineItem(title, status, reason) {
  const li = el("li", { class: "mine-item" });
  const info = el("div", { class: "request-info" });
  info.append(el("span", { class: "mine-name" }, title), el("span", { class: `mine-state state-${status === STATUS_TEXT.rejected ? "rejected" : "other"}` }, status));
  if (reason) info.append(el("span", { class: "mine-reason" }, `הסיבה: ${reason}`));
  li.append(info);
  return li;
}

async function openMyReports() {
  closeProfileMenu(false);
  $("mine-title").textContent = "הדיווחים שלי";
  $("mine-list").replaceChildren();
  $("mine-status").textContent = "טוענים...";
  openDialog("mine-dialog");
  try {
    const rows = await community.myReports();
    for (const r of rows) {
      const product = byBarcode.get(r.barcode);
      const chain = chainById(r.chain_id);
      const title = `${product ? product.name : r.barcode} · ${chain ? chain.name : r.chain_id} · ${shekels(r.price)}`;
      $("mine-list").append(mineItem(title, reportStatus(r), r.status === "rejected" ? r.reject_reason : ""));
    }
    $("mine-status").textContent = rows.length ? "" : "עוד לא דיווחתם. אפשר לדווח ממסך התוצאות, בכפתור \"דווחו\".";
  } catch (err) {
    if (err.signedOut) closeDialog("mine-dialog");
    else $("mine-status").textContent = "לא הצלחנו לטעון. נסו שוב.";
  }
}

async function openMyRequests() {
  closeProfileMenu(false);
  $("mine-title").textContent = "הבקשות והקולות שלי";
  if (!$("mine-dialog").open) {
    $("mine-list").replaceChildren();
    $("mine-status").textContent = "טוענים...";
    openDialog("mine-dialog");
  }
  try {
    const [mine, list, used] = await Promise.all([community.myRequests(), community.listRequests(), community.myActiveVotes()]);
    const ul = $("mine-list");
    ul.replaceChildren();
    $("mine-status").textContent = `${used} מתוך 5 קולות בשימוש`;
    if (mine.length) {
      ul.append(el("li", { class: "mine-heading" }, "הבקשות שלי"));
      for (const r of mine) ul.append(mineItem(r.name, STATUS_TEXT[r.status] || r.status, r.status === "rejected" ? r.reject_reason : ""));
    }
    const voted = list.filter((r) => r.my_vote);
    if (voted.length) {
      ul.append(el("li", { class: "mine-heading" }, "הצבעתי על"));
      voted.forEach((r) => ul.append(requestItem(r)));
    }
    if (!mine.length && !voted.length) {
      ul.append(el("li", { class: "mine-empty" }, "עוד אין בקשות או קולות. חסר לכם מוצר? בקשו אותו בבניית הסל."));
    }
  } catch (err) {
    if (err.signedOut) closeDialog("mine-dialog");
    else $("mine-status").textContent = "לא הצלחנו לטעון. נסו שוב.";
  }
}

function setupCommunity() {
  $("report-product").addEventListener("change", updateOfficial);
  $("report-chain").addEventListener("change", updateOfficial);
  $("report-form").addEventListener("submit", sendReport);
  $("btn-report-close").addEventListener("click", () => closeDialog("report-dialog"));

  $("btn-requests").addEventListener("click", () => openRequests());
  $("btn-request-missing").addEventListener("click", () => openRequests($("search").value.trim()));
  $("request-form").addEventListener("submit", sendRequest);
  $("request-name").addEventListener("input", renderSimilar);
  $("btn-requests-close").addEventListener("click", () => closeDialog("requests-dialog"));
  $("requests-dialog").addEventListener("click", (e) => {
    const btn = e.target.closest(".btn-vote");
    if (btn) toggleVote(btn, "request-status", loadRequests);
  });

  $("btn-my-reports").addEventListener("click", () => openMyReports());
  $("btn-my-requests").addEventListener("click", () => openMyRequests());
  $("btn-mine-close").addEventListener("click", () => closeDialog("mine-dialog"));
  $("mine-dialog").addEventListener("click", (e) => {
    const btn = e.target.closest(".btn-vote");
    if (btn) toggleVote(btn, "mine-status", openMyRequests);
  });
}

async function setupAuth() {
  auth.onChange(renderProfile);

  $("btn-report").addEventListener("click", () => requireLogin("report"));
  $("btn-google").addEventListener("click", () => {
    $("btn-google").disabled = true;
    auth.signIn(pendingAction);
  });
  $("btn-login-close").addEventListener("click", () => closeDialog("login-dialog"));
  $("btn-info-close").addEventListener("click", () => closeDialog("info-dialog"));
  ["login-dialog", "info-dialog", "report-dialog", "requests-dialog", "mine-dialog"].forEach((id) => {
    $(id).addEventListener("close", () => {
      if (id === "login-dialog") pendingAction = null;
      if (dialogOpener && document.contains(dialogOpener) && !dialogOpener.closest("[hidden]")) dialogOpener.focus();
      dialogOpener = null;
    });
  });

  $("profile-btn").addEventListener("click", () => {
    if ($("profile-menu").hidden) openProfileMenu();
    else closeProfileMenu();
  });
  $("profile").addEventListener("keydown", (e) => {
    if (e.key === "Escape") closeProfileMenu();
  });
  document.addEventListener("click", (e) => {
    if (!$("profile").contains(e.target)) closeProfileMenu(false);
  });
  $("btn-signout").addEventListener("click", async () => {
    await auth.signOut();
    announce("התנתקת");
    $("build-title").focus({ preventScroll: true });
  });
  $("btn-delete-account").addEventListener("click", handleDeleteAccount);
  $("btn-undo-saving").addEventListener("click", undoFromMenu);
  setupCommunity();

  const { error, pending } = await auth.init();
  renderProfile(auth.getUser());
  if (error) showInfo("הכניסה לא הצליחה", "לא הצלחנו להתחבר עם Google. נסו שוב.");
  else if (auth.getUser() && pending === null) announce(`מחובר בתור ${auth.getUser().name}`);
  // הפעולה שהתחילה לפני הכניסה ממשיכה אחרי שהמוצרים נטענו (init)
  return { pending: error ? null : pending };
}

async function init() {
  // ההתחברות לא מעכבת את טעינת האתר. אם היא נכשלת, האתר עובד כרגיל בלי חשבון
  const authReady = setupAuth().catch(() => ({}));
  try {
    [products, allChains] = await Promise.all([
      loadJson("data/products.json?v=60"),
      loadJson("data/chains.json?v=15"),
    ]);
  } catch {
    $("products-status").textContent = "לא הצלחנו לטעון את רשימת המוצרים. נסו לרענן את הדף.";
    return;
  }

  byBarcode = new Map(products.map((p) => [p.barcode, p]));
  matchesReady = fetchMatches().then(applyMatches).catch(() => {});
  setupCity();
  // "סל אוטומטי": נבנה ב-Supabase אחרי כל עדכון מחירים. אם לא נטען, קובץ גיבוי. אם גם הוא לא, הכפתור לא מופיע
  await refreshAutoBasket();
  // הפופולריים לא מעכבים את הגריד
  loadPopular();
  // סל אוטומטי ופופולריים נפרדים לכל עיר: החלפת עיר טוענת את אלה של העיר החדשה
  $("city").addEventListener("change", async () => {
    await refreshAutoBasket();
    loadPopular();
  });
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
  $("popular").addEventListener("click", handleClick);
  $("basket").addEventListener("click", handleClick);
  document.querySelectorAll(".js-compare").forEach((btn) => btn.addEventListener("click", compare));
  $("btn-to-basket").addEventListener("click", goBasket);
  $("btn-basket-back").addEventListener("click", goBuild);
  $("subs").addEventListener("click", handleDecision);
  $("btn-approve-all").addEventListener("click", () => decideAll("approved"));
  $("btn-reject-all").addEventListener("click", () => decideAll("rejected"));
  $("btn-to-results").addEventListener("click", () => showResults());
  $("btn-subs-back").addEventListener("click", goBuild);
  // אישור בתוך הדף (לחיצה שנייה), כי confirm() חסום בחלק מהדפדפנים המובנים באפליקציות
  // כל כפתור "נקה סל" מחזיק אישור משלו
  document.querySelectorAll(".js-clear").forEach((btn) => {
    let clearTimer = null;
    const resetClear = () => {
      clearTimeout(clearTimer);
      clearTimer = null;
      btn.textContent = "נקה סל";
      btn.classList.remove("confirming");
    };
    btn.addEventListener("click", () => {
      if (!clearTimer) {
        btn.textContent = "בטוח? לחץ שוב";
        btn.classList.add("confirming");
        announce("לחץ שוב על הכפתור כדי לנקות את הסל");
        clearTimer = setTimeout(resetClear, 4000);
        return;
      }
      resetClear();
      basket.clear();
      render();
      announce("הסל רוקן");
      // בבניית סל: לחיפוש. בדף "הסל שלי": לכותרת
      (btn.closest("#screen-basket") ? $("basket-title") : $("search")).focus({ preventScroll: true });
    });
  });
  // מוסיף לסל את מוצרי הסל האוטומטי שעוד לא בו. מה שכבר בסל נשאר כמו שהוא
  $("btn-auto").addEventListener("click", () => {
    const missing = autoBarcodes.filter((b) => !basket.has(b));
    missing.forEach((b) => basket.add(b));
    render();
    announce(missing.length
      ? `נוספו ${countText(missing.length)} מהסל האוטומטי. בסל ${countText(basket.items().length)}`
      : "כל המוצרים של הסל האוטומטי כבר בסל");
  });
  $("btn-back").addEventListener("click", goBuild);
  history.replaceState({ screen: "screen-build", depth: 0 }, "");
  window.addEventListener("popstate", handlePopState);

  const { pending } = await authReady;
  if (pending && ACTIONS[pending] && auth.getUser()) ACTIONS[pending]();
}

init();
