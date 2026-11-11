/* Verbatimly 前端：文件 → 浏览器抽音轨(16kHz mono) → lamejs 24kbps MP3 → Worker → Groq → 可编辑转录稿
   设计约束：零服务器依赖、30 分钟文件全程内存可控、SRT/VTT/TXT 导出免费。 */
'use strict';

const MAX_MINUTES = 30.5;   // 免费档上限（含少量余量）
const MAX_BYTES = 500 * 1024 * 1024; // 500MB（只传音轨，浏览器抽轨后仅 ~5MB）
const API = '/api/transcribe';

const $ = (s) => document.querySelector(s);
const dz = $('#dropzone'), fileInput = $('#fileInput');
const statusBox = $('#status'), resultBox = $('#result');
const player = $('#player');
let segments = [];          // [{start,end,text}]，导出的唯一事实源
let busy = false;
let audioUrl = null;        // 本地 blob：点击时间戳跳播用，不上传

/* ---------- 入口 ---------- */
dz.addEventListener('click', () => fileInput.click());
dz.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') fileInput.click(); });
fileInput.addEventListener('change', () => { if (fileInput.files[0]) handleFile(fileInput.files[0]); });
['dragover', 'dragenter'].forEach(ev => dz.addEventListener(ev, (e) => { e.preventDefault(); dz.classList.add('dragging'); }));
['dragleave', 'drop'].forEach(ev => dz.addEventListener(ev, (e) => { e.preventDefault(); dz.classList.remove('dragging'); }));
dz.addEventListener('drop', (e) => { const f = e.dataTransfer.files[0]; if (f) handleFile(f); });

async function handleFile(file) {
  if (busy) return;
  if (file.size > MAX_BYTES) return fail('File too large — free tier allows up to 100 MB. Compress it or try a shorter clip.');
  busy = true;
  try {
    ensureTurnstile(); // 后台预热人机验证（无感，不打扰用户）
    setStatus('Reading file…');
    // 本地播放源：替换旧的
    if (audioUrl) URL.revokeObjectURL(audioUrl);
    audioUrl = URL.createObjectURL(file);
    player.src = audioUrl;
    const dur = await probeDuration(file);
    if (dur && dur > MAX_MINUTES * 60) {
      return fail(`Free tier transcribes up to 30 minutes per file — yours is ${fmtMin(dur)}. Trim it, or split and upload twice.`);
    }

    setStatus('Extracting audio track on your device — your video file never leaves this computer.');
    const buf = await decodeAudio(file);
    if (buf.duration > MAX_MINUTES * 60) {
      return fail('Audio track is longer than 30 minutes — free tier limit.');
    }

    setStatus('Compressing audio locally — only a small audio track (~5 MB) gets uploaded, not your video.');
    const mp3 = await encodeMp3(resampleMono16k(buf));
    if (mp3.size > 24 * 1024 * 1024) {
      return fail('Audio payload unexpectedly large — try a shorter file.');
    }

    setStatus('Uploading & transcribing… this usually takes well under a minute for a 10-minute video.');
    const t0 = performance.now();
    const data = await transcribe(mp3, file.name);
    const secs = ((performance.now() - t0) / 1000).toFixed(0);

    segments = data.segments && data.segments.length ? data.segments
             : [{ start: 0, end: 0, text: data.text || '' }];
    render();
    setStatus(`Done in ${secs}s — ${fmtMin(buf.duration)} of audio, ${segments.length} segments. Transcript is editable below.`);
  } catch (err) {
    console.error(err);
    fail(err && err.userMessage ? err.userMessage : friendly(err));
  } finally {
    busy = false;
  }
}

/* ---------- 音频管线 ---------- */
function probeDuration(file) {
  return new Promise((resolve) => {
    const v = document.createElement(file.type.startsWith('audio') ? 'audio' : 'video');
    v.preload = 'metadata';
    v.onloadedmetadata = () => { resolve(v.duration || 0); URL.revokeObjectURL(v.src); };
    v.onerror = () => resolve(0); // 预检失败不挡路，交给解码器判断
    v.src = URL.createObjectURL(file);
  });
}

