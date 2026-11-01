// הפונקציה ב-Vercel: POST /api/substitutes
// גוף: { missing: [{ chain_id, barcode }] }. תשובה: { results: [{ chain_id, barcode, suggested_item_code, reason, cached }] }
// המסלול: מטמון בטבלה substitutes, מועמדים מ-chain_items לפי keywords, קריאה ל-Gemini, בדיקה בקוד ושמירה.
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const products = require("../data/products.json");
const chains = require("../data/chains.json");

const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SECRET_KEY = process.env.SUPABASE_SECRET_KEY;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const GEMINI_MODEL = process.env.GEMINI_MODEL;
const GEMINI_FALLBACK_MODEL = process.env.GEMINI_FALLBACK_MODEL;

const MAX_PAIRS = 67;
const MAX_CANDIDATES = 30;
const BATCH_SIZE = 10;
const MAX_REASON = 120;
// תשובה איטית מהמודל נחשבת כשל, כדי שהמשתמש לא יחכה דקות
const GEMINI_TIMEOUT_MS = 30000;

const byBarcode = new Map(products.map((p) => [p.barcode, p]));
const chainIds = new Set(chains.map((c) => c.chain_id));

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

// קריאה ל-Supabase עם המפתח הסודי. רק כאן, בצד השרת.
// מפתח מהסוג החדש (sb_secret_) נשלח רק בכותרת apikey, לא כ-Bearer.
async function supabase(path, options = {}) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    ...options,
    headers: {
      apikey: SUPABASE_SECRET_KEY,
      "Content-Type": "application/json",
      ...options.headers,
    },
  });
  if (!res.ok) throw new Error(`Supabase ${res.status}`);
  return res.status === 204 || res.status === 201 ? null : res.json();
}

const key = (chainId, barcode) => `${chainId}:${barcode}`;
const inList = (values) => `in.(${values.map((v) => `"${v}"`).join(",")})`;

// הקוד של המוצר ברשת: בדרך כלל הברקוד, אלא אם הרשת משתמשת בקוד אחר
function codeIn(chainId, product) {
  return product.chain_codes?.[chainId] ?? product.barcode;
}

// המטמון: תשובות קודמות, כל עוד החלופה עדיין קיימת ברשת
async function readCache(pairs) {
  const rows = await supabase(
    `substitutes?select=chain_id,missing_barcode,suggested_item_code,reason` +
      `&missing_barcode=${encodeURIComponent(inList([...new Set(pairs.map((p) => p.barcode))]))}`
  );
  const wanted = new Set(pairs.map((p) => key(p.chain_id, p.barcode)));
  const hits = rows.filter((r) => wanted.has(key(r.chain_id, r.missing_barcode)));

  const suggested = hits.filter((r) => r.suggested_item_code);
  const alive = new Set();
  for (const chainId of new Set(suggested.map((r) => r.chain_id))) {
    const codes = suggested.filter((r) => r.chain_id === chainId).map((r) => r.suggested_item_code);
    const found = await supabase(
      `chain_items?select=item_code&chain_id=eq.${chainId}&item_code=${encodeURIComponent(inList(codes))}`
    );
    for (const f of found) alive.add(key(chainId, f.item_code));
  }

  const cache = new Map();
  for (const r of hits) {
    if (r.suggested_item_code && !alive.has(key(r.chain_id, r.suggested_item_code))) continue;
    cache.set(key(r.chain_id, r.missing_barcode), r);
  }
  return cache;
}

// "750" + "מ"ל" מהשם בקובץ ומ-products.json: מספר להשוואת גודל בלבד
function sizeNumber(text) {
  const m = String(text || "").match(/(\d+(?:\.\d+)?)/);
  return m ? Number(m[1]) : null;
}

// מועמדים בקוד: שורות של אותה רשת שהשם שלהן מכיל לפחות מילת מפתח אחת.
// מיון לפי מספר מילות המפתח שנמצאו, ואז קרבה בגודל. המוצר המקורי לא נכלל.
async function findCandidates(chainId, product) {
  const original = codeIn(chainId, product);
  const lists = await Promise.all(
    product.keywords.map((word) =>
      supabase(
        `chain_items?select=item_code,item_name,manufacturer,quantity,unit` +
          `&chain_id=eq.${chainId}&item_name=${encodeURIComponent(`ilike.*${word}*`)}&limit=300`
      )
    )
  );

  const rows = new Map();
  for (const row of lists.flat()) if (row.item_code !== original) rows.set(row.item_code, row);

  const target = sizeNumber(product.size);
  const score = (row) => product.keywords.filter((w) => row.item_name.includes(w)).length;
  const distance = (row) => {
    const q = Number(row.quantity);
    return target && q ? Math.abs(Math.log(q / target)) : 10;
  };
  return [...rows.values()]
    .sort((a, b) => score(b) - score(a) || distance(a) - distance(b))
    .slice(0, MAX_CANDIDATES);
}

