/* Verbatimly: file → 浏览器抽音轨(16kHz mono) → lamejs 24kbps MP3 → Worker → Groq → 可编辑转录稿
   设计约束：零服务器依赖、30 分钟文件全程内存可控、SRT/VTT/TXT 导出免费。 */
'use strict';

const MAX_FREE_MINUTES = 30.5;
const MAX_PAID_MINUTES = 60.5;   // 付费额度包给到 60 分钟
const MAX_BYTES = 500 * 1024 * 1024;
const API = '/api/transcribe';

const $ = (s) => document.querySelector(s);
const dz = $('#dropzone'), fileInput = $('#fileInput');
const uploadView = $('#uploadView'), resultView = $('#resultView');
const progress = $('#progress'), progText = $('#progText'), progFill = $('#progFill');
const player = $('#player'), wave = $('#wave'), playhead = $('#playhead');
const transcriptEl = $('#transcript');
const timeNow = $('#timeNow'), timeTotal = $('#timeTotal');

let segments = [];
let busy = false;
let audioUrl = null;
let audioBuffer = null;
let currentName = '';

/* ---------- 付费额度：订单号存在本地，作为无账号凭证 ---------- */
const PAID_KEY = 'vb_paid_ref';
const PAID_LEFT_KEY = 'vb_paid_left';
let paidRef = '';
let paidLeft = 0;
try {
  paidRef = localStorage.getItem(PAID_KEY) || '';
  paidLeft = parseInt(localStorage.getItem(PAID_LEFT_KEY) || '0', 10) || 0;
} catch (e) {}

function updateQuotaLine() {
  const badge = $('#paidBadge');
  if (!badge) return;
  if (paidLeft > 0) {
    badge.textContent = ` · ${paidLeft} paid credit${paidLeft === 1 ? '' : 's'} left`;
    badge.className = 'paid-badge';
  } else {
    badge.textContent = '';
    badge.className = '';
  }
  // 还有付费额度时不再催着买
  const box = $('#buyBox');
  if (box && paidLeft > 0) box.hidden = true;

  // 上限提示跟着档位走：免费 30 分钟，付费 60 分钟
  const note = document.querySelector('.quota-note');
  if (note) {
    if (paidLeft > 0) {
      note.textContent = 'Your credit pack allows up to 60 minutes per file.';
    } else {
      note.innerHTML = 'Longer than 30 minutes? <a href="/video-to-mp3">Extract the audio first</a>, or split the file into two.';
    }
  }
}

// 页面加载时若有订单号，向服务端确认剩余额度（verify 不扣次数）
if (paidRef) {
  fetch('/api/verify?ref=' + encodeURIComponent(paidRef))
    .then((r) => r.json())
    .then((j) => {
      if (j && j.paid) {
        paidLeft = j.credits || 0;
        try { localStorage.setItem(PAID_LEFT_KEY, String(paidLeft)); } catch (e) {}
        updateQuotaLine();
      }
    })
    .catch(() => {});
}
updateQuotaLine();

function showNotice(msg, isErr) {
  const n = $('#notice');
  n.hidden = false;
  n.classList.toggle('err', !!isErr);
  n.textContent = msg;
}
(function handlePaidReturn() {
  const u = new URL(location.href);
  if (u.searchParams.get('paid') !== '1') return;
  const ref = u.searchParams.get('ref') || '';
  history.replaceState({}, '', '/');
  if (!ref) return;
  showNotice('Confirming your payment…');
  fetch('/api/verify?ref=' + encodeURIComponent(ref))
    .then((r) => r.json())
    .then((j) => {
      if (j && j.paid) {
        paidRef = ref;
        paidLeft = j.credits || 0;
        try {
          localStorage.setItem(PAID_KEY, ref);
          localStorage.setItem(PAID_LEFT_KEY, String(paidLeft));
        } catch (e) {}
        showNotice(`Payment received — ${j.credits} file credits added to this browser.`);
        updateQuotaLine();
      } else {
        showNotice('Payment not confirmed yet. If you were charged, reload this page in a minute.', true);
      }
    })
    .catch(() => showNotice('Could not confirm the payment — reload the page to retry.', true));
})();

