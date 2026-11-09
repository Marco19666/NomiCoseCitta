// Cloudflare Worker — verifica parole per Nomi Cose Città
// Wikidata come archivio di conferma + Gemini come fallback semantico.

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
  "cibo": ["Q2095"],
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
    .normalize("NFC")
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
  const classes = WIKIDATA_CLASSES[normalize(category)];
  if (!classes) return false;

  const classValues = classes.map(function (id) {
    return "wd:" + id;
  }).join(" ");

  const query = [
    "SELECT ?item WHERE {",
    " VALUES ?class { " + classValues + " }",
    " ?item wdt:P31/wdt:P279* ?class; rdfs:label ?label.",
    ' FILTER(LCASE(STR(?label)) = LCASE("' + escapeSparql(word) + '"))',
    ' FILTER(LANG(?label) = "it" || LANG(?label) = "en")',
    "} LIMIT 1"
  ].join("\n");

  const cacheUrl = "https://ncc-cache.invalid/wikidata/" +
    encodeURIComponent(normalize(category)) + "/" +
    encodeURIComponent(normalize(word));
  const cacheKey = new Request(cacheUrl);
  const cache = caches.default;
  const cached = await cache.match(cacheKey);

  if (cached) {
    const cachedData = await cached.json();
    return cachedData.found === true;
  }

  const endpoint = "https://query.wikidata.org/sparql?query=" +
    encodeURIComponent(query);
  const response = await fetch(endpoint, {
    headers: {
      "Accept": "application/sparql-results+json",
      "User-Agent": "NomiCoseCitta/1.0"
    },
    signal: AbortSignal.timeout(7000)
  });

  if (!response.ok) {
    throw new Error("Wikidata HTTP " + response.status);
  }

  const result = await response.json();
  const bindings = result && result.results && result.results.bindings;
  const found = Array.isArray(bindings) && bindings.length > 0;

  await cache.put(cacheKey, new Response(JSON.stringify({ found: found }), {
    headers: {
      "Cache-Control": "public, max-age=604800",
      "Content-Type": "application/json"
    }
  }));

  return found;
}

async function verifyWithGemini(word, letter, category, apiKey) {
  const instructions = [
    'Sei il giudice semantico del gioco italiano "Nomi Cose Città".',
    "Valuta con rigore uso comune italiano, categoria e lettera iniziale.",
    "La parola deve essere reale, riconoscibile e appartenere alla categoria.",
    "Nomi: nome proprio di persona, non cognome.",
    "Città: città o centro abitato riconosciuto.",
    "Cose: oggetto concreto e identificabile.",
    "Animali: animale; Piante: pianta; Mestieri: professione.",
    "Sport: disciplina sportiva; Alimenti: cibo o bevanda non alcolica.",
    "Per categorie personalizzate interpreta il significato ordinario.",
    "Non inventare significati e non accettare refusi evidenti.",
    "Se non puoi decidere con sicurezza, usa uncertain.",
    'Rispondi esclusivamente JSON: {"status":"valid"}, {"status":"invalid"} oppure {"status":"uncertain"}.'
  ].join("\n");

  const prompt = "Categoria: " + category +
    "\nLettera richiesta: " + letter +
    "\nRisposta: " + word +
    "\nControlla lettera iniziale, significato e categoria.";

  const endpoint = "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-lite:generateContent?key=" +
    encodeURIComponent(apiKey);

  const response = await fetch(endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: instructions }] },
      contents: [{ role: "user", parts: [{ text: prompt }] }],
      generationConfig: {
        maxOutputTokens: 40,
        responseMimeType: "application/json"
      }
    }),
    signal: AbortSignal.timeout(12000)
  });

  if (!response.ok) {
    throw new Error("Gemini HTTP " + response.status);
  }

  const data = await response.json();
  let responseText = "";
  if (data && data.candidates && data.candidates[0] &&
      data.candidates[0].content && data.candidates[0].content.parts &&
      data.candidates[0].content.parts[0]) {
    responseText = data.candidates[0].content.parts[0].text || "";
  }

  try {
    const parsed = JSON.parse(responseText.trim());
    if (parsed.status === "valid" ||
        parsed.status === "invalid" ||
        parsed.status === "uncertain") {
      return parsed.status;
    }
  } catch (error) {
    // Risposta del modello non interpretabile: viene trattata come incerta.
  }

  return "uncertain";
}


async function suggestWikidata(letter, category, difficulty, exclude) {
  const classes = WIKIDATA_CLASSES[normalize(category)];
  if (!classes) return "";
  const classValues = classes.map(id => "wd:" + id).join(" ");
  const query = [
    "SELECT DISTINCT ?label WHERE {",
    " VALUES ?class { " + classValues + " }",
    " ?item wdt:P31/wdt:P279* ?class; rdfs:label ?label.",
    ' FILTER(LANG(?label) = "it")',
    ' FILTER(STRSTARTS(LCASE(STR(?label)), LCASE("' + escapeSparql(letter) + '")))',
    "} LIMIT 80"
  ].join("\n");
  const endpoint = "https://query.wikidata.org/sparql?query=" + encodeURIComponent(query);
  const response = await fetch(endpoint, {
    headers: { "Accept": "application/sparql-results+json", "User-Agent": "NomiCoseCitta/1.0" },
    signal: AbortSignal.timeout(9000)
  });
  if (!response.ok) throw new Error("Wikidata HTTP " + response.status);
  const data = await response.json();
  const blocked = new Set((exclude || []).map(normalize));
  const words = (data.results?.bindings || [])
    .map(row => row.label?.value || "")
    .filter(word => word && word.length <= 70 && !blocked.has(normalize(word)));
  if (!words.length) return "";
  if (difficulty === "easy") {
    words.sort((a,b) => a.length - b.length);
    return words[Math.floor(Math.random() * Math.min(8, words.length))];
  }
  if (difficulty === "hard") {
    words.sort((a,b) => b.length - a.length);
    return words[Math.floor(Math.random() * Math.min(12, words.length))];
  }
  return words[Math.floor(Math.random() * words.length)];
}

