
Marco19666
NomiCoseCitta
Repository navigation
Code
Issues
Pull requests
Agents
Actions
Projects
Wiki
Security and quality
Insights
Settings
Files
Go to file
t
T
worker
backups
index-2026-11-09.js
index.js
.assetsignore
README.md
app.js
index.html
style.css
wrangler.toml
NomiCoseCitta/worker
/index.js
Marco19666
Marco19666
Refactor Cloudflare Worker for Gemini API changes
88742fb
 · 
13 hours ago

Code

Blame
126 lines (110 loc) · 4 KB
// ============================================================
// Cloudflare Worker — Gemini come arbitro (senza binding AI)
// ============================================================

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
}

export default {
  async fetch(request, env) {
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders });
    }
    if (request.method !== 'POST') {
      return jsonResponse({ error: 'Method not allowed' }, 405);
    }

    let body;
    try {
      body = await request.json();
    } catch {
      return jsonResponse({ error: 'Invalid JSON' }, 400);
    }

    const word = String(body?.word || '').trim();
    const letter = String(body?.letter || '').trim().toUpperCase();
    const category = String(body?.category || 'Cose').trim();

    if (!word || !letter || letter.length !== 1 || word.length < 2) {
      return jsonResponse({ valid: false });
    }

    if (word[0].toUpperCase() !== letter) {
      return jsonResponse({ valid: false });
    }

    // Nessun binding AI: usiamo solo la chiave API di Gemini come secret
    const apiKey = env.GEMINI_API_KEY;
    if (!apiKey) {
      return jsonResponse({ error: 'GEMINI_API_KEY not configured' }, 500);
    }

    const systemInstruction = `Sei l'arbitro del gioco italiano "Nomi Cose Città".
Decidi se la parola "${word}" è valida come "${category}" e inizia con la lettera "${letter}".
Regole:
- La parola deve essere italiana, esistente e di senso compiuto.
- Deve appartenere alla categoria "${category}".
- Deve iniziare con la lettera "${letter}".
- Non sono valide: parole inventate, frasi, acronimi senza senso.`;

    const userPrompt = `Parola: "${word}"\nCategoria: "${category}"\nLettera: "${letter}"\nÈ valida?`;

    const geminiUrl =
      'https://generativelanguage.googleapis.com/v1beta/models/' +
      'gemini-2.5-flash-lite:generateContent';

    try {
      const geminiRes = await fetch(geminiUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-goog-api-key': apiKey,
        },
        body: JSON.stringify({
          systemInstruction: { parts: [{ text: systemInstruction }] },
          contents: [{ role: 'user', parts: [{ text: userPrompt }] }],
          generationConfig: {
            maxOutputTokens: 64,
            responseMimeType: 'application/json',
            responseSchema: {
              type: 'OBJECT',
              properties: {
                valid: { type: 'BOOLEAN' },
              },
              required: ['valid'],
            },
            thinkingConfig: { thinkingLevel: 'MINIMAL' },
          },
        }),
      });

      if (!geminiRes.ok) {
        const errText = await geminiRes.text();
        return jsonResponse({
          error: 'Gemini API error',
          status: geminiRes.status,
          detail: errText.slice(0, 300),
        }, 502);
      }

      const geminiData = await geminiRes.json();
      const candidate = geminiData?.candidates?.[0];
      const parts = candidate?.content?.parts || [];
      const responseText = parts.map(p => p.text || '').join('').trim();

      if (!responseText) {
        return jsonResponse({
          error: 'Gemini returned empty response',
          finishReason: candidate?.finishReason || 'UNKNOWN',
        }, 502);
      }

      try {
        const parsed = JSON.parse(responseText);
        return jsonResponse({ valid: parsed.valid === true });
      } catch {
        return jsonResponse({
          valid: false,
          warning: 'Unexpected Gemini response format',
          raw: responseText.slice(0, 100),
        });
      }
    } catch (error) {
      return jsonResponse({ error: 'Fetch failed', detail: String(error) }, 500);
    }
  },
};
While the code is focused, press Alt+F1 for a menu of operations.