/* ---------- 上传交互：点击 / 键盘 / 整页拖拽 ---------- */
dz.addEventListener('click', (e) => { if (e.target === fileInput) return; fileInput.click(); });
dz.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); fileInput.click(); } });
fileInput.addEventListener('change', () => { if (fileInput.files[0]) handleFile(fileInput.files[0]); });

let dragDepth = 0;
document.addEventListener('dragenter', (e) => { e.preventDefault(); dragDepth++; dz.classList.add('dragging'); });
document.addEventListener('dragover', (e) => e.preventDefault());
document.addEventListener('dragleave', () => { dragDepth--; if (dragDepth <= 0) { dragDepth = 0; dz.classList.remove('dragging'); } });
document.addEventListener('drop', (e) => {
  e.preventDefault();
  dragDepth = 0;
  dz.classList.remove('dragging');
  const f = e.dataTransfer.files[0];
  if (f) handleFile(f);
});

/* ---------- 进度与错误 ---------- */
function setProgress(pct, text) {
  progress.hidden = false;
  progText.classList.remove('err');
  if (text != null) progText.textContent = text;
  progFill.style.width = Math.min(100, Math.max(0, pct)) + '%';
}
function fail(msg) {
  progress.hidden = false;
  progText.classList.add('err');
  progText.textContent = msg;
  progFill.style.background = '#b4342c';
}
function resetProgress() {
  progress.hidden = true;
  progFill.style.width = '0%';
  progFill.style.background = '';
}

/* ---------- 主流程 ---------- */
async function handleFile(file) {
  if (busy) return;
  if (file.size > MAX_BYTES) return fail('File too large — the limit is 500 MB per file. Compress it or trim the clip first.');
  busy = true;
  currentName = file.name;
  try {
    ensureTurnstile();
    setProgress(2, 'Reading file…');

    if (audioUrl) URL.revokeObjectURL(audioUrl);
    audioUrl = URL.createObjectURL(file);
    player.src = audioUrl;

    const limitMin = paidLeft > 0 ? MAX_PAID_MINUTES : MAX_FREE_MINUTES;
    const dur = await probeDuration(file);
    if (dur && dur > limitMin * 60) {
      return fail(`This file is ${fmtMin(dur)} long — the limit is ${Math.floor(limitMin)} minutes${paidLeft > 0 ? '.' : ' on the free tier. A credit pack raises it to 60 minutes.'}`);
    }

    setProgress(6, 'Extracting the audio track on your device — your video never leaves this computer.');
    const buf = await decodeAudio(file);
    audioBuffer = buf;
    if (buf.duration > limitMin * 60) return fail(`Audio track is longer than ${Math.floor(limitMin)} minutes — current limit.`);
    setProgress(25, 'Preparing audio…');

    const mono = await resampleMono16k(buf);
    setProgress(32, 'Compressing audio locally — only a small audio track gets uploaded, not your video.');
    const mp3 = await encodeMp3(mono, (p) => { progFill.style.width = (32 + p * 40).toFixed(1) + '%'; });
    if (mp3.size > 24 * 1024 * 1024) return fail('Audio payload unexpectedly large — try a shorter file.');

    if (!tsToken) setProgress(74, 'Verifying you are human… if a checkbox appears below, click it.');
    const tsTok = await getTurnstileToken();
    if (!tsTok) console.log('[flow] no turnstile token — continuing');

    setProgress(74, 'Uploading & transcribing… this usually takes well under a minute for a 10-minute video.');
    const t0 = performance.now();
    const res = await uploadAudio(mp3, tsTok, {
      onProgress: (p) => { progFill.style.width = (74 + p * 14).toFixed(1) + '%'; },
      onUploaded: () => startCreep(88, 97),
    });
    cancelCreep();
    const secs = ((performance.now() - t0) / 1000).toFixed(0);

    if (res.status === 0) throw new Error(res.data.error);
    if (res.status === 429) {
      const err = new Error('rate');
      err.userMessage = (res.data && res.data.error) || 'Free limit reached. Come back tomorrow.';
      err.limitReached = !!(res.data && res.data.limit_reached);
      throw err;
    }
    if (res.status !== 200 || !res.data) {
      throw new Error((res.data && res.data.error) || 'Transcription failed — please try again.');
    }

    const data = res.data;
    segments = data.segments && data.segments.length ? data.segments
             : [{ start: 0, end: 0, text: data.text || '' }];
    // 服务端告诉我们这次扣的是付费包还是免费额度
    if (data.paid_remaining != null) {
      paidLeft = data.paid_remaining;
      try { localStorage.setItem(PAID_LEFT_KEY, String(paidLeft)); } catch (e) {}
      updateQuotaLine();
    }
    $('#buyBox').hidden = true;
    setProgress(100, 'Done');
    showResult(secs, buf.duration);
  } catch (err) {
    console.error(err);
    const msg = (err && (err.userMessage || err.message)) || 'Something went wrong — please try again.';
    fail(msg);
    if (err && err.limitReached && paidLeft <= 0) {
      const box = $('#buyBox');
      box.hidden = false;
      box.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    }
  } finally {
    busy = false;
  }
}