async function suggestWithGemini(letter, categories, difficulty, existing, apiKey) {
  if (!categories.length || !apiKey) return {};
  const level = difficulty === "easy" ? "molto comuni e facili" :
    difficulty === "hard" ? "meno scontate ma corrette, note e verificabili" : "di difficoltà media, conosciute ma non banali";
  const prompt = [
    'Gioca a "Nomi Cose Città" in italiano.',
    "Genera una sola risposta reale per ciascuna categoria, iniziando ESATTAMENTE con la lettera " + letter + ".",
    "Difficoltà: " + level + ".",
    "Categorie: " + JSON.stringify(categories) + ".",
    "Non ripetere queste risposte già assegnate: " + JSON.stringify(existing || {}) + ".",
    "Usa parole o nomi riconoscibili, non inventare e non aggiungere spiegazioni.",
    'Rispondi esclusivamente con un oggetto JSON le cui chiavi sono le categorie e i valori le risposte.'
  ].join("\n");
  const endpoint = "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-lite:generateContent?key=" + encodeURIComponent(apiKey);
  const response = await fetch(endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      contents: [{ role: "user", parts: [{ text: prompt }] }],
      generationConfig: { maxOutputTokens: 500, responseMimeType: "application/json" }
    }),
    signal: AbortSignal.timeout(15000)
  });
  if (!response.ok) throw new Error("Gemini HTTP " + response.status);
  const data = await response.json();
  const raw = data.candidates?.[0]?.content?.parts?.[0]?.text || "{}";
  const parsed = JSON.parse(raw.trim());
  const answers = {};
  for (const category of categories) {
    const word = String(parsed[category] || "").trim().slice(0, 70);
    if (word && normalize(word).charAt(0).toLocaleUpperCase("it") === letter) answers[category] = word;
  }
  return answers;
}

async function suggestAnswers(letter, categories, difficulty, apiKey) {
  const answers = {};
  const fallback = [];
  for (const category of categories) {
    try {
      const word = await suggestWikidata(letter, category, difficulty, Object.values(answers));
      if (word) answers[category] = word;
      else fallback.push(category);
    } catch (error) {
      console.warn("Wikidata suggestions unavailable for " + category + ":", String(error));
      fallback.push(category);
    }
  }
  if (fallback.length && apiKey) {
    try {
      const generated = await suggestWithGemini(letter, fallback, difficulty, answers, apiKey);
      Object.assign(answers, generated);
    } catch (error) {
      console.warn("Gemini suggestions unavailable:", String(error));
    }
  }
  return answers;
}
\nexport default {
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

    if (body.action === "suggest") {
      const suggestionLetter = String(body.letter || "").trim().toLocaleUpperCase("it");
      const categories = Array.isArray(body.categories) ? body.categories.slice(0, 12).map(v => String(v).trim()).filter(v => v && v.length <= 60) : [];
      const difficulty = ["easy", "medium", "hard"].includes(body.difficulty) ? body.difficulty : "medium";
      if (!/^[A-Z]$/.test(suggestionLetter) || !categories.length) {
        return jsonResponse({ error: "Invalid letter or categories" }, 400);
      }
      const answers = await suggestAnswers(suggestionLetter, categories, difficulty, env && env.GEMINI_API_KEY);
      return jsonResponse({ answers: answers, source: "wikidata+gemini" }, 200);
    }

    const word = String(body.word || "").trim();
    const letter = String(body.letter || "").trim().toLocaleUpperCase("it");
    const category = String(body.category || "").trim();

    if (!word || !letter || !category) {
      return jsonResponse({ error: "Missing word, letter or category" }, 400);
    }

    if (word.length > 80 || category.length > 60 || letter.length > 3) {
      return jsonResponse({ error: "Input too long" }, 400);
    }

    if (word.length < 2 ||
        normalize(word).charAt(0).toLocaleUpperCase("it") !== letter) {
      return jsonResponse({
        valid: false,
        status: "invalid",
        source: "rules"
      }, 200);
    }

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
      console.warn("Wikidata lookup unavailable:", String(error));
    }

    if (!env || !env.GEMINI_API_KEY) {
      return jsonResponse({
        valid: null,
        status: "uncertain",
        source: "unavailable"
      }, 200);
    }

    try {
      const status = await verifyWithGemini(
        word, letter, category, env.GEMINI_API_KEY
      );
      let valid = null;
      if (status === "valid") valid = true;
      if (status === "invalid") valid = false;

      return jsonResponse({
        valid: valid,
        status: status,
        source: "gemini"
      }, 200);
    } catch (error) {
      console.error("Gemini verification failed:", String(error));
      return jsonResponse({
        valid: null,
        status: "uncertain",
        source: "unavailable"
      }, 200);
    }
  }
};
