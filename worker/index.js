// ============================================================
// Cloudflare Worker — proxy Gemini per verifica parole (v3)
// Gemini 3.5 Flash — senza Wikidata
// ============================================================

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      ...corsHeaders,
      'Content-Type': 'application/json',
    },
  });
}

export default {
  async fetch(request, env) {

    // Richieste CORS
    if (request.method === 'OPTIONS') {
      return new Response(null, {
        status: 204,
        headers: corsHeaders,
      });
    }

    if (request.method !== 'POST') {
      return jsonResponse({
        error: 'Method not allowed',
      }, 405);
    }

    // Lettura JSON
    let body;

    try {
      body = await request.json();
    } catch {
      return jsonResponse({
        error: 'Invalid JSON',
      }, 400);
    }

    const word = String(body?.word || '').trim();
    const letter = String(body?.letter || '').trim().toUpperCase();
    const category = String(body?.category || 'Cose').trim();

    if (!word || !letter) {
      return jsonResponse({
        error: 'Missing word or letter',
      }, 400);
    }

    if (letter.length !== 1 || word.length < 2) {
      return jsonResponse({
        valid: false,
      });
    }

    // Controllo iniziale
    if (word[0].toLocaleUpperCase('it-IT') !== letter) {
      return jsonResponse({
        valid: false,
      });
    }

    // Chiave Gemini
    const apiKey = env.GEMINI_API_KEY;

    if (!apiKey) {
      return jsonResponse({
        error: 'GEMINI_API_KEY not configured',
      }, 500);
    }

    // Istruzioni per Gemini
    const systemInstruction = `
Sei un verificatore per il gioco italiano "Nomi Cose Città".

Devi stabilire se una parola è valida per la categoria
indicata e se inizia con la lettera richiesta.

REGOLE:

- La parola deve esistere realmente.
- Deve appartenere alla categoria indicata.
- Deve iniziare con la lettera richiesta.
- Non deve essere inventata.
- Non deve essere una frase o un acronimo senza significato.
- Per la categoria Città sono ammesse città italiane e straniere riconosciute.
- Per Nomi sono ammessi nomi propri di persona.
- Per Cose sono ammessi oggetti e cose concrete.
- Per le altre categorie considera il significato comune
  e l'appartenenza effettiva alla categoria.

Non essere eccessivamente restrittivo:
accetta parole corrette e riconosciute anche se poco comuni.

Rispondi esclusivamente con:
sì
oppure
no

Non aggiungere spiegazioni, commenti o punteggiatura.
`.trim();

    const userPrompt =
      `Parola: "${word}"\n` +
      `Categoria: "${category}"\n` +
      `Lettera iniziale richiesta: "${letter}"\n` +
      `La risposta è valida?`;

    const geminiUrl =
      'https://generativelanguage.googleapis.com/v1beta/models/' +
      'gemini-3.5-flash:generateContent';

    try {

      const geminiRes = await fetch(
        `${geminiUrl}?key=${encodeURIComponent(apiKey)}`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({

            systemInstruction: {
              parts: [
                { text: systemInstruction },
              ],
            },

            contents: [
              {
                role: 'user',
                parts: [
                  { text: userPrompt },
                ],
              },
            ],

            generationConfig: {
              thinkingConfig: {
                thinkingLevel: 'MINIMAL',
              },
              maxOutputTokens: 64,
            },

          }),
        }
      );

      // Errore API Gemini
      if (!geminiRes.ok) {
        const errText = await geminiRes.text();

        return jsonResponse({
          error: 'Gemini API error',
          status: geminiRes.status,
          detail: errText.slice(0, 500),
        }, 502);
      }

      // Lettura risposta
      const geminiData = await geminiRes.json();

      const candidate = geminiData?.candidates?.[0];

      const parts = candidate?.content?.parts || [];

      const responseText = parts
        .map(part => part.text || '')
        .join('')
        .trim()
        .toLocaleLowerCase('it-IT');

      // Risposta vuota o interrotta
      if (!responseText) {
        return jsonResponse({
          error: 'Gemini returned an empty response',
          finishReason: candidate?.finishReason || 'UNKNOWN',
          promptFeedback: geminiData?.promptFeedback || null,
        }, 502);
      }

      // Interpretazione rigorosa del sì/no
      const normalized = responseText
        .normalize('NFC')
        .replace(/[.!]+$/g, '')
        .trim();

      if (normalized === 'sì' || normalized === 'si') {
        return jsonResponse({
          valid: true,
        });
      }

      if (normalized === 'no') {
        return jsonResponse({
          valid: false,
        });
      }

      // Risposta inattesa: non considerarla automaticamente non valida
      return jsonResponse({
        error: 'Unexpected Gemini response',
        response: responseText.slice(0, 200),
        finishReason: candidate?.finishReason || 'UNKNOWN',
      }, 502);

    } catch (error) {

      return jsonResponse({
        error: 'Fetch failed',
        detail: String(error),
      }, 500);

    }
  },
};
