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

async function callGemini(apiKey, text) {
  const res = await fetchWithTimeout(
    `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-lite:generateContent?key=${apiKey}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        system_instruction: { parts: [{ text: SYSTEM_PROMPT }] },
        contents: [{ parts: [{ text }] }]
      })
    },
    20000
  );
  if (!res.ok) throw new Error((await res.text().catch(() => res.status.toString())).slice(0, 120));
  const data = await res.json();
  return data?.candidates?.[0]?.content?.parts?.[0]?.text ?? '';
}

async function callOpenAI(apiKey, text) {
  const res = await fetchWithTimeout(
    'https://api.openai.com/v1/chat/completions',
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
      body: JSON.stringify({
        model: 'gpt-4o-mini',
        max_tokens: 256,
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user',   content: text }
        ]
      })
    },
    20000
  );
  if (!res.ok) throw new Error((await res.text().catch(() => res.status.toString())).slice(0, 120));
  const data = await res.json();
  return data?.choices?.[0]?.message?.content ?? '';
}

async function callClaude(apiKey, text) {
  const res = await fetchWithTimeout(
    'https://api.anthropic.com/v1/messages',
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 256,
        system: SYSTEM_PROMPT,
        messages: [{ role: 'user', content: text }]
      })
    },
    20000
  );
  if (!res.ok) throw new Error((await res.text().catch(() => res.status.toString())).slice(0, 120));
  const data = await res.json();
  return data?.content?.[0]?.text ?? '';
}

async function callGrok(apiKey, text) {
  const res = await fetchWithTimeout(
    'https://api.x.ai/v1/chat/completions',
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
      body: JSON.stringify({
        model: 'grok-3-mini',
        max_tokens: 256,
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user',   content: text }
        ]
      })
    },
    20000
  );
  if (!res.ok) throw new Error((await res.text().catch(() => res.status.toString())).slice(0, 120));
  const data = await res.json();
  return data?.choices?.[0]?.message?.content ?? '';
}

async function callAI(provider, apiKey, text) {
  switch (provider) {
    case 'gemini': return callGemini(apiKey, text);
    case 'openai': return callOpenAI(apiKey, text);
    case 'claude': return callClaude(apiKey, text);
    case 'grok':   return callGrok(apiKey, text);
    default: throw new Error(`Unknown provider: ${provider}`);
  }
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const token = req.headers['authorization']?.replace('Bearer ', '');
    if (!token) return res.status(401).json({ error: 'No token' });

    const user = await getUser(token);
    if (!user?.id) return res.status(401).json({ error: 'Invalid session' });

    const apiKeyData = await getUserApiKey(user.id);
    if (!apiKeyData) return res.status(403).json({ error: 'NO_API_KEY', message: 'Add your API key in the extension options.' });

    const text = typeof req.body === 'object' ? req.body?.text : JSON.parse(req.body ?? '{}').text;
    if (!text || typeof text !== 'string') return res.status(400).json({ error: 'No text provided' });
    if (text.length > 2000) return res.status(400).json({ error: 'Text too long' });

    const result = await callAI(apiKeyData.provider, apiKeyData.key, text);
    if (!result) return res.status(502).json({ error: 'Empty response from AI' });

    return res.status(200).json({ result });
  } catch (err) {
    return res.status(500).json({ error: err.message ?? 'Internal error' });
  }
}
