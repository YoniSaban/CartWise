// קריאה ל-/api/substitutes, ואז השם והמחיר של כל חלופה מ-Supabase.
// המחיר מגיע רק מ-chain_items, אף פעם לא מהמודל.
import { SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY, FUNCTION_URL } from "./config.js?v=5";

// pairs: [{ chain_id, barcode }]. מחזיר [{ chain_id, barcode, suggested_item_code, reason, error? }]
async function requestSubstitutes(pairs) {
  const res = await fetch(FUNCTION_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ missing: pairs }),
  });
  if (!res.ok) throw new Error(`function ${res.status}`);
  const data = await res.json();
  if (!Array.isArray(data.results)) throw new Error("bad response");
  return data.results;
}

async function fetchItems(chainId, codes) {
  const params = new URLSearchParams({
    select: "chain_id,item_code,item_name,price",
    chain_id: `eq.${chainId}`,
    item_code: `in.(${codes.join(",")})`,
  });
  const res = await fetch(`${SUPABASE_URL}/rest/v1/chain_items?${params}`, {
    headers: { apikey: SUPABASE_PUBLISHABLE_KEY },
  });
  if (!res.ok) throw new Error(`Supabase ${res.status}`);
  return res.json();
}

// מחזיר Map "chain:barcode" -> { chain_id, barcode, item: { item_code, item_name, price } | null, reason, error }
// חלופה שאין לה מחיר ב-chain_items נחשבת "אין חלופה".
export async function findSubstitutes(pairs) {
  const results = await requestSubstitutes(pairs);

  const codesByChain = new Map();
  for (const r of results) {
    if (!r.suggested_item_code) continue;
    if (!codesByChain.has(r.chain_id)) codesByChain.set(r.chain_id, []);
    codesByChain.get(r.chain_id).push(r.suggested_item_code);
  }
  const items = new Map();
  await Promise.all(
    [...codesByChain].map(async ([chainId, codes]) => {
      for (const row of await fetchItems(chainId, [...new Set(codes)])) {
        if (row.price != null) items.set(`${chainId}:${row.item_code}`, row);
      }
    })
  );

  const found = new Map();
  for (const r of results) {
    const item = r.suggested_item_code ? items.get(`${r.chain_id}:${r.suggested_item_code}`) ?? null : null;
    found.set(`${r.chain_id}:${r.barcode}`, {
      chain_id: r.chain_id,
      barcode: r.barcode,
      item,
      reason: r.reason,
      error: Boolean(r.error),
    });
  }
  return found;
}
