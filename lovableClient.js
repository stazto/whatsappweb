import fetch from 'cross-fetch';

const LOVABLE_AI_ENDPOINT = process.env.LOVABLE_AI_ENDPOINT || '';
const LOVABLE_API_KEY = process.env.LOVABLE_API_KEY || '';

export async function askLovableAI({ tenantId, from, text, context = {} }) {
  if (!LOVABLE_AI_ENDPOINT) return null;
  const res = await fetch(LOVABLE_AI_ENDPOINT, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(LOVABLE_API_KEY ? { 'Authorization': `Bearer ${LOVABLE_API_KEY}` } : {})
    },
    body: JSON.stringify({
      tenantId,
      user: from,
      platform: 'whatsapp-web',
      message: text,
      context
    })
  });
  if (!res.ok) {
    const t = await res.text().catch(() => '');
    throw new Error(`Lovable AI error ${res.status}: ${t.slice(0,300)}`);
  }
  const data = await res.json().catch(() => ({}));
  return (data && data.reply) ? String(data.reply) : null;
}