async function decodeAudio(file) {
  const bytes = await file.arrayBuffer();
  const ctx = new (window.AudioContext || window.webkitAudioContext)();
  try {
    return await ctx.decodeAudioData(bytes);
  } catch (e) {
    const err = new Error('decode failed');
    err.userMessage = 'Could not read an audio track from this file. MP4/WebM video and common audio files work best; for MOV/MKV try the MP4 export.';
    throw err;
  }
}

function resampleMono16k(buf) {
  const target = 16000;
  const frames = Math.ceil(buf.duration * target);
  const off = new OfflineAudioContext(1, frames, target);
  off.createBufferSource(); // 确认 API 可用
  const src = off.createBufferSource();
  src.buffer = buf;
  src.connect(off.destination);
  src.start();
  return off.startRendering();
}

async function encodeMp3(pcmBuf) {
  const enc = new lamejs.Mp3Encoder(1, 16000, 24);
  const samples = pcmBuf.getChannelData(0);
  const n = samples.length;
  const block = 1152;
  const out = [];
  // 每处理 ~8 秒音频让出一次主线程，保进度条不冻结
  const yieldEvery = Math.floor(block * 350);
  let i = 0, sinceYield = 0;
  while (i < n) {
    const chunk = new Int16Array(Math.min(block, n - i));
    for (let j = 0; j < chunk.length; j++) {
      let s = samples[i + j];
      s = s < -1 ? -1 : s > 1 ? 1 : s;
      chunk[j] = s < 0 ? s * 0x8000 : s * 0x7FFF;
    }
    const d = enc.encodeBuffer(chunk);
    if (d.length) out.push(new Int8Array(d));
    i += chunk.length;
    sinceYield += chunk.length;
    if (sinceYield > yieldEvery) {
      sinceYield = 0;
      await new Promise(r => setTimeout(r, 0));
    }
  }
  const end = enc.flush();
  if (end.length) out.push(new Int8Array(end));
  return new Blob(out, { type: 'audio/mpeg' });
}

/* ---------- Turnstile：无感模式，选文件时预热，提交时取 token ---------- */
let tsToken = '', tsRendered = false;
function ensureTurnstile() {
  if (tsRendered || !window.turnstile) return;
  tsRendered = true;
  try {
    turnstile.render('#tsContainer', {
      sitekey: window.VB_SITEKEY,
      size: 'invisible',
      callback: (t) => { tsToken = t; },
      'error-callback': () => { tsToken = ''; },
      'expired-callback': () => { tsToken = ''; },
    });
  } catch (e) { /* Turnstile 未加载时按空 token 走，服务端会拦 */ }
}
async function getTurnstileToken() {
  ensureTurnstile();
  if (tsToken) return tsToken;
  for (let i = 0; i < 16 && !tsToken; i++) await new Promise(r => setTimeout(r, 500));
  return tsToken || '';
}

/* ---------- 转录请求 ---------- */
async function transcribe(mp3, filename) {
  const tsToken = await getTurnstileToken();
  const fd = new FormData();
  fd.append('file', mp3, 'audio.mp3');
  fd.append('turnstile', tsToken);
  let res;
  try {
    res = await fetch(API, { method: 'POST', body: fd });
  } catch (e) {
    const err = new Error('network'); err.userMessage = 'Network error — check your connection and try again.'; throw err;
  }
  if (res.status === 429) {
    const err = new Error('rate'); err.userMessage = 'Free limit reached (3 files/day). Come back tomorrow — or check out the paid plan for more.'; throw err;
  }
  if (!res.ok) {
    let msg = 'Transcription failed — please try again.';
    try { const j = await res.json(); if (j && j.error) msg = j.error; } catch (e) {}
    throw new Error(msg);
  }
  return res.json();
}

