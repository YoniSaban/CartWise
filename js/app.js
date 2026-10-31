// מעבר בין מסכים. במיילסטון 1: רק בדיקת החיבורים.
import { FUNCTION_URL } from "./config.js";
import { fetchTestRow, tryWrite } from "./prices.js";

function show(id, text, state) {
  const el = document.getElementById(id);
  el.textContent = text;
  el.classList.remove("ok", "fail");
  if (state) el.classList.add(state);
}

async function checkSupabase() {
  try {
    const row = await fetchTestRow();
    if (!row) return show("check-supabase", "✗ מחובר, אבל שורת הבדיקה עוד לא נכתבה", "fail");
    const when = new Date(row.loaded_at).toLocaleString("he-IL");
    show("check-supabase", `✓ ${row.item_name} · ₪${Number(row.price).toFixed(2)} · נכתב ${when}`, "ok");
  } catch (err) {
    show("check-supabase", `✗ אין חיבור (${err.message})`, "fail");
  }
}

async function checkFunction() {
  try {
    const res = await fetch(FUNCTION_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ missing: [] }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
    show("check-function", `✓ הפונקציה ענתה: ${data.status} (מיילסטון ${data.milestone})`, "ok");
  } catch (err) {
    show("check-function", `✗ הקריאה נחסמה או נכשלה (${err.message}). מקומית זה צפוי: הפונקציה מאשרת רק את כתובת האתר.`, "fail");
  }
}

async function checkWrite() {
  const btn = document.getElementById("btn-write");
  btn.disabled = true;
  show("check-write", "מנסה לכתוב...");
  try {
    const { ok, status } = await tryWrite();
    if (ok) show("check-write", "✗ הכתיבה הצליחה, וזה לא בסדר: צריך לחסום אותה", "fail");
    else show("check-write", `✓ נחסם, כמו שצריך (HTTP ${status})`, "ok");
  } catch (err) {
    show("check-write", `✓ נחסם, כמו שצריך (${err.message})`, "ok");
  }
  btn.disabled = false;
}

document.getElementById("btn-write").addEventListener("click", checkWrite);
checkSupabase();
checkFunction();
