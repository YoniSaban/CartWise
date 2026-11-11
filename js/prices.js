// קריאת מחירים מ-Supabase דרך ה-REST API, עם המפתח הציבורי (קריאה בלבד)
import { SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY } from "./config.js?v=11";

// מחזיר את כל השורות של ברקודי הסל, בכל הרשתות: [{ chain_id, item_code, price, price_per_kg, loaded_at }]
export async function fetchPrices(barcodes, chainIds) {
  if (!barcodes.length) return [];
  const params = new URLSearchParams({
    select: "chain_id,item_code,price,price_per_kg,loaded_at",
    item_code: `in.(${barcodes.join(",")})`,
    chain_id: `in.(${chainIds.join(",")})`,
  });
  const res = await fetch(`${SUPABASE_URL}/rest/v1/chain_items?${params}`, {
    headers: { apikey: SUPABASE_PUBLISHABLE_KEY },
  });
  if (!res.ok) throw new Error(`Supabase ${res.status}`);
  return res.json();
}

// הסל האוטומטי של העיר: נבנה ב-Supabase מחדש אחרי כל עדכון מחירים. מחזיר רשימת ברקודים לפי הסדר
export async function fetchAutoBasket(city) {
  const params = new URLSearchParams({ select: "barcode,position", city: `eq.${city}`, order: "position.asc" });
  const res = await fetch(`${SUPABASE_URL}/rest/v1/auto_basket?${params}`, {
    headers: { apikey: SUPABASE_PUBLISHABLE_KEY },
  });
  if (!res.ok) throw new Error(`Supabase ${res.status}`);
  return (await res.json()).map((r) => r.barcode);
}
