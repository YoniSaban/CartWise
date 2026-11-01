// קריאת מחירים מ-Supabase דרך ה-REST API, עם המפתח הציבורי (קריאה בלבד)
import { SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY } from "./config.js?v=4";

// מחזיר את כל השורות של ברקודי הסל, בכל הרשתות: [{ chain_id, item_code, price, loaded_at }]
export async function fetchPrices(barcodes, chainIds) {
  if (!barcodes.length) return [];
  const params = new URLSearchParams({
    select: "chain_id,item_code,price,loaded_at",
    item_code: `in.(${barcodes.join(",")})`,
    chain_id: `in.(${chainIds.join(",")})`,
  });
  const res = await fetch(`${SUPABASE_URL}/rest/v1/chain_items?${params}`, {
    headers: { apikey: SUPABASE_PUBLISHABLE_KEY },
  });
  if (!res.ok) throw new Error(`Supabase ${res.status}`);
  return res.json();
}
