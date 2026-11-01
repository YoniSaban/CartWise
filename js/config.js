// כתובת Supabase והמפתח הציבורי (publishable). מותר בריפו: מוגן בהרשאות הטבלה.
// אסור לשים כאן מפתח סודי.
export const SUPABASE_URL = "https://myfvbmcmpdxtxubdraaq.supabase.co";
export const SUPABASE_PUBLISHABLE_KEY = "sb_publishable__czUQMGTLMaDWpXlrlPxvg_Iwqk483j";

// כתובת הפונקציה ב-Vercel. בהרצה מקומית: שרת הפיתוח המקומי מעביר את הבקשה ל-Vercel,
// כי הפונקציה מקבלת בקשות מהדפדפן רק מהכתובת של האתר.
export const FUNCTION_URL = location.hostname === "localhost"
  ? "/api/substitutes"
  : "https://cartwise-pied.vercel.app/api/substitutes";
