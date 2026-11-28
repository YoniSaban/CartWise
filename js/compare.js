// החישוב והכלל של סל חלקי: מחיר כפול כמות, סכום לכל רשת, והרשת הזולה ביותר.
// מוצר במשקל (unit: "kg"): מחיר לק"ג (price_per_kg) כפול הכמות בק"ג.

// הקוד של המוצר ברשת: בדרך כלל הברקוד, אלא אם הרשת משתמשת בקוד אחר (chain_codes).
// סניף נוסף של אותה רשת (codes_from) משתמש בקודים של הסניף הראשון שלה.
// match_codes: התאמה של סוכן התאמת המוצרים לסניף הזה בלבד (מיילסטון 15)
export function codeIn(chain, product) {
  return product.chain_codes?.[chain.codes_from ?? chain.chain_id] ?? product.match_codes?.[chain.chain_id] ?? product.barcode;
}

// כל הקודים של מוצר בכל הסניפים: הברקוד, chain_codes והתאמות
export function allCodes(product) {
  return [product.barcode, ...Object.values(product.chain_codes || {}), ...Object.values(product.match_codes || {})];
}

// מוצר שהרשת הפסיקה למכור: השורה שלו לא התעדכנה בעדכון האחרון של הרשת, ונשארה עם מחיר ישן.
// שורה ישנה ביותר מ-12 שעות מהעדכון האחרון של הרשת נחשבת "לא זמין". העדכון רץ פעם ביום,
// ולכן כל השורות של אותו עדכון קרובות זו לזו. updates: Map chain_id -> loaded_at האחרון.
// מחזיר { fresh, unavailable }: השורות לחישוב, וסט של "chain_id:item_code" שלא זמינים
const UNAVAILABLE_GAP_MS = 12 * 60 * 60 * 1000;
export function splitUnavailable(rows, updates) {
  const fresh = [];
  const unavailable = new Set();
  for (const r of rows) {
    const latest = updates.get(r.chain_id);
    if (latest && r.loaded_at && new Date(latest) - new Date(r.loaded_at) > UNAVAILABLE_GAP_MS) {
      unavailable.add(`${r.chain_id}:${r.item_code}`);
    } else fresh.push(r);
  }
  return { fresh, unavailable };
}

// החישוב באגורות שלמות, כדי שלא יהיו שגיאות עיגול
function toAgorot(price) {
  return Math.round(Number(price) * 100);
}

// ---------- מבצעים (מיילסטון 14) ----------
// promos: Map "chain_id:item_code" -> [מבצע], מהטבלה chain_promos. רק מבצעים בתוקף, ורק מוצרים ארוזים.
// מבצע: { kind: "unit" | "bundle" | "percent", min_qty, bundle_price, discount_rate, max_qty, club_only, description }
//   unit: מחיר ליחידה (כשקונים לפחות min_qty). bundle: min_qty יחידות ב-bundle_price.
//   percent: בכל קבוצה של min_qty יחידות, האחרונה בהנחה של discount_rate אחוז ("השני ב-50%").
// max_qty: מעבר לכמות הזו, מחיר מדף. מבצע מועדון לא משנה את המחיר, רק מוצג.

// הסכום באגורות לכמות qty עם מבצע אחד. shelf: מחיר מדף ליחידה באגורות. null אם המבצע לא חל על הכמות
export function promoAmount(shelf, qty, promo) {
  const min = Math.max(1, Number(promo.min_qty) || 1);
  const capped = promo.max_qty ? Math.min(qty, Number(promo.max_qty)) : qty;
  const rest = (n) => Math.round(shelf * n);
  if (promo.kind === "unit") {
    if (capped < min) return null;
    return Math.round(toAgorot(promo.bundle_price) * capped) + rest(qty - capped);
  }
  const groups = Math.floor(capped / min);
  if (!groups) return null;
  const used = groups * min;
  if (promo.kind === "bundle") return groups * toAgorot(promo.bundle_price) + rest(qty - used);
  if (promo.kind === "percent") {
    const last = Math.round(shelf * (1 - Number(promo.discount_rate) / 100));
    return groups * (shelf * (min - 1) + last) + rest(qty - used);
  }
  return null;
}

// שורה בסל עם מבצעים: { amount, promo, hint, club }
// amount: הזול מבין המבצעים שחלים על הכמות (לא משלבים שניים), או מחיר מדף.
// promo: המבצע שנכנס לסכום. hint: מבצע שעוד לא חל ("קנו 2 ב-20"). club: מבצע מועדון, להצגה בלבד
export function promoLine(shelf, qty, list = []) {
  const regular = Math.round(shelf * qty);
  let amount = regular, promo = null, hint = null, club = null;
  for (const p of list) {
    if (p.club_only) { club ??= p; continue; }
    const a = promoAmount(shelf, qty, p);
    if (a == null) { if (Number(p.min_qty) > qty) hint ??= p; continue; }
    if (a < amount) { amount = a; promo = p; }
  }
  if (promo) hint = null;
  return { amount, regular, promo, hint, club };
}