/* ---------- 购买额度包 ---------- */
async function startCheckout() {
  const btn = $('#buyBtn');
  const old = btn ? btn.textContent : '';
  if (btn) { btn.disabled = true; btn.textContent = 'Opening checkout…'; }

  const ref = 'vb_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 10);
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 15000);
      const r = await fetch('/api/checkout', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ ref }),
        signal: ctrl.signal,
      });
      clearTimeout(timer);
      const j = await r.json();
      if (j && j.url) { location.href = j.url; return; }
      throw new Error((j && j.error) || 'empty response');
    } catch (e) {
      console.log('[checkout] attempt', attempt, 'failed:', e && e.message);
      if (attempt === 3) {
        showNotice('Could not open checkout — check your connection and try again.', true);
        if (btn) { btn.disabled = false; btn.textContent = old; }
        return;
      }
      await new Promise((r2) => setTimeout(r2, 1500));
    }
  }
}
$('#buyBtn').addEventListener('click', startCheckout);
$('#buyLink').addEventListener('click', (e) => { e.preventDefault(); startCheckout(); });

/* ---------- 音频管线 ---------- */
function probeDuration(file) {
  return new Promise((resolve) => {
    const v = document.createElement(file.type.startsWith('audio') ? 'audio' : 'video');
    v.preload = 'metadata';
    v.onloadedmetadata = () => { resolve(v.duration || 0); URL.revokeObjectURL(v.src); };
    v.onerror = () => resolve(0);
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
  const src = off.createBufferSource();
  src.buffer = buf;
  src.connect(off.destination);
  src.start();
  return off.startRendering();
}

async function encodeMp3(pcmBuf, onProgress) {
  const enc = new lamejs.Mp3Encoder(1, 16000, 24);
  const samples = pcmBuf.getChannelData(0);
  const n = samples.length;
  const block = 1152;
  const out = [];
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
      if (onProgress) onProgress(i / n);
      await new Promise(r => setTimeout(r, 0));
    }
  }
  const end = enc.flush();
  if (end.length) out.push(new Int8Array(end));
  if (onProgress) onProgress(1);
  return new Blob(out, { type: 'audio/mpeg' });
}

/* ---------- 上传（XHR，拿真实字节进度） ---------- */
function uploadAudio(blob, token, hooks) {
  return new Promise((resolve) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', API);
    xhr.responseType = 'text';
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable && hooks.onProgress) hooks.onProgress(e.loaded / e.total);
    };
    xhr.upload.onload = () => { if (hooks.onUploaded) hooks.onUploaded(); };
    xhr.onload = () => {
      let data = null;
      try { data = JSON.parse(xhr.responseText); } catch (e) {}
      console.log('[transcribe] HTTP', xhr.status);
      resolve({ status: xhr.status, data });
    };
    xhr.onerror = () => {
      console.log('[transcribe] network error');
      resolve({ status: 0, data: { error: 'Network error — check your connection and try again.' } });
    };
    const fd = new FormData();
    fd.append('file', blob, 'audio.mp3');
    fd.append('turnstile', token);
    if (paidRef) fd.append('paidRef', paidRef);
    console.log('[transcribe] POST', (blob.size / 1048576).toFixed(2), 'MB · token len', token.length);
    xhr.send(fd);
  });
}

