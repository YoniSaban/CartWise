// קהילה: דיווחי "מצאתי זול יותר", בקשות מוצרים והצבעה.
// קריאה פומבית עם המפתח הציבורי. כתיבה רק עם הטוקן של משתמש מחובר, דרך פונקציות ב-Supabase שבודקות את הכללים.
import { SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY } from "./config.js?v=11";
import { getToken, getUser } from "./auth.js?v=1";

async function call(path, { method = "GET", body, auth = false, prefer } = {}) {
  const headers = { apikey: SUPABASE_PUBLISHABLE_KEY };
  if (body !== undefined) headers["Content-Type"] = "application/json";
  if (prefer) headers.Prefer = prefer;
  if (auth) {
    const token = await getToken();
    if (!token) throw Object.assign(new Error("not signed in"), { signedOut: true });
    headers.Authorization = `Bearer ${token}`;
  }
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!res.ok) {
    const err = new Error(`Supabase ${res.status}`);
    err.detail = await res.text().catch(() => "");
    throw err;
  }
  return res.status === 204 ? null : res.json();
}

// דיווחים מאושרים ובתוקף (3 ימים מהאישור) ברשתות האלה. Map "chain_id:barcode" -> מחיר בשקלים
export async function fetchApprovedReports(chainIds) {
  const params = new URLSearchParams({
    select: "barcode,chain_id,price,decided_at",
    status: "eq.approved",
    chain_id: `in.(${chainIds.join(",")})`,
    order: "decided_at.asc",
  });
  const rows = await call(`price_reports?${params}`);
  // כמה דיווחים מאושרים לאותו מוצר: הזול מביניהם
  const map = new Map();
  for (const r of rows) {
    const key = `${r.chain_id}:${r.barcode}`;
    const price = Number(r.price);
    if (!map.has(key) || price < map.get(key)) map.set(key, price);
  }
  return map;
}

// מחזיר: ok, updated, limit, not_cheaper, no_price
export function submitReport({ barcode, chainId, itemCode, perKg, price }) {
  return call("rpc/submit_price_report", {
    method: "POST",
    auth: true,
    body: { p_barcode: barcode, p_chain_id: chainId, p_item_code: itemCode, p_per_kg: perKg, p_price: price },
  });
}

export function myReports() {
  return call("rpc/my_reports", { method: "POST", auth: true, body: {} });
}

// בקשות מאושרות, עם מספר הקולות, ואם המשתמש המחובר הצביע
export async function listRequests() {
  const signedIn = Boolean(getUser());
  return call("rpc/list_requests", { method: "POST", auth: signedIn, body: {} });
}

export function myRequests() {
  const params = new URLSearchParams({ select: "id,name,status,reject_reason,created_at", order: "created_at.desc" });
  return call(`product_requests?${params}`, { auth: true });
}

export function myVotes() {
  return call("request_votes?select=request_id", { auth: true });
}

export function myActiveVotes() {
  return call("rpc/my_active_votes", { method: "POST", auth: true, body: {} });
}

// מחזיר: ok, ok_no_vote, limit, invalid
export function submitRequest(name) {
  return call("rpc/submit_product_request", { method: "POST", auth: true, body: { p_name: name } });
}

// הצבעה. נכשלת עם voteLimit כשכבר יש 5 קולות פעילים
export async function vote(requestId) {
  try {
    await call("request_votes", {
      method: "POST",
      auth: true,
      prefer: "return=minimal",
      body: { user_id: getUser().id, request_id: requestId },
    });
  } catch (err) {
    if (err.detail?.includes("vote_limit")) err.voteLimit = true;
    throw err;
  }
}

export function unvote(requestId) {
  return call(`request_votes?request_id=eq.${Number(requestId)}`, { method: "DELETE", auth: true });
}
