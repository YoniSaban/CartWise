// התחברות עם Google דרך Supabase Auth, בלי ספרייה: fetch ל-REST API של Auth.
// הטוקנים של המשתמש נשמרים ב-localStorage. זה הטוקן של המשתמש עצמו, לא סוד של האתר.
import { SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY } from "./config.js?v=11";

const SESSION_KEY = "cartwise-session";
const PENDING_KEY = "cartwise-pending-action";
// מחדשים את הטוקן כשנשארו פחות מ-5 דקות
const REFRESH_MARGIN = 5 * 60;

let session = null;
const listeners = new Set();

function now() {
  return Math.floor(Date.now() / 1000);
}

function save(next) {
  session = next;
  if (next) localStorage.setItem(SESSION_KEY, JSON.stringify(next));
  else localStorage.removeItem(SESSION_KEY);
  listeners.forEach((fn) => fn(getUser()));
}

function headers(token) {
  const h = { apikey: SUPABASE_PUBLISHABLE_KEY, "Content-Type": "application/json" };
  if (token) h.Authorization = `Bearer ${token}`;
  return h;
}

// הכתובת שאליה Google מחזיר: הדף הנוכחי, בלי חיפוש ובלי #
function returnUrl() {
  return location.origin + location.pathname;
}

// אחרי החזרה מ-Google הטוקנים בכתובת, אחרי #. קוראים ומנקים מיד
function readHash() {
  if (!location.hash.includes("access_token") && !location.hash.includes("error")) return null;
  const params = new URLSearchParams(location.hash.slice(1));
  history.replaceState(history.state, "", location.pathname + location.search);
  if (params.get("error")) return { error: params.get("error_description") || params.get("error") };
  const expiresIn = Number(params.get("expires_in")) || 3600;
  return {
    access_token: params.get("access_token"),
    refresh_token: params.get("refresh_token"),
    expires_at: Number(params.get("expires_at")) || now() + expiresIn,
  };
}

async function fetchUser(token) {
  const res = await fetch(`${SUPABASE_URL}/auth/v1/user`, { headers: headers(token) });
  if (!res.ok) throw new Error(`user ${res.status}`);
  const u = await res.json();
  const meta = u.user_metadata || {};
  return {
    id: u.id,
    email: u.email,
    name: meta.full_name || meta.name || u.email,
    avatar: meta.avatar_url || meta.picture || "",
  };
}

async function refresh() {
  const res = await fetch(`${SUPABASE_URL}/auth/v1/token?grant_type=refresh_token`, {
    method: "POST",
    headers: headers(),
    body: JSON.stringify({ refresh_token: session.refresh_token }),
  });
  if (!res.ok) throw new Error(`refresh ${res.status}`);
  const data = await res.json();
  save({
    ...session,
    access_token: data.access_token,
    refresh_token: data.refresh_token,
    expires_at: data.expires_at || now() + (data.expires_in || 3600),
  });
}

// טוקן בתוקף לקריאה ל-Supabase, או null כשלא מחובר. מחדש לפי הצורך
export async function getToken() {
  if (!session) return null;
  if (session.expires_at - now() < REFRESH_MARGIN) {
    try {
      await refresh();
    } catch {
      save(null);
      return null;
    }
  }
  return session.access_token;
}

export function getUser() {
  return session?.user || null;
}

export function onChange(fn) {
  listeners.add(fn);
}

// מחזיר { error } אם החזרה מ-Google נכשלה, ואת הפעולה שהמשתמש התחיל לפני הכניסה (אם יש)
export async function init() {
  const fromHash = readHash();
  if (fromHash?.error) {
    sessionStorage.removeItem(PENDING_KEY);
    return { error: fromHash.error };
  }
  if (fromHash) {
    try {
      const user = await fetchUser(fromHash.access_token);
      save({ ...fromHash, user });
    } catch {
      return { error: "הכניסה לא הצליחה" };
    }
    const pending = sessionStorage.getItem(PENDING_KEY);
    sessionStorage.removeItem(PENDING_KEY);
    return { pending };
  }

  try {
    session = JSON.parse(localStorage.getItem(SESSION_KEY));
  } catch {
    session = null;
  }
  if (!session?.refresh_token || !session.user) {
    session = null;
    return {};
  }
  // מוודא שהחיבור עדיין תקף (למשל, שהחשבון לא נמחק ממכשיר אחר)
  const token = await getToken();
  if (token) {
    try {
      save({ ...session, user: await fetchUser(token) });
    } catch (e) {
      if (/user 40[13]/.test(e.message)) save(null);
    }
  }
  listeners.forEach((fn) => fn(getUser()));
  return {};
}

// מעבר ל-Google. pendingAction: הפעולה שתמשיך אחרי החזרה
export function signIn(pendingAction) {
  if (pendingAction) sessionStorage.setItem(PENDING_KEY, pendingAction);
  const url = new URL(`${SUPABASE_URL}/auth/v1/authorize`);
  url.searchParams.set("provider", "google");
  url.searchParams.set("redirect_to", returnUrl());
  location.assign(url.toString());
}

export async function signOut() {
  const token = session?.access_token;
  save(null);
  if (token) {
    // גם אם השרת לא עונה, בדפדפן המשתמש כבר מנותק
    await fetch(`${SUPABASE_URL}/auth/v1/logout`, { method: "POST", headers: headers(token) }).catch(() => {});
  }
}

// מוחק את החשבון ואת כל המידע שלו (פונקציה ב-Supabase שמוחקת רק את המשתמש המחובר)
export async function deleteAccount() {
  const token = await getToken();
  if (!token) throw new Error("not signed in");
  const res = await fetch(`${SUPABASE_URL}/rest/v1/rpc/delete_my_account`, {
    method: "POST",
    headers: headers(token),
    body: "{}",
  });
  if (!res.ok) throw new Error(`delete ${res.status}`);
  save(null);
}
