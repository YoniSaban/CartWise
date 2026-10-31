// הפונקציה ב-Vercel: POST /api/substitutes
// מיילסטון 1: מחזירה JSON קבוע. הלוגיקה של החלופות נבנית במיילסטון 5.

const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN;

function setCors(req, res) {
  const origin = req.headers.origin;
  if (origin && origin === ALLOWED_ORIGIN) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");
    res.setHeader("Access-Control-Max-Age", "86400");
  }
  res.setHeader("Vary", "Origin");
  return !origin || origin === ALLOWED_ORIGIN;
}

export default function handler(req, res) {
  const allowed = setCors(req, res);

  if (!allowed) {
    return res.status(403).json({ error: "המקור לא מורשה" });
  }
  if (req.method === "OPTIONS") {
    return res.status(204).end();
  }
  if (req.method !== "POST") {
    return res.status(405).json({ error: "רק POST" });
  }

  return res.status(200).json({ results: [], status: "ok", milestone: 1 });
}
