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

// העדכון האחרון של כל רשת: השורה החדשה ביותר שלה. בקשה קטנה לכל רשת, במקביל. מחזיר Map chain_id -> loaded_at
export async function fetchChainUpdates(chainIds) {
  const latest = await Promise.all(chainIds.map(async (id) => {
    const params = new URLSearchParams({ select: "loaded_at", chain_id: `eq.${id}`, order: "loaded_at.desc", limit: "1" });
    const res = await fetch(`${SUPABASE_URL}/rest/v1/chain_items?${params}`, {
      headers: { apikey: SUPABASE_PUBLISHABLE_KEY },
    });
    if (!res.ok) throw new Error(`Supabase ${res.status}`);
    return [id, (await res.json())[0]?.loaded_at ?? null];
  }));
  return new Map(latest.filter(([, at]) => at));
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

// המבצעים בתוקף של ברקודי הסל (מיילסטון 14). הטבלה מחזירה רק מבצעים בתוקף (הרשאות).
// מחזיר Map "chain_id:item_code" -> [מבצע]
export async function fetchPromos(codes, chainIds) {
  if (!codes.length) return new Map();
  const params = new URLSearchParams({
    select: "chain_id,item_code,promo_id,description,kind,min_qty,bundle_price,discount_rate,max_qty,club_only,ends_at",
    item_code: `in.(${codes.join(",")})`,
    chain_id: `in.(${chainIds.join(",")})`,
  });
  const res = await fetch(`${SUPABASE_URL}/rest/v1/chain_promos?${params}`, {
    headers: { apikey: SUPABASE_PUBLISHABLE_KEY },
  });
  if (!res.ok) throw new Error(`Supabase ${res.status}`);
  const promos = new Map();
  for (const p of await res.json()) {
    const key = `${p.chain_id}:${p.item_code}`;
    if (!promos.has(key)) promos.set(key, []);
    promos.get(key).push(p);
  }
  return promos;
}
