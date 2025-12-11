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

## Streaming API (תשובות בזמן אמת)

השרת תומך ב-streaming של תשובות באמצעות Server-Sent Events (SSE), כך שהתשובה מופיעה token-by-token בזמן אמת במקום להמתין לכל התשובה.

### Endpoint: `/api/ask/stream`

שולח POST request עם:
```json
{
  "email": "your-email@ariel.ac.il",
  "prompt": "השאלה שלך כאן"
}
```

התגובה היא SSE stream עם events:
- `{"type":"token","content":"..."}` - כל token של התשובה
- `{"type":"done"}` - סיום התשובה
- `{"type":"error","message":"..."}` - שגיאה

### דוגמה ל-Frontend (JavaScript/React)

```javascript
async function askWithStreaming(email, prompt, onToken, onDone, onError) {
  const response = await fetch('/api/ask/stream', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ email, prompt })
  });

  if (!response.ok) {
    onError('Network error');
    return;
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop(); // שמירת השורה האחרונה שלא הושלמה

    for (const line of lines) {
      if (line.startsWith('data: ')) {
        try {
          const data = JSON.parse(line.slice(6));
          if (data.type === 'token') {
            onToken(data.content);
          } else if (data.type === 'done') {
            onDone();
            return;
          } else if (data.type === 'error') {
            onError(data.message);
            return;
          }
        } catch (e) {
          console.error('Parse error:', e);
        }
      }
    }
  }
}

// שימוש:
let fullAnswer = '';
askWithStreaming(
  'user@example.com',
  'מה זה סטטיסטיקה?',
  (token) => {
    fullAnswer += token;
    // עדכון UI עם התשובה החלקית
    updateChatUI(fullAnswer);
  },
  () => {
    console.log('Stream completed');
  },
  (error) => {
    console.error('Error:', error);
  }
);
```

### דוגמה ל-React Hook

```javascript
import { useState, useCallback } from 'react';

function useStreamingChat() {
  const [answer, setAnswer] = useState('');
  const [isStreaming, setIsStreaming] = useState(false);
  const [error, setError] = useState(null);

  const ask = useCallback(async (email, prompt) => {
    setAnswer('');
    setIsStreaming(true);
    setError(null);

    try {
      const response = await fetch('/api/ask/stream', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, prompt })
      });

      if (!response.ok) throw new Error('Network error');

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop();

        for (const line of lines) {
          if (line.startsWith('data: ')) {
            const data = JSON.parse(line.slice(6));
            if (data.type === 'token') {
              setAnswer(prev => prev + data.content);
            } else if (data.type === 'done') {
              setIsStreaming(false);
              return;
            } else if (data.type === 'error') {
              throw new Error(data.message);
            }
          }
        }
      }
    } catch (err) {
      setError(err.message);
      setIsStreaming(false);
    }
  }, []);

  return { answer, isStreaming, error, ask };
}
```

### הגדרת משתנה סביבה

ניתן להשבית streaming דרך משתנה סביבה:
- `ENABLE_STREAMING=false` - משבית את ה-streaming endpoint (ברירת מחדל: true)

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
