// החישוב: מחיר כפול כמות, סכום לכל רשת, והרשת הזולה ביותר.
// הכלל המלא של סל חלקי נבנה במיילסטון 4. כאן: רשת שחסר בה מוצר לא מקבלת "הזול ביותר".

// הקוד של המוצר ברשת: בדרך כלל הברקוד, אלא אם הרשת משתמשת בקוד אחר (chain_codes)
function codeIn(chainId, product) {
  return product.chain_codes?.[chainId] ?? product.barcode;
}

// החישוב באגורות שלמות, כדי שלא יהיו שגיאות עיגול
function toAgorot(price) {
  return Math.round(Number(price) * 100);
}

// items: [{ barcode, qty }], products: Map ברקוד -> מוצר, chains: מ-chains.json, rows: מ-Supabase
export function compareBasket(items, products, chains, rows) {
  const priceOf = new Map(rows.map((r) => [`${r.chain_id}:${r.item_code}`, r.price]));

  const results = chains.map((chain) => {
    let total = 0;
    const missing = [];
    for (const { barcode, qty } of items) {
      const price = priceOf.get(`${chain.chain_id}:${codeIn(chain.chain_id, products.get(barcode))}`);
      if (price == null) missing.push(barcode);
      else total += toAgorot(price) * qty;
    }
    return { chain, total, missing, complete: missing.length === 0, cheapest: false };
  });

  const complete = results.filter((r) => r.complete);
  if (complete.length) {
    const min = Math.min(...complete.map((r) => r.total));
    for (const r of complete) r.cheapest = r.total === min;
  }

  return results.sort((a, b) => a.total - b.total);
}

// 5490 -> "₪ 54.90"
export function formatPrice(agorot) {
  return `₪ ${(agorot / 100).toFixed(2)}`;
}