/* 等服务器返回时，进度条缓动到 97 上限 */
let creepTimer = null;
function startCreep(from, to) {
  cancelCreep();
  let p = from;
  creepTimer = setInterval(() => {
    if (p < to) { p += 0.6; progFill.style.width = p.toFixed(1) + '%'; }
  }, 420);
}
function cancelCreep() { if (creepTimer) { clearInterval(creepTimer); creepTimer = null; } }

/* ---------- Turnstile：无感模式，选文件时预热，提交时取 token ---------- */
let tsToken = '', tsWidgetId = null;
const tsLog = (...a) => console.log('[turnstile]', ...a);

function ensureTurnstile() {
  if (tsWidgetId !== null) return true;
  if (!window.turnstile) return false;
  try {
    tsWidgetId = turnstile.render('#tsContainer', {
      sitekey: window.VB_SITEKEY,
      appearance: 'interaction-only',
      callback: (t) => { tsToken = t; tsLog('token OK, len=' + t.length); },
      'error-callback': (code) => { tsToken = ''; tsLog('error-callback:', code); },
      'expired-callback': () => { tsToken = ''; tsLog('token expired'); },
      'timeout-callback': () => { tsToken = ''; tsLog('challenge timeout'); },
    });
    tsLog('rendered, widgetId=' + tsWidgetId);
    return true;
  } catch (e) {
    tsLog('render FAILED:', e && e.message);
    return false;
  }
}
async function getTurnstileToken() {
  if (tsToken) return tsToken;
  tsLog('waiting for token…');
  for (let i = 0; i < 24 && !tsToken; i++) {
    ensureTurnstile();
    await new Promise(r => setTimeout(r, 500));
  }
  tsLog(tsToken ? 'token acquired' : 'token EMPTY after 12s');
  return tsToken || '';
}

/* ---------- 结果视图 ---------- */
function showResult(secs, audioDur) {
  $('#resultTitle').textContent = currentName || 'Your transcript';
  $('#resultSummary').textContent = `${fmtMin(audioDur)} of audio · ${segments.length} segments · transcribed in ${secs}s`;
  uploadView.hidden = true;
  document.body.classList.add('result');
  render();
  requestAnimationFrame(() => { drawWave(); });
  window.scrollTo({ top: 0 });
}

function backToUpload() {
  document.body.classList.remove('result');
  uploadView.hidden = false;
  resetProgress();
  fileInput.value = '';
  if (audioUrl) { URL.revokeObjectURL(audioUrl); audioUrl = null; }
  player.pause();
  player.removeAttribute('src');
  player.load();
  segments = [];
  audioBuffer = null;
  currentName = '';
  transcriptEl.innerHTML = '';
  playhead.hidden = true;
  timeNow.textContent = '00:00';
  timeTotal.textContent = '/ 00:00';
  window.scrollTo({ top: 0 });
}
$('#newFileBtn').addEventListener('click', backToUpload);

function render() {
  transcriptEl.innerHTML = '';
  segments.forEach((seg) => {
    const row = document.createElement('div');
    row.className = 'trow';
    row.dataset.start = seg.start;
    row.dataset.end = seg.end;
    row.dataset.speaker = '0';

    // 说话人标签：点一下循环 S → S1 → S2 → S3 → S
    const spk = document.createElement('span');
    spk.className = 'spk';
    spk.textContent = 'S';
    spk.title = 'Click to label the speaker';
    spk.addEventListener('click', () => {
      const next = (parseInt(row.dataset.speaker || '0', 10) + 1) % 4;
      row.dataset.speaker = String(next);
      spk.textContent = next ? 'S' + next : 'S';
      spk.classList.toggle('on', next > 0);
    });

    const t = document.createElement('span');
    t.className = 't';
    t.textContent = fmtClock(seg.start);
    t.title = 'Jump to this moment';
    t.addEventListener('click', () => {
      player.currentTime = seg.start;
      player.play().catch(() => {});
    });
    const p = document.createElement('p');
    p.textContent = (seg.text || '').trim();
    row.appendChild(spk);
    row.appendChild(t);
    row.appendChild(p);
    transcriptEl.appendChild(row);
  });
}

/* ---------- 波形：圆角柱 + 峰值归一化 ---------- */
const BAR_W = 2, BAR_GAP = 1;
const waveMask = $('#waveMask');

