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
- `USE_RAG` – הפעלת RAG (ברירת מחדל: true).

> הערה: ב־Render/Heroku יש לשים לב ש־`FIREBASE_PRIVATE_KEY` מכיל `\n` במקום שורות אמיתיות.

## הגדרת RAG (Retrieval-Augmented Generation)

השרת תומך ב-RAG כדי שהבוט יוכל לשאוב מידע מחומרי הקורס. המערכת משתמשת ב-Firestore לאחסון embeddings (ללא צורך בשירותים חיצוניים נוספים).

### שלב 1: הגדרת משתני סביבה
הוסיפי ל-Render/Heroku:
- `USE_RAG` = true (ברירת מחדל)
- ודאי ש-Firebase מוגדר נכון (נדרש ל-RAG)

### שלב 2: העלאת חומרי קורס

#### אפשרות 1: העלאת טקסט ישיר
שלחי POST request ל-`/api/upload-course-material` עם `Content-Type: application/json`:

```json
{
  "email": "your-email@ariel.ac.il",
  "text": "תוכן חומרי הקורס כאן...",
  "source": "שם המסמך/מקור",
  "course_name": "statistics"
}
```

#### אפשרות 2: העלאת קובץ PDF
שלחי POST request ל-`/api/upload-course-material` עם `Content-Type: multipart/form-data`:

- `email`: כתובת המייל
- `pdf`: קובץ PDF (עד 10MB)
- `source`: שם המסמך (אופציונלי - יקבע אוטומטית משם הקובץ)
- `course_name`: שם הקורס (ברירת מחדל: "statistics")

**דוגמה ב-cURL:**
```bash
curl -X POST https://your-server.com/api/upload-course-material \
  -F "email=your-email@ariel.ac.il" \
  -F "pdf=@/path/to/file.pdf" \
  -F "source=שם המסמך" \
  -F "course_name=statistics"
```

**דוגמה ב-JavaScript (fetch):**
```javascript
const formData = new FormData();
formData.append('email', 'your-email@ariel.ac.il');
formData.append('pdf', fileInput.files[0]);
formData.append('source', 'שם המסמך');
formData.append('course_name', 'statistics');

fetch('https://your-server.com/api/upload-course-material', {
  method: 'POST',
  body: formData
});
```

השרת יחלק את הטקסט (או ימציא טקסט מ-PDF) לקטעים, ייצור embeddings עם OpenAI וישמור אותם ב-Firestore.

### שימוש
לאחר העלאת החומרים, הבוט ישתמש בהם אוטומטית בעת מענה על שאלות. התשובות יתבססו על חומרי הקורס שהועלו באמצעות חיפוש similarity ב-Firestore.

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
