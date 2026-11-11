/* Video to MP3：浏览器内抽音轨 → lamejs 128kbps MP3 → 本地下载。全程不上传。 */
'use strict';

const MAX_MINUTES = 30.5;
const MAX_BYTES = 500 * 1024 * 1024;

const $ = (s) => document.querySelector(s);
const dz = $('#dropzone'), fileInput = $('#fileInput');
const progress = $('#progress'), progText = $('#progText'), progFill = $('#progFill');
const result = $('#result');
let busy = false;
let mp3Url = null;

/* 上传交互 */
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

/* 进度与错误 */
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
function resetUI() {
  progress.hidden = true;
  progFill.style.width = '0%';
  progFill.style.background = '';
  result.hidden = true;
  if (mp3Url) { URL.revokeObjectURL(mp3Url); mp3Url = null; }
  fileInput.value = '';
}

/* 主流程 */
async function handleFile(file) {
  if (busy) return;
  if (file.size > MAX_BYTES) return fail('File too large — the limit is 500 MB.');
  busy = true;
  result.hidden = true;
  try {
    setProgress(3, 'Reading file…');
    const buf = await decodeAudio(file);
    if (buf.duration > MAX_MINUTES * 60) {
      return fail(`This video is ${fmtMin(buf.duration)} long — the limit is 30 minutes. Trim it first.`);
    }
    setProgress(8, 'Encoding MP3 in your browser — this runs on your device, no upload.');
    const mp3 = await encodeMp3(buf, (p) => { progFill.style.width = (8 + p * 87).toFixed(1) + '%'; });

    if (mp3Url) URL.revokeObjectURL(mp3Url);
    mp3Url = URL.createObjectURL(mp3);
    const name = file.name.replace(/\.[^.]+$/, '') + '.mp3';
    $('#mp3Name').textContent = name;
    $('#mp3Meta').textContent = `${fmtMin(buf.duration)} · ${(mp3.size / 1048576).toFixed(1)} MB · 128 kbps`;
    const dl = $('#mp3Dl');
    dl.href = mp3Url;
    dl.download = name;
    setProgress(100, 'Done');
    result.hidden = false;
    result.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  } catch (err) {
    console.error(err);
    fail((err && (err.userMessage || err.message)) || 'Could not convert this file — try another one.');
  } finally {
    busy = false;
  }
}

/* 解码：失败给出可读原因 */
async function decodeAudio(file) {
  const bytes = await file.arrayBuffer();
  const ctx = new (window.AudioContext || window.webkitAudioContext)();
  try {
    return await ctx.decodeAudioData(bytes);
  } catch (e) {
    const err = new Error('decode failed');
    err.userMessage = 'Could not read an audio track from this file. MP4 and WebM work best; for MOV/MKV try exporting as MP4 first.';
    throw err;
  }
}

/* 编码：保留原采样率与声道，128 kbps */
async function encodeMp3(buf, onProgress) {
  const channels = Math.min(2, buf.numberOfChannels);
  const sr = buf.sampleRate;
  const enc = new lamejs.Mp3Encoder(channels, sr, 128);
  const left = buf.getChannelData(0);
  const right = channels > 1 ? buf.getChannelData(1) : null;
  const n = left.length;
  const block = 1152;
  const out = [];
  let i = 0;
  while (i < n) {
    const end = Math.min(i + block, n);
    const l = floatToInt16(left, i, end);
    const d = channels > 1 ? enc.encodeBuffer(l, floatToInt16(right, i, end)) : enc.encodeBuffer(l);
    if (d.length) out.push(new Int8Array(d));
    i = end;
    if (i % (block * 300) < block) {
      if (onProgress) onProgress(i / n);
      await new Promise((r) => setTimeout(r, 0));
    }
  }
  const tail = enc.flush();
  if (tail.length) out.push(new Int8Array(tail));
  if (onProgress) onProgress(1);
  return new Blob(out, { type: 'audio/mpeg' });
}

function floatToInt16(f32, start, end) {
  const out = new Int16Array(end - start);
  for (let i = start; i < end; i++) {
    let s = f32[i];
    s = s < -1 ? -1 : s > 1 ? 1 : s;
    out[i - start] = s < 0 ? s * 0x8000 : s * 0x7FFF;
  }
  return out;
}

/* 再转一个 */
$('#againLink').addEventListener('click', (e) => {
  e.preventDefault();
  resetUI();
  window.scrollTo({ top: 0, behavior: 'smooth' });
});

function fmtMin(sec) {
  if (sec < 60) { const s = Math.max(1, Math.round(sec)); return `${s} second${s === 1 ? '' : 's'}`; }
  const m = Math.round(sec / 60);
  return `${m} minute${m === 1 ? '' : 's'}`;
}