function drawWave() {
  if (!audioBuffer) return;
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const w = wave.clientWidth, h = wave.clientHeight;
  if (!w || !h) return;
  wave.width = Math.round(w * dpr);
  wave.height = Math.round(h * dpr);
  const ctx = wave.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);

  const data = audioBuffer.getChannelData(0);
  const bars = Math.max(1, Math.floor(w / (BAR_W + BAR_GAP)));
  const per = data.length / bars;
  const mid = h / 2;
  const maxH = h - 10;

  // 每根柱子取区间 RMS（比峰值平滑，没有尖刺），再按全局最大值归一化
  const peaks = new Float32Array(bars);
  let maxPeak = 0;
  for (let b = 0; b < bars; b++) {
    let sum = 0, count = 0;
    const start = Math.floor(b * per);
    const end = Math.min(data.length, Math.floor((b + 1) * per));
    const step = Math.max(1, Math.floor((end - start) / 40));
    for (let i = start; i < end; i += step) {
      const v = data[i];
      sum += v * v;
      count++;
    }
    const rms = count ? Math.sqrt(sum / count) : 0;
    peaks[b] = rms;
    if (rms > maxPeak) maxPeak = rms;
  }
  const norm = maxPeak > 0 ? 1 / maxPeak : 1;

  ctx.fillStyle = '#0f766e';
  for (let b = 0; b < bars; b++) {
    const amp = Math.max(0.04, peaks[b] * norm);
    const bh = Math.max(3, amp * maxH);
    const x = b * (BAR_W + BAR_GAP);
    const y = mid - bh / 2;
    ctx.beginPath();
    if (ctx.roundRect) ctx.roundRect(x, y, BAR_W, bh, Math.min(BAR_W / 2, bh / 2));
    else ctx.rect(x, y, BAR_W, bh);
    ctx.fill();
  }
  paintMask(player.duration ? player.currentTime / player.duration : 0);
}

/* 未播放部分盖一层同色半透明，形成"已播放"对比 */
function paintMask(progress) {
  if (!waveMask) return;
  const p = Math.min(1, Math.max(0, progress || 0));
  waveMask.style.left = (p * 100).toFixed(2) + '%';
  // 没播放过时整条波形保持实色；一旦开始播放才出现进度对比
  waveMask.parentElement.classList.toggle('played', p > 0.002);
}

let resizeTimer = null;
window.addEventListener('resize', () => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => { if (document.body.classList.contains('result')) drawWave(); }, 200);
});

wave.addEventListener('click', (e) => {
  const r = wave.getBoundingClientRect();
  const pct = (e.clientX - r.left) / r.width;
  const d = player.duration || (audioBuffer ? audioBuffer.duration : 0);
  if (d > 0) {
    player.currentTime = pct * d;
    player.play().catch(() => {});
  }
});

/* ---------- 播放器 ---------- */
$('#playBtn').addEventListener('click', () => {
  if (player.paused) player.play().catch(() => {});
  else player.pause();
});
const playBtn = $('#playBtn');
player.addEventListener('play', () => playBtn.classList.add('playing'));
player.addEventListener('pause', () => playBtn.classList.remove('playing'));
player.addEventListener('loadedmetadata', () => { timeTotal.textContent = '/ ' + fmtClock(player.duration || 0); });

let userScrolling = false, scrollTimer = null;
transcriptEl.addEventListener('scroll', () => {
  userScrolling = true;
  clearTimeout(scrollTimer);
  scrollTimer = setTimeout(() => { userScrolling = false; }, 3000);
});

player.addEventListener('timeupdate', () => {
  const d = player.duration || 0;
  if (!d) return;
  const pct = player.currentTime / d;
  playhead.hidden = false;
  playhead.style.left = `calc(${(pct * 100).toFixed(3)}% - 1px)`;
  paintMask(pct);
  timeNow.textContent = fmtClock(player.currentTime);

  let active = null;
  for (const row of transcriptEl.querySelectorAll('.trow')) {
    const s = parseFloat(row.dataset.start), e = parseFloat(row.dataset.end);
    const hit = player.currentTime >= s && player.currentTime < Math.max(e, s + 0.5);
    row.classList.toggle('cur', hit);
    if (hit) active = row;
  }
  if (active && !userScrolling) active.scrollIntoView({ block: 'nearest' });
});

