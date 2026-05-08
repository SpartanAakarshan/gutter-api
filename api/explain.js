import { generateText } from 'ai';
import { createGoogleGenerativeAI } from '@ai-sdk/google';
import { createOpenAI }             from '@ai-sdk/openai';
import { createAnthropic }          from '@ai-sdk/anthropic';
import { createXai }                from '@ai-sdk/xai';
import { createDecipheriv }         from 'crypto';
import { Redis }                    from '@upstash/redis';

const FREE_LIMIT = 20;

// ── Provider model IDs ────────────────────────────────────────────────────────
const MODELS = {
  gemini: 'gemini-2.5-flash-lite',
  openai: 'gpt-4o-mini',
  claude: 'claude-haiku-4.5',
  grok:   'grok-3-mini',
};

// ── Decryption ────────────────────────────────────────────────────────────────
function decrypt(ciphertext) {
  const parts = (ciphertext ?? '').split(':');
  if (parts.length !== 3 || parts.some(p => !p)) throw new Error('Malformed ciphertext');
  const [ivHex, tagHex, encHex] = parts;
  const key = Buffer.from((process.env.ENCRYPTION_KEY ?? '').trim(), 'hex');
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(ivHex, 'hex'));
  decipher.setAuthTag(Buffer.from(tagHex, 'hex'));
  return Buffer.concat([decipher.update(Buffer.from(encHex, 'hex')), decipher.final()]).toString('utf8');
}

// ── Supabase ──────────────────────────────────────────────────────────────────
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

// ── AI model factory ──────────────────────────────────────────────────────────
function getModel(provider, apiKey) {
  switch (provider) {
    case 'gemini': return createGoogleGenerativeAI({ apiKey })(MODELS.gemini);
    case 'openai': return createOpenAI({ apiKey })(MODELS.openai);
    case 'claude': return createAnthropic({ apiKey })(MODELS.claude);
    case 'grok':   return createXai({ apiKey })(MODELS.grok);
    default: throw new Error(`Unknown provider: ${provider}`);
  }
}

// ── Deep Dive prompt ──────────────────────────────────────────────────────────
function buildDeepDivePrompt(text, meta) {
  const cap = (s) => (s ?? '').trim().slice(0, 200);
  const parts = [];
  if (cap(meta.title))    parts.push(`Page: ${cap(meta.title)}`);
  if (cap(meta.h1))       parts.push(`H1: ${cap(meta.h1)}`);
  if (cap(meta.metaDesc)) parts.push(`Description: ${cap(meta.metaDesc)}`);
  if (cap(meta.ogDesc))   parts.push(`OG: ${cap(meta.ogDesc)}`);
  return `Context: ${parts.join(' | ')} | User Request: Explain "${text}" specifically within the scope of this page context.`;
}

// ── Core AI call ──────────────────────────────────────────────────────────────
async function callAI(provider, apiKey, text, meta = null) {
  const prompt = meta ? buildDeepDivePrompt(text, meta) : text;
  const model  = getModel(provider, apiKey);

  const { text: result } = await generateText({
    model,
    system:     SYSTEM_PROMPT,
    prompt,
    maxTokens:  256,
    abortSignal: AbortSignal.timeout(20000),
  });

  return result;
}

// ── Handler ───────────────────────────────────────────────────────────────────
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
      provider = apiKeyData.provider;
      apiKey   = apiKeyData.key;
    } else {
      const redis = new Redis({
        url:   process.env.UPSTASH_REDIS_REST_URL,
        token: process.env.UPSTASH_REDIS_REST_TOKEN
      });

      const date     = new Date().toISOString().slice(0, 10);
      const redisKey = `free:${user.id}:${date}`;

      const pipe = redis.pipeline();
      pipe.incr(redisKey);
      pipe.expire(redisKey, 90000);
      const [count] = await pipe.exec();

      if (count > FREE_LIMIT) {
        return res.status(429).json({
          error:   'NO_API_KEY',
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
