/* Verbatimly Worker 入口：/api/transcribe 走转录逻辑，其余请求全部交给静态资源 */
import { handleTranscribe } from './transcribe.js';

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === '/api/transcribe') {
      return handleTranscribe(request, env);
    }
    const res = await env.ASSETS.fetch(request);
    // 覆盖 Cloudflare 对自定义域注入的默认 CSP：放行 Turnstile 的 data: 连接与子域，放行 blob 播放源
    const headers = new Headers(res.headers);
    headers.set('Content-Security-Policy',
      "default-src 'self'; script-src 'self' 'unsafe-inline' https://challenges.cloudflare.com; " +
      "style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; media-src 'self' blob:; " +
      "connect-src 'self' data: blob: https://*.challenges.cloudflare.com; " +
      "frame-src https://challenges.cloudflare.com; font-src 'self'; object-src 'none'; base-uri 'self'");
    return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
  },
};
