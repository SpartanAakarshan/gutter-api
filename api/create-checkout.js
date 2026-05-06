const KEY_ID     = process.env.RAZORPAY_KEY_ID;
const KEY_SECRET = process.env.RAZORPAY_KEY_SECRET;
const PLAN_ID    = process.env.RAZORPAY_PLAN_ID;

const SUPABASE_URL  = process.env.SUPABASE_URL;
const SUPABASE_ANON = process.env.SUPABASE_ANON_KEY;

const ALLOWED_ORIGIN = 'https://gutter-api.vercel.app';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function fetchWithTimeout(url, options, ms = 10000) {
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
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const token = req.headers['authorization']?.replace('Bearer ', '');
  if (!token) return res.status(401).json({ error: 'No token' });

  const user = await getUser(token);
  if (!user?.id) return res.status(401).json({ error: 'Invalid session' });

  const { email } = req.body;
  if (!email || typeof email !== 'string' || !EMAIL_RE.test(email.trim())) {
    return res.status(400).json({ error: 'Valid email required' });
  }

  try {
    const r = await fetchWithTimeout('https://api.razorpay.com/v1/subscriptions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Basic ' + Buffer.from(`${KEY_ID}:${KEY_SECRET}`).toString('base64')
      },
      body: JSON.stringify({
        plan_id: PLAN_ID,
        total_count: 120,
        quantity: 1,
        notes: { email: email.trim(), user_id: user.id }
      })
    });

    const data = await r.json();
    if (data.error) return res.status(502).json({ error: data.error.description });

    return res.status(200).json({ subscription_id: data.id, key_id: KEY_ID });
  } catch (err) {
    return res.status(500).json({ error: 'Internal server error' });
  }
}