const PROMPT = `אתה עוזר שמציע חלופה למוצר שחסר ברשת סופרמרקטים.
לכל מוצר חסר תקבל את שמו וגודלו, ורשימת מועמדים מאותה רשת (קוד, שם, יצרן, כמות, יחידה).

שלוש מגבלות, בלי יוצא מן הכלל:
1. בחר רק item_code מתוך רשימת המועמדים שקיבלת לאותו מוצר. אסור להמציא מוצר או מחיר.
2. רק מוצר מאותו סוג ובגודל קרוב. אם אין כזה, החזר null. אל תחליף בשקט בין סוגים, גדלים או כמויות.
3. התבסס רק על הרשימה שקיבלת, לא על ידע כללי. אם אין מוצר מתאים, דווח null במקום לנחש.

לכל מוצר החזר אובייקט אחד: id (כמו שקיבלת), suggested_item_code (או null), ו-reason: משפט קצר בעברית, עד 10 מילים, שמסביר את הבחירה (למשל "אותו סוג שמן, אותו גודל") או למה אין חלופה.`;

const RESPONSE_SCHEMA = {
  type: "ARRAY",
  items: {
    type: "OBJECT",
    properties: {
      id: { type: "STRING" },
      suggested_item_code: { type: "STRING", nullable: true },
      reason: { type: "STRING" },
    },
    required: ["id", "suggested_item_code", "reason"],
  },
};

class QuotaError extends Error {}

// כל דור של המודל מכבה את שלב החשיבה אחרת. Flash-Lite חושב מעט ממילא, ולכן בלי הגדרה.
function thinkingConfig(model) {
  if (model.includes("flash-lite")) return {};
  if (model.includes("2.5")) return { thinkingConfig: { thinkingBudget: 0 } };
  if (model.includes("3.6-flash")) return { thinkingConfig: { thinkingLevel: "minimal" } };
  return { thinkingConfig: { thinkingLevel: "low" } };
}

async function callGemini(model, input) {
  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-goog-api-key": GEMINI_API_KEY },
      signal: AbortSignal.timeout(GEMINI_TIMEOUT_MS),
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: PROMPT }] },
        contents: [{ role: "user", parts: [{ text: JSON.stringify(input) }] }],
        generationConfig: {
          temperature: 0,
          responseMimeType: "application/json",
          responseSchema: RESPONSE_SCHEMA,
          // בלי שלב "חשיבה": הבחירה מתוך רשימה קצרה לא צריכה אותו, והוא מאט מאוד
          ...thinkingConfig(model),
        },
      }),
    }
  );
  if (res.status === 429) throw new QuotaError("quota");
  if (!res.ok) throw new Error(`Gemini ${res.status}`);
  const data = await res.json();
  const text = data.candidates?.[0]?.content?.parts?.map((p) => p.text || "").join("");
  return JSON.parse(text);
}

// קריאה אחת לכל עד 10 מוצרים. בשגיאת מכסה: ניסיון אחד עם המודל החלופי.
async function askModel(input) {
  try {
    return { answer: await callGemini(GEMINI_MODEL, input), model: GEMINI_MODEL };
  } catch (err) {
    if (!(err instanceof QuotaError) || !GEMINI_FALLBACK_MODEL) throw err;
    return { answer: await callGemini(GEMINI_FALLBACK_MODEL, input), model: GEMINI_FALLBACK_MODEL };
  }
}

// בדיקת התשובה בקוד: כל suggested_item_code חייב להיות ברשימת המועמדים של אותו מוצר. אחרת null.
function checkAnswer(answer, jobs) {
  const byId = new Map(Array.isArray(answer) ? answer.filter((a) => a && typeof a === "object").map((a) => [String(a.id), a]) : []);
  return jobs.map((job, i) => {
    const a = byId.get(String(i));
    const code = typeof a?.suggested_item_code === "string" ? a.suggested_item_code.trim() : null;
    const valid = code && job.candidates.some((c) => c.item_code === code);
    let reason = typeof a?.reason === "string" ? a.reason.trim().slice(0, MAX_REASON) : "";
    if (!valid) reason = code ? "לא נמצאה חלופה מתאימה ברשת" : reason || "לא נמצאה חלופה מתאימה ברשת";
    return { chain_id: job.chain_id, barcode: job.barcode, suggested_item_code: valid ? code : null, reason };
  });
}

