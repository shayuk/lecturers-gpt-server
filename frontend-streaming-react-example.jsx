// React Hook לדוגמה - שימוש ב-streaming
import { useState, useCallback, useRef } from 'react';

const API_URL = 'https://lecturers-gpt-server.onrender.com/api/ask/stream';
// או להשתמש ב: const API_URL = 'https://lecturers-gpt-server.onrender.com/api/ask?stream=true';

export function useStreamingChat() {
  const [answer, setAnswer] = useState('');
  const [sources, setSources] = useState(null);
  const [isStreaming, setIsStreaming] = useState(false);
  const [error, setError] = useState(null);
  const abortControllerRef = useRef(null);

  const ask = useCallback(async (email, prompt) => {
    setAnswer('');
    setSources(null);
    setIsStreaming(true);
    setError(null);

    // יצירת AbortController לביטול הבקשה
    abortControllerRef.current = new AbortController();

    try {
      const response = await fetch(API_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ email, prompt }),
        signal: abortControllerRef.current.signal
      });

      if (!response.ok) {
        throw new Error(`HTTP error! status: ${response.status}`);
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      let fullAnswer = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop(); // שמירת השורה האחרונה שלא הושלמה

        for (const line of lines) {
          if (line.trim() === '') continue;
          
          // טיפול ב-SSE format
          if (line.startsWith('data: ')) {
            try {
              const data = JSON.parse(line.slice(6));
              
              if (data.type === 'token') {
                fullAnswer += data.content;
                setAnswer(fullAnswer);
              } else if (data.type === 'sources') {
                setSources(data.sources);
              } else if (data.type === 'done') {
                setIsStreaming(false);
                return;
              } else if (data.type === 'error') {
                throw new Error(data.message);
              }
            } catch (e) {
              console.error('Parse error:', e, 'Line:', line);
            }
          } else if (line.startsWith(': ')) {
            // Comment line - ignore
            continue;
          }
        }
      }
    } catch (err) {
      if (err.name === 'AbortError') {
        console.log('Request aborted');
      } else {
        setError(err.message);
        setIsStreaming(false);
      }
    }
  }, []);

  const cancel = useCallback(() => {
    if (abortControllerRef.current) {
      abortControllerRef.current.abort();
      setIsStreaming(false);
    }
  }, []);

  return { answer, sources, isStreaming, error, ask, cancel };
}

// דוגמה לשימוש ב-Component
export function ChatComponent() {
  const { answer, sources, isStreaming, error, ask, cancel } = useStreamingChat();
  const [email, setEmail] = useState('test@ariel.ac.il');
  const [prompt, setPrompt] = useState('');

  const handleSubmit = (e) => {
    e.preventDefault();
    if (email && prompt) {
      ask(email, prompt);
    }
  };

  return (
    <div>
      <form onSubmit={handleSubmit}>
        <input
          type="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          placeholder="כתובת מייל"
        />
        <input
          type="text"
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          placeholder="שאלה..."
        />
        <button type="submit" disabled={isStreaming}>
          {isStreaming ? 'שולח...' : 'שלח'}
        </button>
        {isStreaming && (
          <button type="button" onClick={cancel}>
            בטל
          </button>
        )}
      </form>

      {error && <div style={{ color: 'red' }}>שגיאה: {error}</div>}

      <div>
        <h3>תשובה:</h3>
        <div style={{ whiteSpace: 'pre-wrap' }}>{answer}</div>
      </div>

      {sources && sources.length > 0 && (
        <div>
          <h4>מקורות:</h4>
          <ul>
            {sources.map((source, i) => (
              <li key={i}>
                {source.source} (דמיון: {(source.score * 100).toFixed(1)}%)
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

