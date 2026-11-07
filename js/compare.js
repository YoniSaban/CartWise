// החישוב והכלל של סל חלקי: מחיר כפול כמות, סכום לכל רשת, והרשת הזולה ביותר.
// מוצר במשקל (unit: "kg"): מחיר לק"ג (price_per_kg) כפול הכמות בק"ג.

// הקוד של המוצר ברשת: בדרך כלל הברקוד, אלא אם הרשת משתמשת בקוד אחר (chain_codes)
function codeIn(chainId, product) {
  return product.chain_codes?.[chainId] ?? product.barcode;
}

// החישוב באגורות שלמות, כדי שלא יהיו שגיאות עיגול
function toAgorot(price) {
  return Math.round(Number(price) * 100);
}

// items: [{ barcode, qty }], products: Map ברקוד -> מוצר, chains: מ-chains.json, rows: מ-Supabase
// approved: Map "chain:barcode" -> { item_code, item_name, price }, חלופות שהמשתמש אישר
// מחזיר { results, notFound }:
// - notFound: ברקודים שלא נמצאו באף רשת. הם לא נכנסים לאף סכום ולא לספירת החסרים.
// - results: לכל רשת הסכום והמוצרים החסרים בה. רשת שחסר בה מוצר היא חלקית.
//   weighted: המוצרים במשקל שנכנסו לסכום, עם המחיר לק"ג ברשת.
//   חלופה שאושרה נכנסת לסכום במחיר שלה כפול הכמות, והמוצר לא נספר כחסר (substituted).
//   "הזול ביותר" רק בין רשתות שהסל מלא בהן. אם אין כזו, אף רשת לא מקבלת אותה.
export function compareBasket(items, products, chains, rows, approved = new Map()) {
  const rowOf = new Map(rows.map((r) => [`${r.chain_id}:${r.item_code}`, r]));
  const price = (chain, barcode) => {
    const product = products.get(barcode);
    const row = rowOf.get(`${chain.chain_id}:${codeIn(chain.chain_id, product)}`);
    return product.unit === "kg" ? row?.price_per_kg : row?.price;
  };

  const known = items.filter(({ barcode }) => products.has(barcode));
  const notFound = known
    .filter(({ barcode }) => chains.every((chain) => price(chain, barcode) == null))
    .map(({ barcode }) => barcode);
  const counted = known.filter(({ barcode }) => !notFound.includes(barcode));

  const results = chains.map((chain) => {
    let total = 0;
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
        const amount = Math.round(toAgorot(p) * qty);
        total += amount;
        lines.push({ barcode, qty, amount, sub: null });
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
    return { chain, total, missing, substituted, weighted, lines, complete: missing.length === 0, cheapest: false };
  });

  const complete = results.filter((r) => r.complete);
  // סל שאף מוצר בו לא נמצא: אין מה להשוות
  if (complete.length && counted.length) {
    const min = Math.min(...complete.map((r) => r.total));
    for (const r of complete) r.cheapest = r.total === min;
  }

  // רשתות עם סל מלא קודם, מהזול ליקר. אחריהן החלקיות, מהזול ליקר.
  results.sort((a, b) => (b.complete - a.complete) || (a.total - b.total));
  return { results, notFound };
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
