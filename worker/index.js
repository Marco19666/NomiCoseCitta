// ============================================================
// Cloudflare Worker — Gemini come unico arbitro
// ============================================================
// Riceve POST { word, letter, category }
// Risponde { valid: true|false, raw: "..." }
// Richiede il secret GEMINI_API_KEY

export default {
  async fetch(request, env) {
    const cors = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    };

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: cors });
    }

    if (request.method !== 'POST') {
      return reply({ error: 'Method not allowed' }, 405, cors);
    }

    let body;
    try {
      body = await request.json();
    } catch {
      return reply({ error: 'Invalid JSON' }, 400, cors);
    }

    const word = String(body?.word || '').trim();
    const letter = String(body?.letter || '').trim().toUpperCase();
    const category = String(body?.category || 'Cose').trim();

    if (!word || !letter) {
      return reply({ error: 'Missing word or letter' }, 400, cors);
    }

    const apiKey = env.GEMINI_API_KEY;
    if (!apiKey) {
      return reply({ error: 'GEMINI_API_KEY not configured' }, 500, cors);
    }

    const prompt = buildPrompt(word, letter, category);

    const geminiUrl =
      'https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=' +
      encodeURIComponent(apiKey);

    let geminiRes;
    try {
      geminiRes = await fetch(geminiUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ role: 'user', parts: [{ text: prompt }] }],
          generationConfig: {
            temperature: 0,
            maxOutputTokens: 4,
          },
        }),
      });
    } catch (e) {
      return reply({ error: 'Network error', detail: String(e) }, 502, cors);
    }

    if (!geminiRes.ok) {
      const detail = await geminiRes.text();
      return reply(
        { error: 'Gemini error', status: geminiRes.status, detail: detail.slice(0, 200) },
        502,
        cors
      );
    }

    let geminiData;
    try {
      geminiData = await geminiRes.json();
    } catch {
      return reply({ error: 'Invalid Gemini JSON' }, 502, cors);
    }

    const raw =
      geminiData?.candidates?.[0]?.content?.parts?.[0]?.text || '';
    const answer = raw.trim().toLowerCase();
    const valid = /^s[iì]/.test(answer);

    return reply({ valid, raw: answer }, 200, cors);
  },
};

// ------------------------------------------------------------
// Prompt per Gemini
// ------------------------------------------------------------
function buildPrompt(word, letter, category) {
  return `Sei l'arbitro del gioco italiano "Nomi Cose Città".
Devi decidere se la parola "${word}" è valida come "${category}" e inizia con la lettera "${letter}".

Regole:
- La parola deve essere una parola italiana esistente e di senso compiuto.
- Deve appartenere alla categoria "${category}".
  - Cose: oggetto, concetto concreto, cosa materiale o astratta.
  - Nomi: nome proprio di persona (maschile o femminile).
  - Città: città italiana o estera riconosciuta.
  - Animali: specie animale.
  - Mestieri: professione o lavoro riconosciuto.
  - Colori: colore.
  - Film: titolo di un film conosciuto.
  - Cantanti: nome o cognome di un cantante conosciuto.
  - Sport: disciplina sportiva.
  - Cibo: alimento, piatto o bevanda.
- Deve iniziare con la lettera "${letter}" (maiuscola o minuscola è indifferente).
- NON sono valide: parole inventate, acronimi senza senso, frasi, nomi di una sola lettera, parole generiche senza significato nella categoria.

Rispondi SOLO con "sì" se la parola è valida, oppure "no" se non lo è.
Nessun'altra parola. Nessuna spiegazione. Nessuna punteggiatura.`;
}

// ------------------------------------------------------------
// Helper risposta JSON
// ------------------------------------------------------------
function reply(obj, status, headers) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { ...headers, 'Content-Type': 'application/json' },
  });
}
