// ============================================================
// Cloudflare Worker — proxy Gemini per verifica parole
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

    const { word, letter } = body || {};
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

    const prompt = `Sei un verificatore per il gioco italiano "Nomi Cose Città".
La parola "${word}" è una parola italiana valida (nome comune, nome proprio, città, animale, mestiere, colore, film, cantante, sport o cibo) che inizia con la lettera "${letter}"?
Rispondi SOLO con "sì" o "no", senza altro testo.`;

    const geminiUrl = `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${apiKey}`;

    try {
      const geminiRes = await fetch(geminiUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig: {
            temperature: 0,
            maxOutputTokens: 5,
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
      const valid = normalized.startsWith('sì') || normalized.startsWith('si');

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
