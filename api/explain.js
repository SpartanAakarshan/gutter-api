import { createDecipheriv } from 'crypto';

function decrypt(ciphertext) {
  const key = Buffer.from((process.env.ENCRYPTION_KEY ?? '').trim(), 'hex');
  const [ivHex, tagHex, encHex] = ciphertext.split(':');
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(ivHex, 'hex'));
  decipher.setAuthTag(Buffer.from(tagHex, 'hex'));
  return Buffer.concat([decipher.update(Buffer.from(encHex, 'hex')), decipher.final()]).toString('utf8');
}

const SUPABASE_URL  = process.env.SUPABASE_URL;
const SUPABASE_ANON = process.env.SUPABASE_ANON_KEY;
const GEMINI_BASE   = 'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-lite:generateContent';

const SYSTEM_PROMPT = `You are a clarity assistant for people who value focus and minimal distraction. Your mission is to deliver instant context so the user never needs to open a new tab or break their flow.

Strict Response Guidelines:

Length: Provide exactly two sentences. No more, no less.

Structure: The first sentence must define the concept clearly. The second sentence must explain its primary significance or 'why it matters.'

Tone: Factual, direct, and high-contrast. Do not use conversational filler (e.g., 'Sure thing,' 'Here is what you asked,' or 'I hope this helps').

Constraint: No bullet points, no bolding, and no links.

Your goal is to give just enough context to satisfy understanding and immediately return the user's attention to their original task.`;


function fetchWithTimeout(url, options, ms = 7000) {
  const ctrl = new AbortController();
  const id = setTimeout(() => ctrl.abort(), ms);
  return fetch(url, { ...options, signal: ctrl.signal }).finally(() => clearTimeout(id));
}

async function getUser(token) {
  const res = await fetchWithTimeout(`${SUPABASE_URL}/auth/v1/user`, {
    headers: { 'Authorization': `Bearer ${token}`, 'apikey': SUPABASE_ANON }
  });
  if (!res.ok) return null;
  return res.json();
}

async function getUserApiKey(userId) {
  const res = await fetchWithTimeout(
    `${SUPABASE_URL}/rest/v1/user_api_keys?user_id=eq.${userId}&select=encrypted_key,provider&limit=1`,
    {
      headers: {
        'Authorization': `Bearer ${process.env.SUPABASE_SERVICE_KEY}`,
        'apikey':        process.env.SUPABASE_SERVICE_KEY
      }
    }
  );
  const [row] = await res.json();
  if (!row) return null;
  return { key: decrypt(row.encrypted_key), provider: row.provider };
}

const ALLOWED_ORIGIN = 'chrome-extension://oieikdhmaagmijgidipmkemgaaghjdkg';

export default async function handler(req, res) {
  try {
    const origin = req.headers.origin ?? '';
    if (origin !== ALLOWED_ORIGIN) {
      return res.status(403).json({ error: 'Forbidden' });
    }

    res.setHeader('Access-Control-Allow-Origin', ALLOWED_ORIGIN);
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

    if (req.method === 'OPTIONS') return res.status(200).end();
    if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

    const token = req.headers['authorization']?.replace('Bearer ', '');
    if (!token) return res.status(401).json({ error: 'No token provided' });

    const user = await getUser(token);
    if (!user?.id) return res.status(401).json({ error: 'Invalid or expired session' });

    const text = req.body?.text;
    if (!text || typeof text !== 'string' || text.trim().length < 2 || text.length > 2000) {
      return res.status(400).json({ error: 'Invalid text' });
    }

    const userKey = await getUserApiKey(user.id);
    if (!userKey) {
      return res.status(402).json({
        error: 'NO_API_KEY',
        message: 'No API key configured. Add your Gemini API key in extension settings.'
      });
    }

    const apiUrl = `${GEMINI_BASE}?key=${userKey.key}`;
    const r = await fetch(apiUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ parts: [{ text: SYSTEM_PROMPT + '\n\nText: ' + text }] }],
        generationConfig: { maxOutputTokens: 150, temperature: 0.3 }
      })
    });

    const data = await r.json();
    if (data.error) {
      const msg = data.error.message ?? 'Unknown Gemini error';
      const status = data.error.code === 400 ? 400 : 502;
      return res.status(status).json({ error: `Gemini: ${msg}` });
    }

    const parts = data.candidates?.[0]?.content?.parts ?? [];
    const result = parts.find(p => !p.thought)?.text?.trim();
    if (!result) return res.status(502).json({ error: 'No response from Gemini' });

    return res.status(200).json({ result });
  } catch (err) {
    console.error('[Gutter] unhandled:', err);
    return res.status(500).json({ error: err.message ?? 'Internal server error' });
  }
}