/* ---------- 时间戳开关 ---------- */
$('#showTimestamps').addEventListener('change', (e) => {
  document.querySelectorAll('.trow .t').forEach(el => el.classList.toggle('hide', !e.target.checked));
});

/* ---------- 导出 ---------- */
function currentLines() {
  return [...transcriptEl.querySelectorAll('.trow')].map(row => ({
    start: parseFloat(row.dataset.start || 0),
    end: parseFloat(row.dataset.end || 0),
    speaker: parseInt(row.dataset.speaker || '0', 10),
    text: row.querySelector('p').textContent.trim(),
  })).filter(l => l.text);
}
function plainText() {
  return currentLines().map(l => `[${fmtClock(l.start)}] ${l.speaker ? `Speaker ${l.speaker}: ` : ''}${l.text}`).join('\n\n');
}
function srtText() {
  return currentLines().map((l, i) => {
    const text = l.speaker ? `Speaker ${l.speaker}: ${l.text}` : l.text;
    return `${i + 1}\n${fmtStamp(l.start, ',')} --> ${fmtStamp(Math.max(l.end, l.start + 0.5), ',')}\n${text}`;
  }).join('\n\n') + '\n';
}
function vttText() {
  return 'WEBVTT\n\n' + currentLines().map((l, i) => {
    const text = l.speaker ? `<v Speaker ${l.speaker}>${l.text}` : l.text;
    return `${i + 1}\n${fmtStamp(l.start, '.')} --> ${fmtStamp(Math.max(l.end, l.start + 0.5), '.')}\n${text}`;
  }).join('\n\n') + '\n';
}

/* 全局轻提示：上传视图和结果视图都能看到 */
function toast(msg) {
  let el = document.getElementById('__toast');
  if (!el) {
    el = document.createElement('div');
    el.id = '__toast';
    el.style.cssText = 'position:fixed;left:50%;bottom:36px;transform:translateX(-50%);' +
      'background:#141414;color:#f6f5f2;padding:12px 22px;border-radius:999px;font-size:15px;' +
      'z-index:9999;opacity:0;transition:opacity .2s;pointer-events:none;white-space:nowrap';
    document.body.appendChild(el);
  }
  el.textContent = msg;
  el.style.opacity = '1';
  clearTimeout(el.__t);
  el.__t = setTimeout(() => { el.style.opacity = '0'; }, 2200);
}

/* 分享的是工具本身，不是转录内容（转录稿不落服务器） */
const SHARE_URL = location.origin + '/';
const SHARE_TEXT = 'Free video or audio to text with timestamps. No signup.';
const SHARE_TARGETS = {
  x: `https://twitter.com/intent/tweet?text=${encodeURIComponent(SHARE_TEXT)}&url=${encodeURIComponent(SHARE_URL)}`,
  facebook: `https://www.facebook.com/sharer/sharer.php?u=${encodeURIComponent(SHARE_URL)}`,
  linkedin: `https://www.linkedin.com/sharing/share-offsite/?url=${encodeURIComponent(SHARE_URL)}`,
  reddit: `https://www.reddit.com/submit?url=${encodeURIComponent(SHARE_URL)}&title=${encodeURIComponent('Verbatimly — free video to text')}`,
};

function toggleShare(force) {
  const pop = $('#sharePop'), btn = $('#shareBtn');
  if (!pop) return;
  const show = force !== undefined ? force : pop.hidden;
  pop.hidden = !show;
  btn.setAttribute('aria-expanded', String(show));
}

// 下拉菜单里的平台链接：一次绑定，a 标签直接跳转
document.querySelectorAll('#sharePop [data-share]').forEach((el) => {
  const kind = el.dataset.share;
  if (kind !== 'copy' && SHARE_TARGETS[kind]) {
    el.href = SHARE_TARGETS[kind];
    el.target = '_blank';
    el.rel = 'noopener';
  }
  el.addEventListener('click', (e) => {
    if (kind === 'copy') {
      e.preventDefault();
      navigator.clipboard.writeText(SHARE_URL)
        .then(() => toast('Link copied.'))
        .catch(() => window.prompt('Copy this link:', SHARE_URL));
    }
    toggleShare(false);
  });
});

