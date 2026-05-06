import { createCipheriv, randomBytes } from 'crypto';

function encrypt(text) {
  const key = Buffer.from((process.env.ENCRYPTION_KEY ?? '').trim(), 'hex');
  const iv  = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const enc = Buffer.concat([cipher.update(text, 'utf8'), cipher.final()]);
  return [iv.toString('hex'), cipher.getAuthTag().toString('hex'), enc.toString('hex')].join(':');
}

const SUPABASE_URL   = process.env.SUPABASE_URL;
const SUPABASE_ANON  = process.env.SUPABASE_ANON_KEY;
const ALLOWED_ORIGIN = 'chrome-extension://oieikdhmaagmijgidipmkemgaaghjdkg';

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

export default async function handler(req, res) {
  const origin = req.headers.origin ?? '';
  if (origin !== ALLOWED_ORIGIN) return res.status(403).json({ error: 'Forbidden' });

  res.setHeader('Access-Control-Allow-Origin', ALLOWED_ORIGIN);
  res.setHeader('Access-Control-Allow-Methods', 'POST, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') return res.status(200).end();

  try {
    const token = req.headers['authorization']?.replace('Bearer ', '');
    if (!token) return res.status(401).json({ error: 'No token' });

    const user = await getUser(token);
    if (!user?.id) return res.status(401).json({ error: 'Invalid session' });

    const headers = {
      'Authorization': `Bearer ${process.env.SUPABASE_SERVICE_KEY}`,
      'apikey':        process.env.SUPABASE_SERVICE_KEY,
      'Content-Type':  'application/json'
    };

    if (req.method === 'POST') {
      const { apiKey, provider = 'gemini' } = req.body;
      if (!apiKey || typeof apiKey !== 'string' || apiKey.trim().length < 10 || apiKey.trim().length > 200) {
        return res.status(400).json({ error: 'Invalid API key' });
      }
      if (!['gemini', 'openai', 'claude', 'grok'].includes(provider)) {
        return res.status(400).json({ error: 'Invalid provider' });
      }

      const encrypted = encrypt(apiKey.trim());

      // Delete first, then insert — if insert fails, user knows to re-add
      const delRes = await fetchWithTimeout(
        `${SUPABASE_URL}/rest/v1/user_api_keys?user_id=eq.${user.id}`,
        { method: 'DELETE', headers }
      );
      if (!delRes.ok && delRes.status !== 404) {
        return res.status(502).json({ error: 'Failed to clear existing key. Try again.' });
      }

      const insRes = await fetchWithTimeout(
        `${SUPABASE_URL}/rest/v1/user_api_keys`,
        { method: 'POST', headers, body: JSON.stringify({ user_id: user.id, encrypted_key: encrypted, provider }) }
      );
      if (!insRes.ok) {
        return res.status(502).json({ error: 'Failed to save key. Try again.' });
      }

      return res.status(200).json({ success: true, provider });
    }

    if (req.method === 'DELETE') {
      await fetchWithTimeout(
        `${SUPABASE_URL}/rest/v1/user_api_keys?user_id=eq.${user.id}`,
        { method: 'DELETE', headers }
      );
      return res.status(200).json({ success: true });
    }

    return res.status(405).json({ error: 'Method not allowed' });
  } catch (err) {
    return res.status(500).json({ error: 'Internal error' });
  }
}
