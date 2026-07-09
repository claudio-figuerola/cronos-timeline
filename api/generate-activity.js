const KV_URL   = process.env.KV_REST_API_URL   || process.env.UPSTASH_REDIS_REST_URL;
const KV_TOKEN = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;

const RATE_LIMIT_PER_HOUR = 10;

async function kvPipeline(commands) {
  if (!KV_URL || !KV_TOKEN) return null;
  try {
    const res = await fetch(`${KV_URL}/pipeline`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${KV_TOKEN}` },
      body: JSON.stringify(commands),
    });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Método no permitido' });
  }

  const { datasetTitle, context, events, level } = req.body || {};
  if (!Array.isArray(events) || events.length < 5) {
    return res.status(400).json({ error: 'Se necesitan al menos 5 hitos visibles para armar una actividad' });
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return res.status(500).json({ error: 'API key no configurada en el servidor' });
  }

  const nivel = level === 'primaria' ? 'primaria' : 'secundaria';

  const ip = (req.headers['x-forwarded-for'] || 'unknown').split(',')[0].trim();
  const hourWindow = Math.floor(Date.now() / 3600000);
  const rlKey = `rla:${ip}:${hourWindow}`;

  const kvResult = await kvPipeline([
    ['INCR', rlKey],
    ['EXPIRE', rlKey, String(3600)],
  ]);
  if (kvResult && kvResult[0]?.result > RATE_LIMIT_PER_HOUR) {
    return res.status(429).json({
      error: `Alcanzaste el límite de ${RATE_LIMIT_PER_HOUR} actividades por hora. Probá más tarde.`,
    });
  }

  // Compactar y limitar los hitos que van al prompt
  const compact = events.slice(0, 60).map(e =>
    `- ${String(e.title).slice(0, 80)} (${e.start}${e.end ? '–' + e.end : ''})`
  ).join('\n');

  const systemPrompt = `Sos un docente experto en didáctica de la historia. Diseñás actividades claras, apropiadas para la edad de los alumnos, basadas exclusivamente en los hitos provistos. Respondés ÚNICAMENTE con JSON válido, sin markdown ni texto extra.`;

  const userPrompt = `Generá una actividad escolar de nivel ${nivel} basada en estos hitos históricos${datasetTitle ? ` del tema "${datasetTitle}"` : ''}:

${compact}
${context ? `\nContexto de la línea de tiempo: ${context}` : ''}

Respondé SOLO este JSON:
{
  "title": "Título de la actividad",
  "sections": [
    {
      "title": "Nombre de la sección",
      "instrucciones": "Consigna clara para el alumno",
      "items": ["...", "..."],
      "respuestas": ["...", "..."]
    }
  ]
}

Generá exactamente estas 3 secciones:
1. "Ordená cronológicamente": 6 hitos de la lista en orden MEZCLADO en items (sin años); en respuestas el orden correcto con años
2. "Verdadero o falso": 6 afirmaciones sobre qué pasó antes/después o en qué época; en respuestas "V" o "F" con explicación de una oración
3. "Preguntas para pensar": 3 preguntas abiertas que conecten hitos entre sí; en respuestas una orientación breve para el docente

Reglas:
- Lenguaje adaptado a nivel ${nivel}
- No inventes hechos que no estén en la lista de hitos
- Solo el JSON, nada más`;

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
        max_tokens: 3000,
        system: systemPrompt,
        messages: [{ role: 'user', content: userPrompt }],
      }),
    });

    const rawText = await anthropicRes.text();

    if (!anthropicRes.ok) {
      console.error(`Anthropic error ${anthropicRes.status}:`, rawText);
      return res.status(502).json({ error: `Error de API (${anthropicRes.status})`, detail: rawText });
    }

    const data = JSON.parse(rawText);
    const text = data.content[0].text.trim();

    let activity;
    try {
      activity = JSON.parse(text);
    } catch {
      const match = text.match(/\{[\s\S]*\}/);
      if (match) {
        activity = JSON.parse(match[0]);
      } else {
        return res.status(500).json({ error: 'El modelo devolvió una respuesta inválida' });
      }
    }

    if (!activity.sections || !Array.isArray(activity.sections)) {
      return res.status(500).json({ error: 'Estructura de actividad inválida' });
    }

    return res.status(200).json(activity);
  } catch (err) {
    console.error('Handler error:', err);
    return res.status(500).json({ error: err.message });
  }
}
