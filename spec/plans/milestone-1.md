# Milestone 1: Walking Skeleton, תוכנית

נכתב ב-31.10.2026, לפי `MILESTONES.md`, `ARCHITECTURE.md` ו-`course-stack.md`.

## המטרה
כל החלקים מחוברים ורצים מקצה לקצה, בלי אף פיצ'ר: דף באוויר שקורא שורת בדיקה מ-Supabase (שנכתבה על ידי n8n), קורא לפונקציה ב-Vercel, ומציג את שתי התשובות.

## מצב פתיחה (נבדק)
- ריפו ציבורי `YoniSaban/CartWise`, ענף main, GitHub Pages פעיל מהשורש.
- Supabase: ארגון `YoniSaban` קיים, אין עדיין פרויקט.
- Vercel: חשבון אישי, אין פרויקט ל-CartWise.
- n8n: לא מותקן. Node 24 מותקן.

## מה בונים

| מס' | חלק | מה בדיוק | מי עושה |
|---:|---|---|---|
| 1 | מבנה תיקיות | לפי סעיף 7 ב-`ARCHITECTURE.md`: `css/`, `js/`, `data/`, `api/`, `n8n/`, `package.json` עם `"type": "module"`. קבצים שעוד אין להם תוכן נשארים קטנים, עם הערה למיילסטון שבו הם נבנים | Claude |
| 2 | `index.html` | כותרת "סל חכם" ברקע כחול כהה, `lang="he" dir="rtl"`, גופן Rubik, צבעים מ-`DESIGN.md`. אזור "בדיקת חיבורים" עם שלוש שורות: Supabase, הפונקציה, וניסיון כתיבה | Claude |
| 3 | פרויקט Supabase | פרויקט `cartwise` בתוכנית החינמית, באזור פרנקפורט (הקרוב לישראל) | Claude, אחרי אישורך |
| 4 | טבלאות | `chain_items` ו-`substitutes` עם השדות מסעיף 2 ב-`ARCHITECTURE.md`. RLS פעיל, ומדיניות אחת לכל טבלה: קריאה בלבד ל-`anon` | Claude |
| 5 | `js/config.js` | כתובת Supabase והמפתח הציבורי (publishable). מותר בריפו | Claude |
| 6 | `api/substitutes.js` | מחזיר JSON קבוע: `{ "results": [], "status": "ok", "milestone": 1 }`. CORS רק מ-`ALLOWED_ORIGIN`, עונה ל-OPTIONS, מקבל רק POST, ותמיד מחזיר JSON | Claude |
| 7 | פרויקט Vercel | מחובר לריפו, כל דחיפה ל-main פורסת. בלי שלב בנייה | Claude, ואם GitHub צריך הרשאה, אתה |
| 8 | משתני סביבה ב-Vercel | `ALLOWED_ORIGIN`, `SUPABASE_URL`, `GEMINI_MODEL`, `GEMINI_FALLBACK_MODEL` אני מגדיר. **`SUPABASE_SECRET_KEY` ו-`GEMINI_API_KEY` אתה מדביק בעצמך** בדשבורד, כי אני לא נוגע במפתחות סודיים | חלוקה |
| 9 | n8n | הפעלה מקומית עם `npx n8n`. אתה יוצר משתמש ומגדיר Credential של Supabase עם המפתח הסודי. אני מכין Workflow לייבוא (בלי סודות): Manual Trigger, ואז Supabase שכותב שורת בדיקה אחת ל-`chain_items` | חלוקה |
| 10 | `builds/milestone-1.zip` | index.html, css, js, data, assets | Claude |

### שורת הבדיקה ש-n8n כותב

| מס' | שדה | ערך |
|---:|---|---|
| 1 | `chain_id` | `test` |
| 2 | `item_code` | `0000000000000` |
| 3 | `item_name` | `שורת בדיקה מ-n8n` |
| 4 | `price` | `1.00` |
| 5 | `loaded_at` | זמן ההרצה |

בהמשך (מיילסטון 3) מוחקים את השורה הזו.

## סדר העבודה
1. קוד: מבנה תיקיות, `index.html`, `css/style.css`, `js/app.js`, `api/substitutes.js`, `package.json`.
2. Supabase: פרויקט, טבלאות, RLS, ו-`js/config.js`.
3. Vercel: פרויקט, משתני סביבה. עוצרים כדי שתדביק את שני המפתחות הסודיים.
4. n8n: מפעיל, עוצרים כדי שתיצור משתמש ו-Credential, מייבאים את ה-Workflow ומריצים.
5. הרצה מקומית: הדף ב-`http://localhost:8080`. שורת Supabase תוצג. הפונקציה תיחסם מקומית, וזה בכוונה: זו ההוכחה שקריאה מכתובת אחרת נחסמת.
6. דחיפה ל-main, בדיקה בלינק החי בטלפון ובמחשב, ו-zip.

## איך בודקים את תנאי ההשלמה

| מס' | תנאי | איך בודקים |
|---:|---|---|
| 1 | הדף נפתח בטלפון ובמחשב | פותחים את https://yonisaban.github.io/CartWise/ בשניהם |
| 2 | שורת הבדיקה מוצגת | בדף, בשורה "Supabase": "שורת בדיקה מ-n8n · ₪1.00" |
| 3 | תשובת הפונקציה מוצגת, וקריאה מכתובת אחרת נחסמת | בדף החי: "הפונקציה: ok". מקומית (localhost) הקריאה נחסמת. בנוסף בדיקה עם `curl` ו-Origin זר: אין כותרת `Access-Control-Allow-Origin` |
| 4 | כתיבה מהדפדפן נכשלת | כפתור "נסה לכתוב ל-Supabase" בדף: מוצג "נחסם, כמו שצריך" |
| 5 | אין מפתח סודי בריפו | `git grep` על `sb_secret_`, `SUPABASE_SECRET_KEY=`, `GEMINI_API_KEY=` ו-`AIza` לא מחזיר ערכים |

## החלטות
- **המפתח הציבורי:** ה-publishable key החדש של Supabase (`sb_publishable_...`), במקום ה-anon הישן. זה מה ש-Supabase ממליצה היום.
- **אזור בדיקה בדף:** אזור "בדיקת חיבורים" זמני. הוא יוחלף במסך "בניית הסל" במיילסטון 2.
- **שתי כתובות:** האתר נשאר ב-GitHub Pages. Vercel משמש רק לפונקציה, ולכן `ALLOWED_ORIGIN` הוא `https://yonisaban.github.io`.
- **n8n Workflow:** לא נכנס לריפו במיילסטון הזה. הייצוא לריפו (`n8n/daily-prices.json`) הוא חלק ממיילסטון 6.
- **ריצה מקומית:** שרת סטטי פשוט עם `npx http-server`, בלי להתקין כלום בפרויקט.
