import { createHash } from 'crypto';

const KV_URL   = process.env.KV_REST_API_URL   || process.env.UPSTASH_REDIS_REST_URL;
const KV_TOKEN = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;

const MAX_EVENTS  = 100;
const MAX_PAYLOAD = 150_000; // ~150 KB por dataset

async function kv(command) {
  const res = await fetch(KV_URL, {
    method: 'POST',
    headers: { Authorization: `Bearer ${KV_TOKEN}` },
    body: JSON.stringify(command),
  });
  if (!res.ok) throw new Error(`KV error ${res.status}`);
  return res.json();
}

export default async function handler(req, res) {
  if (!KV_URL || !KV_TOKEN) {
    return res.status(503).json({ error: 'Almacenamiento no configurado en el servidor' });
  }

  try {
    if (req.method === 'GET') {
      const id = String(req.query?.id || '');
      if (!/^[a-f0-9]{10}$/.test(id)) {
        return res.status(400).json({ error: 'ID inválido' });
      }
      const result = await kv(['GET', `ds:${id}`]);
      if (!result?.result) {
        return res.status(404).json({ error: 'Dataset no encontrado' });
      }
      return res.status(200).json(JSON.parse(result.result));
    }

    if (req.method === 'POST') {
      const { title, events } = req.body || {};
      if (!title || typeof title !== 'string' || !Array.isArray(events) || !events.length) {
        return res.status(400).json({ error: 'Dataset inválido: falta título o hitos' });
      }
      if (events.length > MAX_EVENTS) {
        return res.status(400).json({ error: `Máximo ${MAX_EVENTS} hitos por dataset` });
      }

      const payload = JSON.stringify({ title: title.slice(0, 120), events });
      if (payload.length > MAX_PAYLOAD) {
        return res.status(400).json({ error: 'Dataset demasiado grande' });
      }

      // ID = hash del contenido: guardar lo mismo dos veces da el mismo link
      const id = createHash('sha256').update(payload).digest('hex').slice(0, 10);
      await kv(['SET', `ds:${id}`, payload]);
      return res.status(200).json({ id });
    }

    return res.status(405).json({ error: 'Método no permitido' });
  } catch (err) {
    console.error('dataset.js error:', err);
    return res.status(500).json({ error: err.message });
  }
}