async function solveBatch(jobs) {
  // מוצר בלי מועמדים לא נשלח למודל
  const ask = jobs.filter((j) => j.candidates.length);
  const results = jobs
    .filter((j) => !j.candidates.length)
    .map((j) => ({ chain_id: j.chain_id, barcode: j.barcode, suggested_item_code: null, reason: "אין ברשת מוצרים דומים", model: null }));
  if (!ask.length) return results;

  const input = ask.map((job, i) => ({
    id: String(i),
    missing: { name: job.product.name, size: job.product.size, manufacturer: job.product.manufacturer || null },
    candidates: job.candidates.map((c) => ({
      item_code: c.item_code,
      name: c.item_name,
      manufacturer: c.manufacturer,
      quantity: c.quantity,
      unit: c.unit,
    })),
  }));
  const { answer, model } = await askModel(input);
  return results.concat(checkAnswer(answer, ask).map((r) => ({ ...r, model })));
}

async function saveCache(results) {
  if (!results.length) return;
  const now = new Date().toISOString();
  await supabase("substitutes?on_conflict=chain_id,missing_barcode", {
    method: "POST",
    headers: { Prefer: "resolution=merge-duplicates,return=minimal" },
    body: JSON.stringify(
      results.map((r) => ({
        chain_id: r.chain_id,
        missing_barcode: r.barcode,
        suggested_item_code: r.suggested_item_code,
        reason: r.reason,
        model: r.model,
        created_at: now,
      }))
    ),
  });
}

function parsePairs(body) {
  const missing = body?.missing;
  if (!Array.isArray(missing) || !missing.length || missing.length > MAX_PAIRS) return null;
  const seen = new Set();
  const pairs = [];
  for (const m of missing) {
    if (!chainIds.has(m?.chain_id) || !byBarcode.has(m?.barcode)) return null;
    const k = key(m.chain_id, m.barcode);
    if (!seen.has(k)) pairs.push({ chain_id: m.chain_id, barcode: m.barcode });
    seen.add(k);
  }
  return pairs;
}

export default async function handler(req, res) {
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

  const pairs = parsePairs(req.body);
  if (!pairs) {
    return res.status(400).json({ error: "בקשה לא תקינה" });
  }

  const started = Date.now();
  const timing = {};
  const mark = (name) => (timing[name] = Date.now() - started);

  try {
    const cache = await readCache(pairs);
    mark("cache");
    const results = [];
    const jobs = [];
    for (const p of pairs) {
      const hit = cache.get(key(p.chain_id, p.barcode));
      if (hit) {
        results.push({ ...p, suggested_item_code: hit.suggested_item_code, reason: hit.reason, cached: true });
      } else {
        jobs.push({ ...p, product: byBarcode.get(p.barcode) });
      }
    }

    await Promise.all(jobs.map(async (job) => (job.candidates = await findCandidates(job.chain_id, job.product))));
    mark("candidates");

    // מנה שנכשלה לא נשמרת, כדי שאפשר יהיה לנסות שוב. המוצרים בה חוזרים בלי חלופה.
    for (let i = 0; i < jobs.length; i += BATCH_SIZE) {
      const batch = jobs.slice(i, i + BATCH_SIZE);
      try {
        const solved = await solveBatch(batch);
        mark(`model${i}`);
        await saveCache(solved);
        mark(`save${i}`);
        for (const { model, ...r } of solved) results.push({ ...r, cached: false });
      } catch (err) {
        console.error("batch failed:", err.message);
        // קוד שגיאה קצר שלנו (למשל "Gemini 404"), בלי ההודעה הגולמית של הספק
        const code = /^(Gemini|Supabase) \d+$/.test(err.message) ? err.message
          : err instanceof QuotaError ? "quota" : err.name === "TimeoutError" ? "timeout" : "parse";
        for (const j of batch) {
          results.push({ chain_id: j.chain_id, barcode: j.barcode, suggested_item_code: null, reason: null, cached: false, error: code });
        }
      }
    }

    mark("total");
    return res.status(200).json({ results, timing });
  } catch (err) {
    console.error("substitutes failed:", err.message);
    return res.status(500).json({ error: "לא הצלחנו לבדוק חלופות כרגע" });
  }
}
