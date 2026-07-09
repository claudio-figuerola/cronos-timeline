// KV (Upstash Redis via Vercel Marketplace) — opcional.
// Si las env vars no están, la función trabaja sin rate limit ni cache.
const KV_URL   = process.env.KV_REST_API_URL   || process.env.UPSTASH_REDIS_REST_URL;
const KV_TOKEN = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;

const RATE_LIMIT_PER_HOUR = 10;
const CACHE_TTL_SECONDS   = 60 * 60 * 24 * 30; // 30 días
const TOPICS_INDEX_KEY    = 'cache:v2:topics';

// Palabras que no definen el tema: artículos, preposiciones, honoríficos
// y muletillas tipo "vida de", "historia de". Así "Vida de Don José de
// San Martín" y "José de San Martín" comparten la misma entrada de cache.
const STOPWORDS = new Set([
  'la', 'el', 'los', 'las', 'lo', 'un', 'una', 'unos', 'unas',
  'de', 'del', 'y', 'e', 'o', 'u', 'a', 'al', 'en', 'con', 'por',
  'para', 'sobre', 'entre', 'desde', 'hasta',
  'vida', 'historia', 'biografia', 'cronologia', 'linea', 'tiempo',
  'hitos', 'eventos', 'resumen', 'breve', 'quien', 'fue',
  'don', 'dona', 'general', 'doctor', 'dr', 'fray',
]);

function normalizeTopic(p) {
  const base = p.trim().toLowerCase()
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ').trim();
  const words = base.split(' ').filter(w => w && !STOPWORDS.has(w));
  return words.length ? words.join(' ') : base;
}

// "san martin" matchea "jose san martin": todas las palabras del pedido
// están contenidas en un tema ya cacheado (o al revés). Mínimo 2 palabras
// del lado corto para no matchear temas genéricos de una sola palabra.
function findFuzzyTopic(topic, knownTopics) {
  const words = new Set(topic.split(' '));
  let best = null, bestDiff = Infinity;
  for (const known of knownTopics) {
    if (known === topic) continue;
    const knownWords = new Set(known.split(' '));
    const [small, big] = words.size <= knownWords.size
      ? [words, knownWords] : [knownWords, words];
    if (small.size < 2) continue;
    if (![...small].every(w => big.has(w))) continue;
    const diff = big.size - small.size;
    if (diff < bestDiff) { bestDiff = diff; best = known; }
  }
  return best;
}

async function kvPipeline(commands) {
  if (!KV_URL || !KV_TOKEN) return null;
  try {
    const res = await fetch(`${KV_URL}/pipeline`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${KV_TOKEN}` },
      body: JSON.stringify(commands),
    });
    if (!res.ok) {
      console.error('KV pipeline error:', res.status, await res.text());
      return null;
    }
    return await res.json();
  } catch (err) {
    console.error('KV unreachable:', err.message);
    return null;
  }
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Método no permitido' });
  }

  const { prompt, force } = req.body || {};
  if (!prompt || prompt.trim().length < 3) {
    return res.status(400).json({ error: 'Describí el tema del dataset' });
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return res.status(500).json({ error: 'API key no configurada en el servidor' });
  }

  const ip = (req.headers['x-forwarded-for'] || 'unknown').split(',')[0].trim();
  const hourWindow = Math.floor(Date.now() / 3600000);
  const rlKey    = `rl:${ip}:${hourWindow}`;
  const topic    = normalizeTopic(prompt);
  const cacheKey = `cache:v2:${topic}`;

  // Rate limit + cache exacto + índice de temas en un solo round-trip
  const kvResult = await kvPipeline([
    ['INCR', rlKey],
    ['EXPIRE', rlKey, String(3600)],
    ['GET', cacheKey],
    ['SMEMBERS', TOPICS_INDEX_KEY],
  ]);

  if (kvResult) {
    const requestCount = kvResult[0]?.result;
    if (requestCount > RATE_LIMIT_PER_HOUR) {
      return res.status(429).json({
        error: `Alcanzaste el límite de ${RATE_LIMIT_PER_HOUR} generaciones por hora. Probá de nuevo más tarde.`,
      });
    }

    if (!force) {
      // 1. Match exacto
      const cached = kvResult[2]?.result;
      if (cached) {
        try {
          return res.status(200).json({ ...JSON.parse(cached), cached: true });
        } catch { /* cache corrupto → regenerar */ }
      }
      // 2. Match por contención de palabras
      const knownTopics = kvResult[3]?.result || [];
      const fuzzy = findFuzzyTopic(topic, knownTopics);
      if (fuzzy) {
        const fuzzyResult = await kvPipeline([['GET', `cache:v2:${fuzzy}`]]);
        const hit = fuzzyResult?.[0]?.result;
        if (hit) {
          try {
            return res.status(200).json({ ...JSON.parse(hit), cached: true });
          } catch { /* seguir a generación */ }
        }
      }
    }
  }

  const systemPrompt = `Sos un historiador experto que genera datasets de hitos históricos para una aplicación de líneas de tiempo interactiva. Respondés ÚNICAMENTE con JSON válido, sin texto adicional, sin markdown, sin explicaciones.`;

  const userPrompt = `Generá un dataset de hitos históricos para: "${prompt.trim()}"

Respondé ÚNICAMENTE con este JSON (sin markdown, sin texto extra):
{
  "title": "Título descriptivo del dataset",
  "events": [
    {
      "id": "snake_case_unico",
      "cat": "everyday",
      "title": "Nombre corto del hito",
      "start": 1850,
      "desc": "Descripción en 1-2 oraciones."
    }
  ]
}

Reglas:
- Entre 20 y 30 eventos, ordenados cronológicamente por "start"
- Categorías válidas SOLO: tech, war, science, sport, everyday, latam
- Agregá "end": año SOLO si el evento duró más de 2 años
- id: snake_case, sin espacios, sin tildes, único en el array
- Descripciones en español, máximo 2 oraciones
- No incluyas nada fuera del JSON`;

  try {
    const anthropicRes = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 4096,
        system: systemPrompt,
        messages: [{ role: 'user', content: userPrompt }],
      }),
    });

    const rawText = await anthropicRes.text();

    if (!anthropicRes.ok) {
      console.error(`Anthropic error ${anthropicRes.status}:`, rawText);
      return res.status(502).json({
        error: `Error de API (${anthropicRes.status})`,
        detail: rawText,
      });
    }

    const data = JSON.parse(rawText);
    const text = data.content[0].text.trim();

    let dataset;
    try {
      dataset = JSON.parse(text);
    } catch {
      const match = text.match(/\{[\s\S]*\}/);
      if (match) {
        dataset = JSON.parse(match[0]);
      } else {
        console.error('JSON inválido del modelo:', text);
        return res.status(500).json({ error: 'El modelo devolvió una respuesta inválida', detail: text.slice(0, 200) });
      }
    }

    if (!dataset.events || !Array.isArray(dataset.events)) {
      return res.status(500).json({ error: 'Estructura de dataset inválida' });
    }

    // Guardar en cache + registrar el tema en el índice (best-effort)
    await kvPipeline([
      ['SET', cacheKey, JSON.stringify(dataset), 'EX', String(CACHE_TTL_SECONDS)],
      ['SADD', TOPICS_INDEX_KEY, topic],
    ]);

    return res.status(200).json(dataset);
  } catch (err) {
    console.error('Handler error:', err);
    return res.status(500).json({ error: err.message });
  }
}