// items: [{ barcode, qty }], products: Map ברקוד -> מוצר, chains: מ-chains.json, rows: מ-Supabase
// approved: Map "chain:barcode" -> { item_code, item_name, price }, חלופות שהמשתמש אישר
// מחזיר { results, notFound }:
// - notFound: ברקודים שלא נמצאו באף רשת. הם לא נכנסים לאף סכום ולא לספירת החסרים.
// - results: לכל רשת הסכום והמוצרים החסרים בה. רשת שחסר בה מוצר היא חלקית.
//   weighted: המוצרים במשקל שנכנסו לסכום, עם המחיר לק"ג ברשת.
//   חלופה שאושרה נכנסת לסכום במחיר שלה כפול הכמות, והמוצר לא נספר כחסר (substituted).
//   "הזול ביותר" רק בין רשתות שהסל מלא בהן. אם אין כזו, אף רשת לא מקבלת אותה.
//   cheapestPartial: "הזול מבין החלקיים", בין הרשתות החלקיות שחסרים בהן הכי מעט מוצרים, הזולה מהן.
//   כך רשת שחסרים בה יותר מוצרים לא "זולה" רק בגלל שחסר בה יותר. רשת שאין בה אף מוצר לא מקבלת אותה.
export function compareBasket(items, products, chains, rows, approved = new Map(), promos = new Map()) {
  const rowOf = new Map(rows.map((r) => [`${r.chain_id}:${r.item_code}`, r]));
  const price = (chain, barcode) => {
    const product = products.get(barcode);
    const row = rowOf.get(`${chain.chain_id}:${codeIn(chain, product)}`);
    return product.unit === "kg" ? row?.price_per_kg : row?.price;
  };

  const known = items.filter(({ barcode }) => products.has(barcode));
  const notFound = known
    .filter(({ barcode }) => chains.every((chain) => price(chain, barcode) == null))
    .map(({ barcode }) => barcode);
  const counted = known.filter(({ barcode }) => !notFound.includes(barcode));

  const results = chains.map((chain) => {
    let total = 0;
    let promoSaving = 0;
    const missing = [];
    const substituted = [];
    const weighted = [];
    // lines: שורה לכל מוצר בסל, לפירוט המחירים. amount באגורות, null למוצר שחסר ברשת
    const lines = [];
    for (const { barcode, qty } of counted) {
      const p = price(chain, barcode);
      const sub = approved.get(`${chain.chain_id}:${barcode}`);
      if (p != null) {
        // חצי ק"ג יכול לתת חצי אגורה: מעגלים כל שורה לאגורה שלמה
        // מוצר ארוז: עם המבצעים של הרשת, אם יש. מוצר במשקל: מחיר מדף
        const product = products.get(barcode);
        const list = product.unit === "kg" ? [] : promos.get(`${chain.chain_id}:${codeIn(chain, product)}`) || [];
        const line = promoLine(toAgorot(p), qty, list);
        total += line.amount;
        promoSaving += line.regular - line.amount;
        lines.push({ barcode, qty, sub: null, ...line });
        if (products.get(barcode).unit === "kg") weighted.push({ barcode, qty, perKg: toAgorot(p) });
      } else if (sub) {
        const amount = toAgorot(sub.price) * qty;
        total += amount;
        lines.push({ barcode, qty, amount, sub });
        substituted.push({ barcode, item: sub });
      } else {
        lines.push({ barcode, qty, amount: null, sub: null });
        missing.push(barcode);
      }
    }
    return { chain, total, promoSaving, missing, substituted, weighted, lines, complete: missing.length === 0, cheapest: false, cheapestPartial: false };
  });

  const complete = results.filter((r) => r.complete);
  // סל שאף מוצר בו לא נמצא: אין מה להשוות
  if (complete.length && counted.length) {
    const min = Math.min(...complete.map((r) => r.total));
    for (const r of complete) r.cheapest = r.total === min;
  }

  const partial = results.filter((r) => !r.complete && r.missing.length < counted.length);
  if (partial.length) {
    const fewest = Math.min(...partial.map((r) => r.missing.length));
    const closest = partial.filter((r) => r.missing.length === fewest);
    const min = Math.min(...closest.map((r) => r.total));
    for (const r of closest) r.cheapestPartial = r.total === min;
  }

  // רשתות עם סל מלא קודם, מהזול ליקר. אחריהן החלקיות: מהמעט חסרים להרבה, ובאותו מספר מהזול ליקר.
  results.sort((a, b) => (b.complete - a.complete) || (a.missing.length - b.missing.length) || (a.total - b.total));
  return { results, notFound };
}

