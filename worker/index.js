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

    const systemInstruction = `Sei il giudice semantico di un gioco italiano "Nomi Cose Città".
Valuta con rigore la parola nel significato comune italiano, la categoria e la lettera iniziale.
Regole:
- La parola deve essere realmente usata e riconoscibile in italiano; non inventare significati o accettare refusi evidenti.
- Deve appartenere alla categoria richiesta, non basta che esista o abbia una pagina enciclopedica.
- Cose: oggetto o cosa concreta e identificabile; non sigle isolate, abbreviazioni, lettere o parole fuori categoria.
- Nomi: nome proprio di persona.
- Città: centro abitato/città riconosciuta, in Italia o all'estero.
- Animali: animale o specie animale; Mestieri: professione; Sport: disciplina sportiva; applica lo stesso criterio semantico alle altre categorie.
- La parola deve iniziare con la lettera indicata.
- Non richiedere che la parola sia famosa o abbia una pagina Wikipedia.
- Se la parola è plausibile ma non puoi stabilire con sicurezza la categoria, usa uncertain.
Esempi vincolanti: "daino" in Animali = valid; "Domodossola" in Città = valid; "economo" in Sport = invalid; "ES" in Cose = invalid; "erborista" in Mestieri = valid; "drago" in Cose = invalid.
Rispondi esclusivamente in JSON con questa forma: {"status":"valid"} oppure {"status":"invalid"} oppure {"status":"uncertain"}.`;
    
    const userPrompt = `Valuta questa risposta.
Categoria: ${category || 'Cose'}
Lettera richiesta: ${letter}
Risposta: ${word}
La risposta inizia con la lettera richiesta? Valuta anche il significato e l'appartenenza alla categoria.`;

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
            maxOutputTokens: 32,
            thinkingConfig: { thinkingBudget: 0 },
            responseMimeType: 'application/json',
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
      const responseText = geminiData?.candidates?.[0]?.content?.parts?.[0]?.text || '';
      let status = 'uncertain';
      try {
        const parsed = JSON.parse(responseText.trim());
        if (parsed.status === 'valid' || parsed.status === 'invalid' || parsed.status === 'uncertain') {
          status = parsed.status;
        }
      } catch {
        // Una risposta non conforme non diventa mai automaticamente valida o non valida.
      }

      const valid = status === 'valid' ? true : status === 'invalid' ? false : null;
      return new Response(JSON.stringify({ valid, status }), {
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
