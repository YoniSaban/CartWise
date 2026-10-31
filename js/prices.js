// קריאה מ-Supabase דרך ה-REST API, עם המפתח הציבורי.
import { SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY } from "./config.js";

function headers() {
  return {
    apikey: SUPABASE_PUBLISHABLE_KEY,
    "Content-Type": "application/json",
  };
}

// שורת הבדיקה ש-n8n כותב (מיילסטון 1)
export async function fetchTestRow() {
  const url = `${SUPABASE_URL}/rest/v1/chain_items?chain_id=eq.test&select=item_name,price,loaded_at&limit=1`;
  const res = await fetch(url, { headers: headers() });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const rows = await res.json();
  return rows[0] || null;
}

// ניסיון כתיבה מהדפדפן. אמור להיכשל בגלל הרשאות הטבלה.
export async function tryWrite() {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/chain_items`, {
    method: "POST",
    headers: { ...headers(), Prefer: "return=minimal" },
    body: JSON.stringify({ chain_id: "browser", item_code: "1", item_name: "ניסיון כתיבה", price: 0 }),
  });
  return { ok: res.ok, status: res.status };
}
