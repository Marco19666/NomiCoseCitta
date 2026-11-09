// ============================================================
// Cloudflare Worker — Gemini 3.5 Flash-Lite come arbitro
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
- Non sono valide: parole inventate, frasi, acronimi senza senso.
Rispondi SOLO con "sì" o "no". Nessun'altra parola.`;

    const userPrompt = `Parola: "${word}"\nCategoria: "${category}"\nLettera: "${letter}"\nÈ valida?`;

    // Modello corretto: gemini-3.5-flash-lite (non 3.6-flash-lite che non esiste)
    const geminiUrl =
      'https://generativelanguage.googleapis.com/v1beta/models/' +
      'gemini-3.5-flash-lite:generateContent';

    try {
      const geminiRes = await fetch(`${geminiUrl}?key=${encodeURIComponent(apiKey)}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          systemInstruction: { parts: [{ text: systemInstruction }] },
          contents: [{ role: 'user', parts: [{ text: userPrompt }] }],
          generationConfig: {
            // 3.5 Flash-Lite supporta thinkingLevel con MINIMAL (default) o LOW
            thinkingConfig: { thinkingLevel: 'MINIMAL' },
            maxOutputTokens: 16,
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
      const responseText = parts.map(p => p.text || '').join('').trim().toLowerCase();

      if (!responseText) {
        return jsonResponse({
          error: 'Gemini returned empty response',
          finishReason: candidate?.finishReason || 'UNKNOWN',
        }, 502);
      }

      const normalized = responseText.replace(/[.!]+$/g, '').trim();

      if (normalized === 'sì' || normalized === 'si') {
        return jsonResponse({ valid: true });
      }
      if (normalized === 'no') {
        return jsonResponse({ valid: false });
      }

      // Risposta inattesa: la trattiamo come non valida, ma logghiamo
      return jsonResponse({
        valid: false,
        warning: 'Unexpected Gemini response',
        raw: responseText.slice(0, 50),
      });
    } catch (error) {
      return jsonResponse({ error: 'Fetch failed', detail: String(error) }, 500);
    }
  },
};
