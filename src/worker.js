/* Verbatimly Worker 入口：/api/transcribe 走转录逻辑，其余请求全部交给静态资源 */
import { handleTranscribe } from './transcribe.js';

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === '/api/transcribe') {
      return handleTranscribe(request, env);
    }
    return env.ASSETS.fetch(request);
  },
};
