// Cloudflare Worker — verifica parole per Nomi Cose Città
// Wikidata (SPARQL ottimizzato) + Gemini come fallback semantico.

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type"
};

const WIKIDATA_CLASSES = {
  "città": ["Q515", "Q486972"],
  "citta": ["Q515", "Q486972"],
  "animali": ["Q729"],
  "piante": ["Q756"],
  "mestieri": ["Q12737077"],
  "sport": ["Q349"],
  "alimenti": ["Q2095"],
  "cose": ["Q223557"]
};

function jsonResponse(data, status) {
  return new Response(JSON.stringify(data), {
    status: status || 200,
    headers: Object.assign({}, CORS_HEADERS, {
      "Content-Type": "application/json; charset=utf-8"
    })
  });
}

function normalize(value) {
  return String(value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "") // Rimuove gli accenti per il controllo iniziale
    .trim()
    .replace(/\s+/g, " ")
    .toLocaleLowerCase("it");
}

function escapeSparql(value) {
  return value
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(/[\r\n]/g, " ");
}

async function lookupWikidata(word, category) {
  const normCat = normalize(category);
  const classes = WIKIDATA_CLASSES[normCat];
  if (!classes) return false;

  const classValues = classes.map(id => "wd:" + id).join(" ");
  const cleanWord = String(word).trim().toLowerCase();

  // SPARQL ottimizzato: cerca il binding esatto della label prima del traversal della classe
  const query = `
    SELECT ?item WHERE {
      VALUES ?class { ${classValues} }
      ?item rdfs:label "${escapeSparql(cleanWord)}"@it .
      ?item wdt:P31/wdt:P279* ?class .
    } LIMIT 1
  `;

  // URL sintetico ma valido per la Cache API di Cloudflare
  const cacheUrl = `https://cache.nomicosecitta.internal/wikidata/${encodeURIComponent(normCat)}/${encodeURIComponent(cleanWord)}`;
  const cacheKey = new Request(cacheUrl);
  const cache = caches.default;

  try {
    const cached = await cache.match(cacheKey);
    if (cached) {
      const cachedData = await cached.json();
      return cachedData.found === true;
    }
  } catch (e) {
    // Prosegue se la cache fallisce
  }

  const endpoint = "https://query.wikidata.org/sparql?query=" + encodeURIComponent(query);
  const response = await fetch(endpoint, {
    headers: {
      "Accept": "application/sparql-results+json",
      "User-Agent": "NomiCoseCittaBot/2.0 (https://nomicosecitta.app)"
    },
    signal: AbortSignal.timeout(5000)
  });

  if (!response.ok) {
    throw new Error("Wikidata HTTP " + response.status);
  }

  const result = await response.json();
  const bindings = result?.results?.bindings;
  const found = Array.isArray(bindings) && bindings.length > 0;

  // Salva in cache il risultato (valido 7 giorni)
  try {
    await cache.put(cacheKey, new Response(JSON.stringify({ found }), {
      headers: {
        "Cache-Control": "public, max-age=604800",
        "Content-Type": "application/json"
      }
    }));
  } catch (e) {}

  return found;
}

async function verifyWithGemini(word, letter, category, apiKey) {
  const instructions = [
    'Sei il giudice arbitro del gioco "Nomi Cose Città".',
    'Rispondi ESCLUSIVAMENTE con un oggetto JSON valido.',
    'Formato ammesso: {"status":"valid"}, {"status":"invalid"} o {"status":"uncertain"}.',
    'Regole:',
    '- Verifica che la parola inizi con la lettera richiesta.',
    '- Verifica che la parola sia reale in italiano e appartenga alla categoria.',
    '- Nomi: solo nomi propri di persona.',
    '- Città: comuni o città reali.',
    '- Non accettare errori grammaticali o refusi evidenti.'
  ].join("\n");

  const prompt = `Categoria: ${category}\nLettera richiesta: ${letter}\nParola: ${word}`;

  // Utilizzo del modello raccomandato ed efficiente Gemini 2.0 Flash
  const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${encodeURIComponent(apiKey)}`;

  const response = await fetch(endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: instructions }] },
      contents: [{ role: "user", parts: [{ text: prompt }] }],
      generationConfig: {
        maxOutputTokens: 30,
        responseMimeType: "application/json"
      }
    }),
    signal: AbortSignal.timeout(8000)
  });

  if (!response.ok) {
    throw new Error("Gemini HTTP " + response.status);
  }

  const data = await response.json();
  const responseText = data?.candidates?.[0]?.content?.parts?.[0]?.text || "";

  try {
    // Pulizia da eventuale wrapping Markdown ```json ... ```
    const cleanJson = responseText.replace(/```json|```/g, "").trim();
    const parsed = JSON.parse(cleanJson);
    if (["valid", "invalid", "uncertain"].includes(parsed.status)) {
      return parsed.status;
    }
  } catch (error) {
    console.warn("Parsing Gemini fallito:", responseText);
  }

  return "uncertain";
}

export default {
  fetch: async function (request, env) {
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }

    if (request.method !== "POST") {
      return jsonResponse({ error: "Method not allowed" }, 405);
    }

    let body;
    try {
      body = await request.json();
    } catch (error) {
      return jsonResponse({ error: "Invalid JSON" }, 400);
    }

    const word = String(body.word || "").trim();
    const letter = String(body.letter || "").trim().toUpperCase();
    const category = String(body.category || "").trim();

    if (!word || !letter || !category) {
      return jsonResponse({ error: "Missing word, letter or category" }, 400);
    }

    if (word.length > 80 || category.length > 60 || letter.length > 2) {
      return jsonResponse({ error: "Input too long" }, 400);
    }

    // Normalizzazione senza accenti per verificare l'iniziale della parola
    const normalizedWord = normalize(word);
    const normalizedLetter = normalize(letter);

    if (word.length < 2 || !normalizedWord.startsWith(normalizedLetter)) {
      return jsonResponse({
        valid: false,
        status: "invalid",
        source: "rules"
      }, 200);
    }

    // 1. Controllo primario: Wikidata
    try {
      const databaseMatch = await lookupWikidata(word, category);
      if (databaseMatch) {
        return jsonResponse({
          valid: true,
          status: "valid",
          source: "wikidata"
        }, 200);
      }
    } catch (error) {
      console.warn("Wikidata lookup non disponibile:", String(error));
    }

    // 2. Controllo secondario: Gemini (Fallback)
    if (!env || !env.GEMINI_API_KEY) {
      return jsonResponse({
        valid: null,
        status: "uncertain",
        source: "unavailable"
      }, 200);
    }

    try {
      const status = await verifyWithGemini(word, letter, category, env.GEMINI_API_KEY);
      let valid = null;
      if (status === "valid") valid = true;
      if (status === "invalid") valid = false;

      return jsonResponse({
        valid: valid,
        status: status,
        source: "gemini"
      }, 200);
    } catch (error) {
      console.error("Verifica Gemini fallita:", String(error));
      return jsonResponse({
        valid: null,
        status: "uncertain",
        source: "unavailable"
      }, 200);
    }
  }
};