// סל מפוצל: הסל הזול ביותר בשתי רשתות לכל היותר. בלי חלופות, רק מחירים מהמאגר.
// בכל זוג רשתות כל מוצר הולך לרשת הזולה מבין השתיים. זוג נחשב רק אם הוא מכסה את כל המוצרים
// שנמצאו ברשת כלשהי. מחזיר null אם אין זוג כזה, או אם הפיצול לא זול מרשת אחת עם סל מלא.
// אחרת { total, saving, base, parts: [{ chain, total, lines: [{ barcode, qty, amount }] }] }
// base: הרשת הזולה עם סל מלא (או null), saving: ההפרש מולה באגורות
export function splitBasket(items, products, chains, rows, promos = new Map()) {
  const { results } = compareBasket(items, products, chains, rows, new Map(), promos);
  const complete = results.filter((r) => r.complete);
  const base = complete.length ? complete.reduce((a, b) => (b.total < a.total ? b : a)) : null;

  let best = null;
  for (let i = 0; i < results.length; i++) {
    for (let j = i + 1; j < results.length; j++) {
      const [a, b] = [results[i], results[j]];
      const parts = [{ chain: a.chain, total: 0, lines: [] }, { chain: b.chain, total: 0, lines: [] }];
      let ok = a.lines.length > 0;
      a.lines.forEach((la, k) => {
        const lb = b.lines[k];
        if (la.amount == null && lb.amount == null) { ok = false; return; }
        // מחיר שווה: נשאר ברשת הראשונה
        const side = lb.amount == null || (la.amount != null && la.amount <= lb.amount) ? 0 : 1;
        const line = side === 0 ? la : lb;
        parts[side].lines.push({ barcode: line.barcode, qty: line.qty, amount: line.amount, promo: line.promo ?? null });
        parts[side].total += line.amount;
      });
      // זוג שכל המוצרים בו מרשת אחת הוא בעצם רשת אחת, לא פיצול
      if (!ok || parts.some((p) => !p.lines.length)) continue;
      const total = parts[0].total + parts[1].total;
      if (!best || total < best.total) best = { total, parts };
    }
  }
  if (!best || (base && best.total >= base.total)) return null;
  best.parts.sort((x, y) => y.lines.length - x.lines.length);
  return { ...best, base: base?.chain ?? null, saving: base ? base.total - best.total : 0 };
}

// גודל אריזה לגרם, מ"ל או יחידה: "1.5 ליטר" -> { amount: 1500, base: "ml" }. לא מזוהה: null
const UNITS = [
  [/^(ק"?ג|קג|קילו|קילוגרם|kg)$/i, 1000, "g"],
  [/^(גרם|גר|ג|g|gr)$/i, 1, "g"],
  [/^(ליטר|ל|l|lt)$/i, 1000, "ml"],
  [/^(מ"?ל|מל|מיליליטר|ml)$/i, 1, "ml"],
];
export function parseSize(quantity, unit) {
  const q = Number(quantity);
  const u = String(unit ?? "").replace(/['׳״]/g, (c) => (c === "״" ? '"' : "")).replace(/\.$/, "").trim();
  if (!(q > 0) || !u) return null;
  for (const [re, factor, base] of UNITS) if (re.test(u)) return { amount: q * factor, base };
  return null;
}

// גודל של מוצר ברשת, מהעמודות quantity ו-unit של chain_items.
// ב-unit מופיע הבסיס של מחיר היחידה ("100 גרם", "1ליטר", "קילוגרם"), והכמות בהתאם:
// "100 גרם" ו-"100 מיליליטר": הכמות בגרם או במ"ל. ליטר וק"ג: לפעמים בליטרים ולפעמים במ"ל,
// ולכן כמות מעל 20 נחשבת גרם או מ"ל. "יחידות" ו"מטרים": לא משווים, null.
export function parseChainSize(quantity, unit) {
  const q = Number(quantity);
  const u = String(unit ?? "");
  if (!(q > 0)) return null;
  const base = /גרם|קילו/.test(u) ? "g" : /מיליליטר|ליטר/.test(u) ? "ml" : null;
  if (!base) return null;
  const big = /קילו|(^|[^י])ליטר/.test(u) && !/מיליליטר/.test(u);
  return { amount: big && q <= 20 ? q * 1000 : q, base };
}

// "850 גרם" -> parseSize(850, "גרם")
export function parseSizeText(text) {
  const m = String(text ?? "").match(/^([\d.]+)\s*(.+)$/);
  return m ? parseSize(m[1], m[2]) : null;
}

// מחיר ל-100 גרם או ל-100 מ"ל, באגורות. גודל לא מזוהה: null
export function unitPrice(price, size) {
  if (!size) return null;
  return Math.round((toAgorot(price) * 100) / size.amount);
}

// 5490 -> "₪ 54.90"
export function formatPrice(agorot) {
  return `₪ ${(agorot / 100).toFixed(2)}`;
}
