import crypto from 'crypto';

export const config = { api: { bodyParser: false } };

const SUPABASE_URL         = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
const WEBHOOK_SECRET       = process.env.RAZORPAY_WEBHOOK_SECRET;

function getRawBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', chunk => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function fetchWithTimeout(url, options, ms = 7000) {
  const ctrl = new AbortController();
  const id = setTimeout(() => ctrl.abort(), ms);
  return fetch(url, { ...options, signal: ctrl.signal }).finally(() => clearTimeout(id));
}

async function getUserByEmail(email) {
  const r = await fetchWithTimeout(
    `${SUPABASE_URL}/auth/v1/admin/users?email=${encodeURIComponent(email)}`,
    {
      headers: {
        'Authorization': `Bearer ${SUPABASE_SERVICE_KEY}`,
        'apikey': SUPABASE_SERVICE_KEY
      }
    }
  );
  if (!r.ok) return null;
  const data = await r.json().catch(() => null);
  return data?.users?.[0] ?? null;
}

async function setUserPlan(userId, plan, subscriptionId = null) {
  const body = { plan };
  if (subscriptionId) body.subscription_id = subscriptionId;

  await fetchWithTimeout(
    `${SUPABASE_URL}/rest/v1/users_usage?user_id=eq.${userId}`,
    {
      method: 'PATCH',
      headers: {
        'Authorization': `Bearer ${SUPABASE_SERVICE_KEY}`,
        'apikey': SUPABASE_SERVICE_KEY,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(body)
    }
  );
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).end();

  const signature = req.headers['x-razorpay-signature'];
  const rawBody   = await getRawBody(req);
  const expected  = crypto.createHmac('sha256', WEBHOOK_SECRET).update(rawBody).digest('hex');

  if (signature !== expected) {
    return res.status(401).json({ error: 'Invalid signature' });
  }

  let parsed;
  try {
    parsed = JSON.parse(rawBody);
  } catch {
    return res.status(400).json({ error: 'Invalid JSON' });
  }

  const { event, payload } = parsed;
  const subscription = payload?.subscription?.entity;
  const email        = subscription?.notes?.email;

  if (!email) return res.status(200).json({ ok: true });

  const user = await getUserByEmail(email);
  if (!user) return res.status(200).json({ ok: true });

  if (event === 'subscription.activated' || event === 'subscription.charged') {
    await setUserPlan(user.id, 'pro', subscription.id);
  }

  if (event === 'subscription.cancelled' || event === 'subscription.completed') {
    await setUserPlan(user.id, 'free');
  }

  return res.status(200).json({ ok: true });
}
