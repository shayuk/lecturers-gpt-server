# שרת ביניים לבוט המרצים (Email Gating + לוג טוקנים)

## התקנה מקומית
1. התקיני Node.js גרסה 18+.
2. הפעלי במסוף:
   ```bash
   npm install
   cp .env.example .env
   # מלאי את ה־.env בערכים הנכונים
   npm run dev
   ```

## משתני סביבה (.env)
- `OPENAI_API_KEY` – מפתח ה־OpenAI שלך.
- `OPENAI_MODEL` – ברירת מחדל: gpt-4o-mini (אפשר לשנות לדגם אחר שיש לך גישה אליו).
- `FIREBASE_PROJECT_ID`, `FIREBASE_CLIENT_EMAIL`, `FIREBASE_PRIVATE_KEY` – פרטי Service Account.

> הערה: ב־Render/Heroku יש לשים לב ש־`FIREBASE_PRIVATE_KEY` מכיל `\n` במקום שורות אמיתיות.

## פריסת ענן מהירה (Render)
1. צרי שירות Web חדש על בסיס GitHub או העלאת קבצים.
2. הגדרי Build Command ריק (Node ללא בנייה) ו־Start Command: `node index.js`.
3. הגדירי Environment Variables לפי `.env.example`.
4. לאחר פריסה תתקבלי על URL ציבורי, עדכני אותו ב־`openapi.json` תחת `servers[0].url`.

## חיבור ל־My GPT (Actions)
1. פותחים את ה־GPT בעורך → לשונית **Actions** → **Import OpenAPI schema**.
2. מדביקים את תוכן הקובץ `openapi.json` (אחרי שמעדכנים את ה־URL).
3. מגדירים את הפעולה `askAPI` לשימוש כברירת מחדל.

## הודעת שגיאת 403
במקרה שכתובת המייל אינה מורשית, השרת יחזיר הודעה מפורטת למשתמש כולל כתובת המייל לפנייה: teachinginnovation@ariel.ac.il.

## בדיקה
שלחי בקשה דרך ה־GPT עם גוף JSON מתאים ובדקי שההרשאות והלוגים עובדים כמצופה.