async function shareTool() {
  // 手机上用系统分享面板（能分享到微信/WhatsApp 等任意 App）
  if (navigator.share && /Mobi|Android|iPhone|iPad/i.test(navigator.userAgent)) {
    try { await navigator.share({ title: 'Verbatimly', text: SHARE_TEXT, url: SHARE_URL }); return; } catch (e) { return; }
  }
  toggleShare();
}

$('#shareBtn').addEventListener('click', (e) => { e.stopPropagation(); shareTool(); });
document.addEventListener('click', (e) => {
  const pop = $('#sharePop');
  if (pop && !pop.hidden && !pop.contains(e.target)) toggleShare(false);
});
// 页脚的 Share 在首页（结果视图隐藏），不弹菜单，直接系统分享或复制
$('#shareBtnFoot').addEventListener('click', async (e) => {
  e.preventDefault();
  if (navigator.share) {
    try { await navigator.share({ title: 'Verbatimly', text: SHARE_TEXT, url: SHARE_URL }); return; } catch (err) { return; }
  }
  try {
    await navigator.clipboard.writeText(SHARE_URL);
    toast('Link copied.');
  } catch (err) {
    window.prompt('Copy this link:', SHARE_URL);
  }
});
function download(name, mime, text) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([text], { type: mime }));
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}
$('#copyBtn').addEventListener('click', () => {
  navigator.clipboard.writeText(plainText());
  flash('Copied');
});
$('#txtBtn').addEventListener('click', () => download('transcript.txt', 'text/plain', plainText()));
$('#srtBtn').addEventListener('click', () => download('transcript.srt', 'text/plain', srtText()));
$('#vttBtn').addEventListener('click', () => download('transcript.vtt', 'text/vtt', vttText()));
function flash(msg) {
  const b = $('#copyBtn');
  const old = b.textContent;
  b.textContent = msg;
  setTimeout(() => { b.textContent = old; }, 1200);
}

/* ---------- 标题里的字幕条：悬停换一句真实转录 ---------- */
const SLOT_LINES = [
  ['00:14:23', 'and that’s when we decided to ship it'],
  ['00:02:07', 'the whole team was in the room that day'],
  ['00:41:55', 'so we deleted it and shipped on Friday'],
  ['00:08:12', 'nobody could remember who wrote the brief'],
];
let slotIdx = 0;
const heroSlot = $('#heroSlot');
// 字幕条内容由 JS 注入：爬虫不执行 JS，H1 纯文本保持 "Transcribe video to text"
if (heroSlot) {
  heroSlot.innerHTML = '<span class="tc" id="slotTc">00:14:23</span>' +
    '<span class="tx" id="slotTx">and that’s when we decided to ship it</span>' +
    '<span class="caret"></span>';
}
const slotTc = $('#slotTc'), slotTx = $('#slotTx');
// 只有首页有 #heroSlot；/audio-transcription 等内页没有，跳过即可
heroSlot?.addEventListener('mouseenter', () => {
  slotIdx = (slotIdx + 1) % SLOT_LINES.length;
  slotTx.classList.add('swap');
  setTimeout(() => {
    slotTc.textContent = SLOT_LINES[slotIdx][0];
    slotTx.textContent = SLOT_LINES[slotIdx][1];
    slotTx.classList.remove('swap');
  }, 180);
});

/* ---------- 杂项 ---------- */
function fmtMin(sec) {
  if (sec < 60) { const s = Math.max(1, Math.round(sec)); return `${s} second${s === 1 ? '' : 's'}`; }
  const m = Math.round(sec / 60);
  return `${m} minute${m === 1 ? '' : 's'}`;
}
function fmtClock(s) {
  s = Math.floor(s || 0);
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), ss = s % 60;
  const mm = String(m).padStart(2, '0'), sss = String(ss).padStart(2, '0');
  return h ? `${h}:${mm}:${sss}` : `${mm}:${sss}`;
}
function fmtStamp(s, sep) {
  s = Math.max(0, s || 0);
  const ms = Math.floor((s % 1) * 1000);
  const total = Math.floor(s);
  const hh = String(Math.floor(total / 3600)).padStart(2, '0');
  const mm = String(Math.floor((total % 3600) / 60)).padStart(2, '0');
  const ss = String(total % 60).padStart(2, '0');
  return `${hh}:${mm}:${ss}${sep}${String(ms).padStart(3, '0')}`;
}