/* ---------- 渲染与导出 ---------- */
function render() {
  const box = $('#transcript');
  box.innerHTML = '';
  segments.forEach(seg => {
    const p = document.createElement('p');
    p.dataset.start = seg.start; p.dataset.end = seg.end;
    const ts = document.createElement('span');
    ts.className = 'ts'; ts.textContent = `[${fmtClock(seg.start)}]`;
    ts.title = 'Jump to this moment';
    ts.addEventListener('click', () => {
      player.currentTime = seg.start;
      player.play().catch(() => {});
    });
    p.appendChild(ts);
    p.appendChild(document.createTextNode(seg.text.trim()));
    box.appendChild(p);
  });
  resultBox.hidden = false;
  resultBox.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

/* 播放时高亮当前行 */
player.addEventListener('timeupdate', () => {
  const t = player.currentTime;
  let active = null;
  for (const p of $('#transcript').querySelectorAll('p')) {
    const s = parseFloat(p.dataset.start), e = parseFloat(p.dataset.end);
    const hit = t >= s && t < Math.max(e, s + 0.5);
    p.classList.toggle('playing', hit);
    if (hit) active = p;
  }
  if (active && !userScrolling) active.scrollIntoView({ block: 'nearest' });
});
/* 用户手动滚动时暂停自动跟随，3 秒后恢复 */
let userScrolling = false, scrollTimer = null;
$('#transcript').addEventListener('scroll', () => {
  userScrolling = true;
  clearTimeout(scrollTimer);
  scrollTimer = setTimeout(() => { userScrolling = false; }, 3000);
});

$('#showTimestamps').addEventListener('change', (e) => {
  document.querySelectorAll('.ts').forEach(el => el.style.display = e.target.checked ? '' : 'none');
});
$('#copyBtn').addEventListener('click', () => { navigator.clipboard.writeText(plainText()); flash('Copied'); });
$('#txtBtn').addEventListener('click', () => download('transcript.txt', 'text/plain', plainText()));
$('#srtBtn').addEventListener('click', () => download('transcript.srt', 'text/plain', srtText()));
$('#vttBtn').addEventListener('click', () => download('transcript.vtt', 'text/vtt', vttText()));

function currentLines() {
  // 从 DOM 收集：用户可编辑文本，时间戳以 dataset 为准
  return [...$('#transcript').querySelectorAll('p')].map(p => ({
    start: parseFloat(p.dataset.start || 0),
    end: parseFloat(p.dataset.end || 0),
    text: [...p.childNodes].filter(n => n.nodeType === 3).map(n => n.textContent).join('').trim(),
  })).filter(l => l.text);
}
function plainText() { return currentLines().map(l => `[${fmtClock(l.start)}] ${l.text}`).join('\n\n'); }
function srtText() {
  return currentLines().map((l, i) =>
    `${i + 1}\n${fmtStamp(l.start, ',')} --> ${fmtStamp(Math.max(l.end, l.start + 0.5), ',')}\n${l.text}`
  ).join('\n\n') + '\n';
}
function vttText() {
  return 'WEBVTT\n\n' + currentLines().map((l, i) =>
    `${i + 1}\n${fmtStamp(l.start, '.')} --> ${fmtStamp(Math.max(l.end, l.start + 0.5), '.')}\n${l.text}`
  ).join('\n\n') + '\n';
}
function download(name, mime, text) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([text], { type: mime }));
  a.download = name; a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}
function flash(msg) { const b = $('#copyBtn'); const old = b.textContent; b.textContent = msg; setTimeout(() => b.textContent = old, 1200); }

/* ---------- 杂项 ---------- */
function setStatus(html, isErr) {
  statusBox.hidden = false;
  statusBox.innerHTML = isErr ? `<p class="err">${html}</p>` : `<p>${html}</p><div class="bar"><span></span></div>`;
  if (!isErr) requestAnimationFrame(() => { const bar = statusBox.querySelector('.bar > span'); if (bar) bar.style.width = '35%'; });
}
function fail(msg) { setStatus(msg, true); }
function friendly(err) { return (err && err.message === 'network') ? 'Network error.' : 'Something went wrong — please try again.'; }
function fmtMin(sec) { const m = Math.round(sec / 60); return `${m} minute${m === 1 ? '' : 's'}`; }
function fmtClock(s) {
  s = Math.floor(s || 0);
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), ss = s % 60;
  const mm = String(m).padStart(2, '0'), sss = String(ss).padStart(2, '0');
  return h ? `${h}:${mm}:${sss}` : `${mm}:${sss}`;
}
function fmtStamp(s, sep) {
  const ms = Math.floor((s % 1) * 1000);
  const base = fmtClock(Math.floor(s)).padStart(8, '0');
  return `${base}${sep}${String(ms).padStart(3, '0')}`;
}
