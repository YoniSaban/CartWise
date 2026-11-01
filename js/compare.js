// החישוב והכלל של סל חלקי: מחיר כפול כמות, סכום לכל רשת, והרשת הזולה ביותר.

// הקוד של המוצר ברשת: בדרך כלל הברקוד, אלא אם הרשת משתמשת בקוד אחר (chain_codes)
function codeIn(chainId, product) {
  return product.chain_codes?.[chainId] ?? product.barcode;
}

// החישוב באגורות שלמות, כדי שלא יהיו שגיאות עיגול
function toAgorot(price) {
  return Math.round(Number(price) * 100);
}

// items: [{ barcode, qty }], products: Map ברקוד -> מוצר, chains: מ-chains.json, rows: מ-Supabase
// מחזיר { results, notFound }:
// - notFound: ברקודים שלא נמצאו באף רשת. הם לא נכנסים לאף סכום ולא לספירת החסרים.
// - results: לכל רשת הסכום והמוצרים החסרים בה. רשת שחסר בה מוצר היא חלקית.
//   "הזול ביותר" רק בין רשתות שהסל מלא בהן. אם אין כזו, אף רשת לא מקבלת אותה.
export function compareBasket(items, products, chains, rows) {
  const priceOf = new Map(rows.map((r) => [`${r.chain_id}:${r.item_code}`, r.price]));
  const price = (chain, barcode) => priceOf.get(`${chain.chain_id}:${codeIn(chain.chain_id, products.get(barcode))}`);

  const known = items.filter(({ barcode }) => products.has(barcode));
  const notFound = known
    .filter(({ barcode }) => chains.every((chain) => price(chain, barcode) == null))
    .map(({ barcode }) => barcode);
  const counted = known.filter(({ barcode }) => !notFound.includes(barcode));

  const results = chains.map((chain) => {
    let total = 0;
    const missing = [];
    for (const { barcode, qty } of counted) {
      const p = price(chain, barcode);
      if (p == null) missing.push(barcode);
      else total += toAgorot(p) * qty;
    }
    return { chain, total, missing, complete: missing.length === 0, cheapest: false };
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

// 5490 -> "₪ 54.90"
export function formatPrice(agorot) {
  return `₪ ${(agorot / 100).toFixed(2)}`;
}
