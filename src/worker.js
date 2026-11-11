/* Verbatimly Worker 入口：/api/transcribe 转录，/api/checkout 与 /api/verify 走 Waffo 付费，其余交给静态资源 */
import { handleTranscribe } from './transcribe.js';
import { createCheckout, verifyOrder, REF_RE } from './waffo.js';

const json = (data, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  });

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // http → https 301：避免同一内容被 http/https 两个地址收录
    if (url.protocol === 'http:') {
      url.protocol = 'https:';
      return Response.redirect(url.toString(), 301);
    }

    if (url.pathname === '/api/transcribe') return handleTranscribe(request, env);

    if (url.pathname === '/api/checkout') {
      if (request.method !== 'POST') return json({ error: 'method_not_allowed' }, 405);
      let body;
      try { body = await request.json(); } catch (e) { return json({ error: 'invalid_json' }, 400); }
      const ref = String((body && body.ref) || '');
      if (!REF_RE.test(ref)) return json({ error: 'invalid_ref' }, 400);
      const res = await createCheckout(env, { ref, origin: url.origin });
      return json(res.ok ? { url: res.url } : { error: res.error }, res.ok ? 200 : 502);
    }

    if (url.pathname === '/api/verify') {
      if (request.method !== 'GET') return json({ error: 'method_not_allowed' }, 405);
      const ref = String(url.searchParams.get('ref') || '');
      if (!REF_RE.test(ref)) return json({ paid: false, error: 'invalid_ref' }, 400);
      const res = await verifyOrder(env, ref);
      if (!res.ok) return json({ paid: false, error: res.error }, 502);
      if (!res.paid) return json({ paid: false });

      // 首次验证通过才发额度，避免重复领取
      const credits = parseInt(env.CREDITS_PER_PACK || '5', 10);
      const key = `p:${ref}`;
      let current = 0;
      try { current = parseInt((await env.RATE.get(key)) || '0', 10); } catch (e) {}
      if (current <= 0) {
        try { await env.RATE.put(key, String(credits), { expirationTtl: 31536000 }); } catch (e) {}
        return json({ paid: true, credits, orderId: res.orderId, fresh: true });
      }
      return json({ paid: true, credits: current, orderId: res.orderId, fresh: false });
    }

    const res = await env.ASSETS.fetch(request);
    const headers = new Headers(res.headers);
    headers.set('Content-Security-Policy',
      "default-src 'self'; script-src 'self' 'unsafe-inline' https://challenges.cloudflare.com; " +
      "style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; media-src 'self' blob:; " +
      "connect-src 'self' data: blob: https://*.challenges.cloudflare.com; " +
      "frame-src https://challenges.cloudflare.com; font-src 'self'; object-src 'none'; base-uri 'self'");

    // 缓存策略：HTML 每次回源；JS/CSS 短缓存，改动一分钟内生效（避免用户拿旧脚本）
    const ct = headers.get('content-type') || '';
    if (ct.includes('text/html')) {
      headers.set('Cache-Control', 'no-cache, must-revalidate');
    } else if (ct.includes('javascript') || ct.includes('text/css')) {
      headers.set('Cache-Control', 'public, max-age=60, must-revalidate');
    }

    return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
  },
};
