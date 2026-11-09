// ============================================================
// Cloudflare Worker — verifica parole con Cloudflare Workers AI
// Modello: GLM-4.7-Flash
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

    if (!word || !letter) {
      return jsonResponse({ error: 'Missing word or letter' }, 400);
    }

    if (letter.length !== 1 || word.length < 2) {
      return jsonResponse({ valid: false });
    }

    if (word[0].toLocaleUpperCase('it-IT') !== letter) {
      return jsonResponse({ valid: false });
    }

    if (!env.AI) {
      return jsonResponse({
        error: 'Cloudflare Workers AI binding not configured',
      }, 503);
    }

    const prompt = `
Sei un verificatore per il gioco italiano "Nomi, Cose e Città".
Decidi se la parola indicata esiste realmente e appartiene alla categoria indicata.
Deve iniziare con la lettera richiesta.
Per "Città" accetta città italiane e straniere riconosciute.
Per "Nomi" accetta nomi propri di persona.
Per "Cose" accetta oggetti e cose concrete.
Per le altre categorie valuta il significato comune.
Non essere eccessivamente restrittivo: accetta anche parole corrette poco comuni.
Rispondi esclusivamente con sì oppure no, senza spiegazioni.

Parola: "${word}"
Categoria: "${category}"
Lettera richiesta: "${letter}"
La parola è valida?
`.trim();

    try {
      const result = await env.AI.run('@cf/zai-org/glm-4.7-flash', {
        prompt,
        max_tokens: 8,
        temperature: 0,
      });

      const responseText = String(result?.response || '')
        .trim()
        .toLocaleLowerCase('it-IT')
        .normalize('NFC')
        .replace(/[.!]+$/g, '')
        .trim();

      if (responseText === 'sì' || responseText === 'si') {
        return jsonResponse({ valid: true });
      }

      if (responseText === 'no') {
        return jsonResponse({ valid: false });
      }

      return jsonResponse({
        error: 'Unexpected Cloudflare AI response',
        response: responseText.slice(0, 200),
      }, 502);
    } catch (error) {
      return jsonResponse({
        error: 'Cloudflare Workers AI error',
        detail: String(error).slice(0, 500),
      }, 502);
    }
  },
};
