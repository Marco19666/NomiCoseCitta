// Cloudflare Worker — verifica parole per Nomi Cose Città
// Database strutturato Wikidata (CC0) + Gemini come fallback semantico.
// Il database conferma solo corrispondenze positive: un mancato risultato
// non rende automaticamente falsa una parola.

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

const WIKIDATA_CLASSES = {
  'città': ['Q515', 'Q486972'],
  'citta': ['Q515', 'Q486972'],
  'animali': ['Q729'],
  'piante': ['Q756'],
  'mestieri': ['Q12737077'],
  'sport': ['Q349'],
  'alimenti': ['Q2095'],
  'cose': ['Q223557'],
};

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...CORS, 'Content-Type': 'application/json; charset=utf-8' },
  });
}

function normalize(value) {
  return String(value || '')
    .normalize('NFC')
    .trim()
    .replace(/\s+/g, ' ')
    .toLocaleLowerCase('it');
}

function escapeSparql(value) {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, ' ');
}

async function lookupWikidata(word, category) {
  const classes = WIKIDATA_CLASSES[normalize(category)];
  if (!classes) return false;

  const safeWord = escapeSparql(word);
  const classPath = classes.map(id => 'wd:' + id).join(', ');
  const query = [
    'SELECT ?item WHERE {',
    '  VALUES ?class { ' + classPath + ' }',
    '  ?item wdt:P31/wdt:P279* ?class; rdfs:label ?label.',
    '  FILTER(LCASE(STR(?label)) = LCASE("' + safeWord + '"))',
    '  FILTER(LANG(?label) IN ("it", "en"))',
    '} LIMIT 1',
  ].join('\n');

  const cacheKey = new Request(
    'https://ncc-cache.invalid/wikidata/' +
    encodeURIComponent(normalize(category)) + '/' +
    encodeURIComponent(normalize(word))
  );
  const cache = caches.default;
  const cached = await cache.match(cacheKey);
  if (cached) {
    const data = await cached.json();
    return data.found === true;
  }

  const url = 'https://query.wikidata.org/sparql?query=' + encodeURIComponent(query);
  const response = await fetch(url, {
    headers: {
      'Accept': 'application/sparql-results+json',
      'User-Agent': 'NomiCoseCitta/1.0 (word category verification)',
    },
    signal: AbortSignal.timeout(7000),
  });
  if (!response.ok) throw new Error('Wikidata HTTP ' + response.status);

  const data = await response.json();
  const found = Array.isArray(data?.results?.bindings) && data.results.bindings.length > 0;
  const cacheResponse = new Response(JSON.stringify({ found }), {
    headers: { 'Cache-Control': 'public, max-age=604800', 'Content-Type': 'application/json' },
  });
  await cache.put(cacheKey, cacheResponse);
  return found;
}

async function verifyWithGemini(word, letter, category, apiKey) {
  const systemInstruction = [
    'Sei il giudice semantico di un gioco italiano "Nomi Cose Città".',
    'Valuta con rigore l’uso comune italiano, la categoria e la lettera iniziale.',
    '- La parola deve essere reale, riconoscibile e appartenere alla categoria richiesta.',
    '- Nomi: nome proprio di persona, non cognome o parola comune.',
    '- Città: città o centro abitato riconosciuto.',
    '- Cose: oggetto/cosa concreta e identificabile; non sigle isolate, abbreviazioni o parole grammaticali.',
    '- Animali: animale o specie animale; Piante: pianta; Mestieri: professione;',
    '  Sport: disciplina sportiva; Alimenti: cibo o bevanda non alcolica.',
    '- Per categorie non standard, interpreta il significato ordinario della categoria.',
    '- Non inventare significati e non accettare refusi evidenti.',
    '- Se non puoi decidere con sicurezza, rispondi uncertain.',
    'Esempi: "daino" in Animali = valid; "Domodossola" in Città = valid;',
    '"economo" in Sport = invalid; "ES" in Cose = invalid;',
    '"erborista" in Mestieri = valid; "drago" in Cose = invalid.',
    'Rispondi esclusivamente JSON: {"status":"valid"}, {"status":"invalid"} o {"status":"uncertain"}.',
  ].join('\n');

  const userPrompt = 'Categoria: ' + category + '\nLettera richiesta: ' + letter +
    '\nRisposta: ' + word +
    '\nControlla lettera iniziale, significato e appartenenza alla categoria.';

  const url = 'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-lite:generateContent?key=' + apiKey;
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: systemInstruction }] },
      contents: [{ role: 'user', parts: [{ text: userPrompt }] }],
      generationConfig: {
        maxOutputTokens: 32,
        thinkingConfig: { thinkingBudget: 0 },
        responseMimeType: 'application/json',
      },
    }),
    signal: AbortSignal.timeout(12000),
  });

  if (!response.ok) throw new Error('Gemini HTTP ' + response.status);
  const data = await response.json();
  const responseText = data?.candidates?.[0]?.content?.parts?.[0]?.text || '';
  try {
    const parsed = JSON.parse(responseText.trim());
    if (['valid', 'invalid', 'uncertain'].includes(parsed.status)) return parsed.status;
  } catch {
    // Risposta non interpretabile: rimane incerta.
  }
  return 'uncertain';
}

export default {
  async fetch(request, env) {
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
    if (request.method !== 'POST') return json({ error: 'Method not allowed' }, 405);

    let body;
    try {
      body = await request.json();
    } catch {
      return json({ error: 'Invalid JSON' }, 400);
    }

    const word = String(body?.word || '').trim();
    const letter = String(body?.letter || '').trim().toLocaleUpperCase('it');
    const category = String(body?.category || '').trim();

    if (!word || !letter || !category) return json({ error: 'Missing word, letter or category' }, 400);
    if (word.length > 80 || category.length > 60 || letter.length > 3) {
      return json({ error: 'Input too long' }, 400);
    }
    if (word.length < 2 || normalize(word).charAt(0).toLocaleUpperCase('it') !== letter) {
      return json({ valid: false, status: 'invalid', source: 'rules' });
    }

    try {
      const databaseMatch = await lookupWikidata(word, category);
      if (databaseMatch) {
        return json({ valid: true, status: 'valid', source: 'wikidata' });
      }
    } catch (error) {
      console.warn('Wikidata lookup unavailable:', String(error));
    }

    if (!env.GEMINI_API_KEY) {
      return json({ valid: null, status: 'uncertain', source: 'unavailable' });
    }

    try {
      const status = await verifyWithGemini(word, letter, category, env.GEMINI_API_KEY);
      const valid = status === 'valid' ? true : status === 'invalid' ? false : null;
      return json({ valid, status, source: 'gemini' });
    } catch (error) {
      console.error('Gemini verification failed:', String(error));
      return json({ valid: null, status: 'uncertain', source: 'unavailable' });
    }
  },
};
