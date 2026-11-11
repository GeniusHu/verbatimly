/* 转录处理：Turnstile 校验 → KV 日限流(3/日) → 转发 Groq whisper-large-v3
   secrets: GROQ_API_KEY, TURNSTILE_SECRET（未配置时跳过校验，上线当天必配）  KV: RATE */
'use strict';

const GROQ_URL = 'https://api.groq.com/openai/v1/audio/transcriptions';
const MAX_UPLOAD = 25 * 1024 * 1024;

export async function handleTranscribe(request, env) {
  if (request.method !== 'POST') return json({ error: 'Not found' }, 404);

  let form;
  try { form = await request.formData(); } catch { return json({ error: 'Bad request' }, 400); }

  // 1) Turnstile 人机校验：通过 → 正常额度；缺失/失败 → 降级为每日 1 次，绝不拦死
  //    （Turnstile 依赖 CF 的网络探测，某些代理/VPN 环境会一直要求交互；真正的成本闸门是下面的 KV 限流）
  const token = form.get('turnstile') || '';
  let verified = false;
  if (env.TURNSTILE_SECRET && token) {
    const result = await verifyTurnstile(token, env.TURNSTILE_SECRET, ipOf(request));
    verified = result.success;
    console.log(verified ? 'turnstile: ok' : 'turnstile: rejected ' + JSON.stringify(result.codes || []));
  } else if (env.TURNSTILE_SECRET) {
    console.log('turnstile: EMPTY token — degraded quota');
  }

  // 2) 付费额度优先：订单号对应的额度包，不占每日免费额度，成功才扣
  const paidRefIn = String(form.get('paidRef') || '');
  let paidRef = '', paidCredits = 0;
  if (/^vb_[a-z0-9]{8,64}$/.test(paidRefIn)) {
    try { paidCredits = parseInt((await env.RATE.get(`p:${paidRefIn}`)) || '0', 10); } catch (e) {}
    if (paidCredits > 0) paidRef = paidRefIn;
  }

  // 3) KV 日限流：IP+UA 指纹 → 3 次/日（有付费额度时跳过）。
  //    Turnstile 结果只记录、不作为闸门——验证抖动时把用户锁死，比被刷更伤业务；
  //    真正的成本上限是 Groq 免费额度本身。
  const key = `r:${await sha256(ipOf(request) + (request.headers.get('User-Agent') || '').slice(0, 80))}:${new Date().toISOString().slice(0, 10)}`;
  const limit = parseInt(env.DAILY_LIMIT || '3', 10);
  let used = 0;
  try { used = parseInt((await env.RATE.get(key)) || '0', 10); } catch (e) {}
  if (!paidRef && used >= limit) {
    return json({ error: 'Free limit reached (3 files/day). Come back tomorrow — or buy a credit pack for more.', limit_reached: true }, 429);
  }

  // 3) 转发 Groq whisper-large-v3
  const file = form.get('file');
  if (!file || typeof file === 'string' || file.size === 0) return json({ error: 'No audio received.' }, 400);
  if (file.size > MAX_UPLOAD) return json({ error: 'Audio payload too large.' }, 413);

  const up = new FormData();
  up.append('file', file, 'audio.mp3');
  up.append('model', 'whisper-large-v3');
  up.append('response_format', 'verbose_json');
  up.append('temperature', '0');

  let groqRes;
  try {
    groqRes = await fetch(GROQ_URL, {
      method: 'POST',
      headers: { Authorization: `Bearer ${env.GROQ_API_KEY}` },
      body: up,
    });
  } catch (e) {
    return json({ error: 'Transcription service unreachable — try again in a moment.' }, 502);
  }
  if (groqRes.status === 429) return json({ error: 'Server is busy right now — try again in a minute.' }, 429);
  if (!groqRes.ok) {
    console.error('groq', groqRes.status, (await groqRes.text()).slice(0, 300));
    return json({ error: 'Transcription failed — please try again.' }, 502);
  }

  const data = await groqRes.json();
  // 成功后才记账：付费包优先扣，否则记免费额度
  if (paidRef) {
    try { await env.RATE.put(`p:${paidRef}`, String(paidCredits - 1), { expirationTtl: 31536000 }); } catch (e) {}
    console.log('paid credit used, remaining=', paidCredits - 1);
  } else {
    try { await env.RATE.put(key, String(used + 1), { expirationTtl: 90000 }); } catch (e) {}
  }

  return json({
    text: data.text || '',
    segments: (data.segments || []).map(s => ({ start: s.start, end: s.end, text: s.text })),
    // 告诉前端这次扣的是付费包还是免费额度，以及付费包还剩几次
    paid_remaining: paidRef ? paidCredits - 1 : null,
  }, 200);
}

function ipOf(request) { return request.headers.get('CF-Connecting-IP') || 'unknown'; }

async function verifyTurnstile(token, secret, ip) {
  try {
    const r = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ secret, response: token, remoteip: ip }),
    });
    const j = await r.json();
    return { success: !!j.success, codes: j['error-codes'] };
  } catch (e) {
    return { success: false, codes: ['siteverify-unreachable'] };
  }
}

async function sha256(s) {
  const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return [...new Uint8Array(d)].map(b => b.toString(16).padStart(2, '0')).join('');
}

function json(obj, status) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}
