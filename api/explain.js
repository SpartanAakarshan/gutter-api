import { createDecipheriv } from 'crypto';
import { Redis } from '@upstash/redis';

const FREE_LIMIT = 20;

function decrypt(ciphertext) {
  const parts = (ciphertext ?? '').split(':');
  if (parts.length !== 3 || parts.some(p => !p)) throw new Error('Malformed ciphertext');
  const [ivHex, tagHex, encHex] = parts;
  const key = Buffer.from((process.env.ENCRYPTION_KEY ?? '').trim(), 'hex');
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
  if (!/^[0-9a-f-]{36}$/i.test(userId)) return null;
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
        contents: [{ parts: [{ text }] }],
        generationConfig: { thinkingConfig: { thinkingBudget: 0 } }
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

function buildDeepDivePrompt(text, meta) {
  const cap = (s) => (s ?? '').trim().slice(0, 200);
  const parts = [];
  if (cap(meta.title))    parts.push(`Page: ${cap(meta.title)}`);
  if (cap(meta.h1))       parts.push(`H1: ${cap(meta.h1)}`);
  if (cap(meta.metaDesc)) parts.push(`Description: ${cap(meta.metaDesc)}`);
  if (cap(meta.ogDesc))   parts.push(`OG: ${cap(meta.ogDesc)}`);
  const context = parts.join(' | ');
  return `Context: ${context} | User Request: Explain "${text}" specifically within the scope of this page context.`;
}

async function callAI(provider, apiKey, text, meta = null) {
  const prompt = meta ? buildDeepDivePrompt(text, meta) : text;
  switch (provider) {
    case 'gemini': return callGemini(apiKey, prompt);
    case 'openai': return callOpenAI(apiKey, prompt);
    case 'claude': return callClaude(apiKey, prompt);
    case 'grok':   return callGrok(apiKey, prompt);
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

    const body = typeof req.body === 'object' ? req.body : JSON.parse(req.body ?? '{}');
    const text = body?.text;
    if (!text || typeof text !== 'string') return res.status(400).json({ error: 'No text provided' });
    if (text.length > 2000) return res.status(400).json({ error: 'Text too long' });

    const meta = (body?.meta && typeof body.meta === 'object') ? body.meta : null;

    const apiKeyData = await getUserApiKey(user.id);

    let provider, apiKey, remaining = null;

    if (apiKeyData) {
      // User has own key — unlimited
      provider = apiKeyData.provider;
      apiKey   = apiKeyData.key;
    } else {
      // Free tier — rate limit against owner's Gemini key
      const redis = new Redis({
        url:   process.env.UPSTASH_REDIS_REST_URL,
        token: process.env.UPSTASH_REDIS_REST_TOKEN
      });

      const date    = new Date().toISOString().slice(0, 10); // YYYY-MM-DD UTC
      const redisKey = `free:${user.id}:${date}`;

      const pipe = redis.pipeline();
      pipe.incr(redisKey);
      pipe.expire(redisKey, 90000);
      const [count] = await pipe.exec();

      if (count > FREE_LIMIT) {
        return res.status(429).json({
          error: 'NO_API_KEY',
          message: `You've hit the daily limit. Add your API key in options — it's free to get one.`
        });
      }

      provider  = 'gemini';
      apiKey    = process.env.OWNER_GEMINI_KEY;
      remaining = FREE_LIMIT - count;
    }

    const result = await callAI(provider, apiKey, text, meta);
    if (!result) return res.status(502).json({ error: 'Empty response from AI' });

    return res.status(200).json({ result, ...(remaining !== null && { remaining }) });
  } catch (err) {
    const msg = (err.message ?? '').slice(0, 120);
    return res.status(500).json({ error: msg || 'Internal error' });
  }
}
