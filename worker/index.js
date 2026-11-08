// ============================================================
// Cloudflare Worker — proxy Gemini per verifica parole (v2)
// ============================================================

export default {
  async fetch(request, env) {
    const corsHeaders = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    };

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders });
    }

    if (request.method !== 'POST') {
      return new Response(JSON.stringify({ error: 'Method not allowed' }), {
        status: 405,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    let body;
    try {
      body = await request.json();
    } catch {
      return new Response(JSON.stringify({ error: 'Invalid JSON' }), {
        status: 400,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    const { word, letter, category } = body || {};
    if (!word || !letter) {
      return new Response(JSON.stringify({ error: 'Missing word or letter' }), {
        status: 400,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    const apiKey = env.GEMINI_API_KEY;
    if (!apiKey) {
      return new Response(JSON.stringify({ error: 'GEMINI_API_KEY not configured' }), {
        status: 500,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    const systemInstruction = `Sei un verificatore per il gioco italiano "Nomi Cose Città".
Il tuo unico compito è determinare se una parola è valida per una specifica categoria e lettera iniziale.
Criteri di validità:
- deve essere una parola italiana esistente e di senso compiuto;
- deve appartenere alla categoria richiesta (es. "Città" = città italiana o estera riconosciuta; "Animali" = specie animale; "Mestieri" = professione; "Colori" = colore; "Film" = titolo di film; "Cantanti" = nome d'arte o cognome di cantante; "Sport" = disciplina sportiva; "Cibo" = alimento o piatto; "Cose" = oggetto o concetto concreto; "Nomi" = nome proprio di persona);
- deve iniziare con la lettera indicata (indipendentemente da maiuscole/minuscole);
- Valuta il significato comune della parola, non pretendere che sia una voce presente in Wikipedia.
- Esempi: "daino" è valido per Animali; "Domodossola" è valido per Città; "drago" NON è una cosa comune se la categoria richiede oggetti concreti.
- Non rifiutare una parola solo perché poco comune o perché non conosci una fonte specifica.
- NON deve essere una parola inventata, un acronimo privo di senso, una frase, o una parola di una sola lettera.
Rispondi SEMPRE e SOLO con "sì" o "no", in minuscolo, senza spiegazioni, senza punteggiatura aggiuntiva, senza altro testo.`;

    const userPrompt = `La parola "${word}" è valida come "${category || 'Cose'}" che inizia con la lettera "${letter}"?`;

    const geminiUrl = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-lite:generateContent?key=${apiKey}`;

    try {
      const geminiRes = await fetch(geminiUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          systemInstruction: {
            parts: [{ text: systemInstruction }]
          },
          contents: [
            { role: 'user', parts: [{ text: userPrompt }] }
          ],
          generationConfig: {
            maxOutputTokens: 16,
          thinkingConfig: { thinkingBudget: 0 },
          },
        }),
      });

      if (!geminiRes.ok) {
        const errText = await geminiRes.text();
        return new Response(JSON.stringify({
          error: 'Gemini API error',
          status: geminiRes.status,
          detail: errText.slice(0, 200),
        }), {
          status: 502,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      }

      const geminiData = await geminiRes.json();
      const text = geminiData?.candidates?.[0]?.content?.parts?.[0]?.text || '';
      const normalized = text.trim().toLowerCase();
      // Una risposta vuota o inattesa è un errore di verifica, non un "no".
      const valid = /^(sì|si)(?:[.!\\s]|$)/i.test(normalized)
        ? true
        : /^no(?:[.!\\s]|$)/i.test(normalized) ? false : null;

      return new Response(JSON.stringify({ valid }), {
        status: 200,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    } catch (e) {
      return new Response(JSON.stringify({ error: 'Fetch failed', detail: String(e) }), {
        status: 500,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }
  },
};
