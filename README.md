# Verbatimly — Transcribe Video to Text

出海线新站（2026-11-11 立项）：免费视频转文字工具页，主攻词 transcribe video to text（14,800/月，哥飞版 KD 36.7，席位目标 subtitlekit DR6）。变现=免费+广告+不限量订阅，4 周验收三数（RPM 覆盖成本 / 付费转化≥1.5% / 滥用成本<20%）。

立项调研全档：`~/brain/products/05-出海线/transcription-立项调研-20261111.md`

## 架构（MVP：纯 Cloudflare，零服务器）

```
浏览器                     Cloudflare                      Groq
─────────────────────────────────────────────────────────────
视频/音频文件
 → decodeAudioData 抽音轨
 → 16kHz mono 重采样
 → lamejs 24kbps MP3       Pages (静态)
   (30min ≈ 5MB)    ─────►  verbatimly.ai
                           Worker /api/transcribe
                            ├ Turnstile 校验
                            ├ KV 日限流 3/日 ──────► whisper-large-v3
                            └ 转发 multipart      ◄─ verbose_json(segments)
 ← 同页渲染/编辑/导出 TXT·SRT·VTT（全免费）
```

- 付费墙（二期）：说话人分离 / 超 30 分钟 / 批量 / API。**SRT/VTT 永远免费**（隔壁 audiotranscriber.io 第 1 名免费给，收费=送转化）
- 鹿小伴服务器（二期）：MOV/MKV 深处理（ffmpeg）、AssemblyAI 说话人分离代理
- 免费档防滥用：Turnstile + IP/UA 指纹 KV 限流，单用户极端成本 ≈ $0.06/天（Groq turbo 备选降档）

## 部署

```bash
# 一次性：wrangler login；建 KV；配 secrets（GROQ_API_KEY / TURNSTILE_SECRET）
cd worker && wrangler kv namespace create RATE   # 把 id 填进 wrangler.toml
wrangler secret put GROQ_API_KEY
wrangler secret put TURNSTILE_SECRET
wrangler deploy                                   # API worker → verbatimly.ai/api/*

cd ../public && wrangler pages deploy . --project-name=verbatimly
# Pages 控制台绑自定义域 verbatimly.ai
```

Turnstile sitekey 部署前替换 `index.html` 的 `__TURNSTILE_SITEKEY__`。

## 红线（不做清单，详见立项报告）

YouTube 下载/转MP4 ❌ · SRT/VTT 付费墙 ❌ · 首屏营销长文/上传框上方广告 ❌ · 假星级结构化数据 ❌
