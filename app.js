'use strict';

/* ------------------------------------------------------------------ *
 * EchoTake · 口语录音台
 * 本地优先：录音、take、回放、A/B、导出都在浏览器里完成。
 * 无后端、无账号、无上传。
 * ------------------------------------------------------------------ */

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

const DB_NAME = 'echotake';
const DB_VERSION = 1;
const MAX_SECONDS = 120;

const DEFAULT_PROMPTS = [
  'Let me walk you through the three things that actually moved the needle.',
  "The short version is: we tested it, it worked, and here's the number.",
  "What I'm trying to say is that the strategy only works if the team can execute it.",
];

const state = {
  prompts: [],
  activeId: null,
  deviceId: null,
  voiceURI: null,
  rate: 0.9,
  autoPlay: true,
  takes: new Map(), // promptId -> [takeMeta]
};

let db = null;
let stream = null;
let audioCtx = null;
let analyser = null;
let sampleBuf = null;
let mediaRecorder = null;
let chunks = [];
let recording = false;
let recStart = 0;
let timerInt = null;
let rafId = null;
let peakAt = 0;
let currentAudio = null;
let saveTimer = null;

const els = {
  status: $('#status'),
  statusDot: $('#statusDot'),
  statusText: $('#statusText'),
  deviceMeta: $('#deviceMeta'),
  promptList: $('#promptList'),
  stageIndex: $('#stageIndex'),
  promptText: $('#promptText'),
  recordBtn: $('#recordBtn'),
  timer: $('#timer'),
  wave: $('#wave'),
  meterFill: $('#meterFill'),
  dbText: $('#dbText'),
  takes: $('#takes'),
  takesEmpty: $('#takesEmpty'),
  takeCount: $('#takeCount'),
  abBtn: $('#abBtn'),
  speakBtn: $('#speakBtn'),
  rate: $('#rate'),
  rateVal: $('#rateVal'),
  deviceSelect: $('#deviceSelect'),
  deviceHint: $('#deviceHint'),
  refreshDevices: $('#refreshDevices'),
  voiceSelect: $('#voiceSelect'),
  autoPlay: $('#autoPlay'),
  infoRate: $('#infoRate'),
  infoChannels: $('#infoChannels'),
  infoEC: $('#infoEC'),
  infoAGC: $('#infoAGC'),
  drawer: $('#drawer'),
  drawerMask: $('#drawerMask'),
  settingsBtn: $('#settingsBtn'),
  closeDrawer: $('#closeDrawer'),
  clearBtn: $('#clearBtn'),
  exportBtn: $('#exportBtn'),
  addPrompt: $('#addPrompt'),
  toast: $('#toast'),
};

const uid = () => (crypto.randomUUID ? crypto.randomUUID() : 'id-' + Date.now() + '-' + Math.random().toString(16).slice(2));

/* ------------------------------- IndexedDB ------------------------------- */

function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const d = req.result;
      if (!d.objectStoreNames.contains('meta')) d.createObjectStore('meta');
      if (!d.objectStoreNames.contains('takes')) d.createObjectStore('takes', { keyPath: 'id' });
      if (!d.objectStoreNames.contains('blobs')) d.createObjectStore('blobs');
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

const idbGet = (store, key) => new Promise((resolve, reject) => {
  const r = db.transaction(store, 'readonly').objectStore(store).get(key);
  r.onsuccess = () => resolve(r.result);
  r.onerror = () => reject(r.error);
});

const idbGetAll = (store) => new Promise((resolve, reject) => {
  const r = db.transaction(store, 'readonly').objectStore(store).getAll();
  r.onsuccess = () => resolve(r.result);
  r.onerror = () => reject(r.error);
});

const idbPut = (store, value, key) => new Promise((resolve, reject) => {
  const r = key === undefined
    ? db.transaction(store, 'readwrite').objectStore(store).put(value)
    : db.transaction(store, 'readwrite').objectStore(store).put(value, key);
  r.onsuccess = () => resolve();
  r.onerror = () => reject(r.error);
});

const idbDelete = (store, key) => new Promise((resolve, reject) => {
  const r = db.transaction(store, 'readwrite').objectStore(store).delete(key);
  r.onsuccess = () => resolve();
  r.onerror = () => reject(r.error);
});

const idbClear = (store) => new Promise((resolve, reject) => {
  const r = db.transaction(store, 'readwrite').objectStore(store).clear();
  r.onsuccess = () => resolve();
  r.onerror = () => reject(r.error);
});

/* --------------------------------- utils -------------------------------- */

function toast(msg, ms = 2400) {
  els.toast.textContent = msg;
  els.toast.classList.add('show');
  clearTimeout(toast._t);
  toast._t = setTimeout(() => els.toast.classList.remove('show'), ms);
}

function fmt(sec) {
  const s = Math.max(0, sec || 0);
  const m = Math.floor(s / 60);
  const r = s - m * 60;
  return `${String(m).padStart(2, '0')}:${r.toFixed(1).padStart(4, '0')}`;
}

function fmtShort(sec) {
  return `${Math.max(1, Math.round(sec || 0))}s`;
}

function pad(n) {
  return String(n).padStart(2, '0');
}

const activePrompt = () => state.prompts.find((p) => p.id === state.activeId) || null;
const takesOf = (id) => state.takes.get(id) || [];

function latestTake() {
  const list = takesOf(state.activeId);
  return list.length ? list[list.length - 1] : null;
}

/* ------------------------------- persistence ----------------------------- */

function persist() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    idbPut('meta', {
      prompts: state.prompts,
      activeId: state.activeId,
      deviceId: state.deviceId,
      voiceURI: state.voiceURI,
      rate: state.rate,
      autoPlay: state.autoPlay,
    }, 'state').catch(() => {});
  }, 220);
}

async function loadState() {
  db = await openDB();
  const meta = await idbGet('meta', 'state');

  if (meta && Array.isArray(meta.prompts) && meta.prompts.length) {
    state.prompts = meta.prompts.map((p) => ({ id: p.id || uid(), text: p.text || '' }));
    state.activeId = meta.activeId && state.prompts.some((p) => p.id === meta.activeId) ? meta.activeId : state.prompts[0].id;
    state.deviceId = meta.deviceId || null;
    state.voiceURI = meta.voiceURI || null;
    state.rate = typeof meta.rate === 'number' ? meta.rate : 0.9;
    state.autoPlay = meta.autoPlay !== false;
  } else {
    state.prompts = DEFAULT_PROMPTS.map((text) => ({ id: uid(), text }));
    state.activeId = state.prompts[0].id;
  }

  const takes = await idbGetAll('takes');
  state.takes = new Map();
  for (const t of takes.sort((a, b) => a.createdAt - b.createdAt)) {
    if (!state.takes.has(t.promptId)) state.takes.set(t.promptId, []);
    state.takes.get(t.promptId).push(t);
  }
}

/* --------------------------------- render -------------------------------- */

function renderAll() {
  renderQueue();
  renderStage();
  renderTakes();
}

function renderQueue() {
  els.promptList.innerHTML = '';
  state.prompts.forEach((p, i) => {
    const takes = takesOf(p.id);
    const item = document.createElement('div');
    item.className = 'prompt-item' + (p.id === state.activeId ? ' active' : '');
    item.dataset.id = p.id;
    item.innerHTML = `
      <span class="prompt-num">${pad(i + 1)}</span>
      <div class="prompt-body">
        <div class="prompt-text"></div>
        <div class="prompt-sub">${takes.length ? takes.length + ' take' : '未录'}</div>
      </div>
      <button class="icon-btn prompt-del" title="删除这句" aria-label="删除这句">×</button>
    `;
    item.querySelector('.prompt-text').textContent = p.text || '（空白句子）';
    item.addEventListener('click', () => selectPrompt(p.id));
    item.querySelector('.prompt-del').addEventListener('click', (e) => {
      e.stopPropagation();
      deletePrompt(p.id);
    });
    els.promptList.append(item);
  });
}

function renderStage() {
  const p = activePrompt();
  const idx = state.prompts.findIndex((x) => x.id === state.activeId);
  els.stageIndex.textContent = `第 ${idx + 1} / ${state.prompts.length} 句`;
  els.promptText.value = p ? p.text : '';
  els.promptText.style.height = 'auto';
  els.promptText.style.height = Math.max(96, els.promptText.scrollHeight) + 'px';
  els.abBtn.disabled = !latestTake();
}

function renderTakes() {
  const list = takesOf(state.activeId);
  els.takeCount.textContent = String(list.length);
  els.takes.querySelectorAll('.take').forEach((n) => n.remove());
  els.takesEmpty.style.display = list.length ? 'none' : 'block';
  els.abBtn.disabled = !list.length;

  list.forEach((t, i) => {
    const row = document.createElement('div');
    row.className = 'take' + (i === list.length - 1 ? ' latest' : '');
    row.innerHTML = `
      <button class="take-play" title="回放">▶</button>
      <div class="take-main">
        <span class="take-name">Take ${i + 1}</span>
        <span class="take-time">${fmt(t.duration)}</span>
        ${i === list.length - 1 ? '<span class="take-badge">最新</span>' : ''}
      </div>
      <div class="take-actions">
        <button class="mini-btn ab" title="先示范，再回放这条">A/B</button>
        <button class="mini-btn del" title="删除">删</button>
      </div>
    `;
    const playBtn = row.querySelector('.take-play');
    playBtn.addEventListener('click', () => playTake(t, playBtn));
    row.querySelector('.ab').addEventListener('click', () => abWith(t));
    row.querySelector('.del').addEventListener('click', () => deleteTake(t));
    els.takes.append(row);
  });
}

/* -------------------------------- prompts -------------------------------- */

function selectPrompt(id) {
  if (recording) stopRecording();
  state.activeId = id;
  persist();
  renderAll();
}

function addPrompt(text = '') {
  const p = { id: uid(), text };
  state.prompts.push(p);
  state.activeId = p.id;
  persist();
  renderAll();
  els.promptText.focus();
}

function deletePrompt(id) {
  if (state.prompts.length <= 1) {
    toast('至少保留一句');
    return;
  }
  if (!confirm('删除这句和它的全部 take？')) return;
  state.prompts = state.prompts.filter((p) => p.id !== id);
  const list = state.takes.get(id) || [];
  list.forEach((t) => {
    idbDelete('takes', t.id).catch(() => {});
    idbDelete('blobs', t.id).catch(() => {});
  });
  state.takes.delete(id);
  if (state.activeId === id) state.activeId = state.prompts[0].id;
  persist();
  renderAll();
}

function nextPrompt(dir) {
  const i = state.prompts.findIndex((p) => p.id === state.activeId);
  const n = Math.min(state.prompts.length - 1, Math.max(0, i + dir));
  if (n !== i) selectPrompt(state.prompts[n].id);
}

/* -------------------------------- recording ------------------------------ */

function pickMime() {
  const options = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4'];
  return options.find((m) => window.MediaRecorder && MediaRecorder.isTypeSupported(m)) || '';
}

function updateDeviceInfo(settings) {
  if (!settings) return;
  els.infoRate.textContent = settings.sampleRate ? `${settings.sampleRate} Hz` : (audioCtx ? audioCtx.sampleRate + ' Hz' : '—');
  els.infoChannels.textContent = settings.channelCount ? `${settings.channelCount} ch` : '—';
  els.infoEC.textContent = settings.echoCancellation ? '开' : '关';
  els.infoAGC.textContent = settings.autoGainControl ? '开' : '关';
  els.deviceMeta.textContent = `${settings.sampleRate || audioCtx?.sampleRate || '—'} Hz · ${settings.channelCount || 1}ch`;
}

async function ensureMic() {
  if (stream && stream.active) return true;

  const audio = {
    echoCancellation: false,
    noiseSuppression: false,
    autoGainControl: false,
    channelCount: 1,
  };
  if (state.deviceId) audio.deviceId = { exact: state.deviceId };

  stream = await navigator.mediaDevices.getUserMedia({ audio, video: false });
  const track = stream.getAudioTracks()[0];
  const settings = track.getSettings ? track.getSettings() : {};

  try {
    audioCtx = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: 48000 });
  } catch {
    audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  }
  if (audioCtx.state === 'suspended') await audioCtx.resume();

  const source = audioCtx.createMediaStreamSource(stream);
  analyser = audioCtx.createAnalyser();
  analyser.fftSize = 2048;
  analyser.smoothingTimeConstant = 0.55;
  source.connect(analyser);
  sampleBuf = new Float32Array(analyser.fftSize);

  updateDeviceInfo(settings);
  setStatus('live', '麦克风就绪', `${track.label || '输入设备'}`);

  await refreshDeviceList();
  startDrawLoop();
  return true;
}

function setStatus(kind, text, meta) {
  els.statusDot.className = 'status-dot' + (kind ? ' ' + kind : '');
  els.statusText.textContent = text;
  if (meta !== undefined) els.deviceMeta.textContent = meta;
}

async function toggleRecord() {
  if (recording) return stopRecording();
  if (!window.MediaRecorder) {
    toast('这个浏览器不支持 MediaRecorder，请用 Chrome');
    return;
  }
  if (!activePrompt()) addPrompt();

  try {
    await ensureMic();
  } catch (err) {
    setStatus('', '麦克风未授权', '');
    toast('无法访问麦克风：' + (err.message || err.name));
    return;
  }

  const mime = pickMime();
  try {
    mediaRecorder = mime
      ? new MediaRecorder(stream, { mimeType: mime, audioBitsPerSecond: 128000 })
      : new MediaRecorder(stream);
  } catch (err) {
    toast('录音器初始化失败：' + err.message);
    return;
  }

  const rec = mediaRecorder;
  chunks = [];
  rec.ondataavailable = (e) => { if (e.data && e.data.size) chunks.push(e.data); };
  rec.onstop = () => finishRecording(rec);

  rec.start(200);
  recording = true;
  recStart = performance.now();
  els.recordBtn.classList.add('recording');
  els.recordBtn.setAttribute('aria-label', '停止录音');
  els.timer.classList.add('live');
  setStatus('rec', '录音中…', els.deviceMeta.textContent);
  timerInt = setInterval(() => {
    const sec = (performance.now() - recStart) / 1000;
    els.timer.textContent = fmt(sec);
    if (sec >= MAX_SECONDS) stopRecording();
  }, 100);
  els.timer.textContent = '00:00.0';
}

function stopRecording() {
  if (!recording || !mediaRecorder) return;
  recording = false;
  clearInterval(timerInt);
  els.recordBtn.classList.remove('recording');
  els.recordBtn.setAttribute('aria-label', '开始录音');
  els.timer.classList.remove('live');
  try { mediaRecorder.stop(); } catch { /* noop */ }
}

async function finishRecording(rec) {
  const duration = (performance.now() - recStart) / 1000;
  const type = rec.mimeType || 'audio/webm';
  const blob = new Blob(chunks, { type });
  chunks = [];

  if (!blob.size) {
    setStatus('live', '麦克风就绪', '');
    toast('这次没有录到声音，检查一下输入设备');
    return;
  }

  const take = {
    id: uid(),
    promptId: state.activeId,
    duration,
    createdAt: Date.now(),
    mime: type,
    size: blob.size,
  };

  try {
    await idbPut('blobs', blob, take.id);
    await idbPut('takes', take);
  } catch (err) {
    toast('保存录音失败：' + err.message);
    return;
  }

  if (!state.takes.has(take.promptId)) state.takes.set(take.promptId, []);
  state.takes.get(take.promptId).push(take);
  persist();
  els.timer.textContent = fmt(duration);
  setStatus('live', '麦克风就绪', els.deviceMeta.textContent);
  renderQueue();
  renderTakes();

  if (state.autoPlay) {
    const playBtn = els.takes.querySelector('.take:last-child .take-play');
    setTimeout(() => playTake(take, playBtn), 220);
  }
}

/* --------------------------------- audio -------------------------------- */

function stopAudio() {
  if (currentAudio) {
    try { currentAudio.pause(); } catch { /* noop */ }
    currentAudio = null;
  }
  if ('speechSynthesis' in window) speechSynthesis.cancel();
  $$('.take-play.playing').forEach((b) => b.classList.remove('playing'));
}

async function playTake(take, btn) {
  stopAudio();
  const blob = await idbGet('blobs', take.id);
  if (!blob) {
    toast('这条录音的数据找不到了');
    return;
  }
  const url = URL.createObjectURL(blob);
  const audio = new Audio(url);
  currentAudio = audio;
  if (btn) btn.classList.add('playing');
  const cleanup = () => {
    URL.revokeObjectURL(url);
    if (btn) btn.classList.remove('playing');
    if (currentAudio === audio) currentAudio = null;
  };
  audio.onended = cleanup;
  audio.onerror = cleanup;
  try {
    await audio.play();
  } catch (err) {
    cleanup();
    toast('播放失败：' + err.message);
  }
}

function pickVoice() {
  if (!('speechSynthesis' in window)) return null;
  const voices = speechSynthesis.getVoices();
  if (!voices.length) return null;
  if (state.voiceURI) {
    const found = voices.find((v) => v.voiceURI === state.voiceURI);
    if (found) return found;
  }
  const en = voices.filter((v) => /^en(-|_|$)/i.test(v.lang || ''));
  const preferred = en.find((v) => /Samantha|Google US English|Aria|Jenny|Daniel/i.test(v.name));
  return preferred || en[0] || voices[0];
}

function speak(text, { rate = state.rate, onend } = {}) {
  if (!('speechSynthesis' in window)) {
    toast('这个浏览器不支持示范朗读');
    onend && onend();
    return Promise.resolve();
  }
  speechSynthesis.cancel();
  const u = new SpeechSynthesisUtterance(text);
  u.lang = 'en-US';
  u.rate = rate;
  u.pitch = 1;
  const voice = pickVoice();
  if (voice) u.voice = voice;

  return new Promise((resolve) => {
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      clearTimeout(guard);
      resolve();
      onend && onend();
    };
    const guard = setTimeout(finish, Math.max(8000, text.length * 130));
    u.onend = finish;
    u.onerror = finish;
    try {
      speechSynthesis.speak(u);
    } catch (err) {
      finish();
    }
  });
}

async function speakCurrent() {
  const p = activePrompt();
  if (!p || !p.text.trim()) {
    toast('先写一句要练的话');
    return;
  }
  stopAudio();
  await speak(p.text, { rate: state.rate });
}

async function abWith(take) {
  const p = activePrompt();
  if (!p || !p.text.trim()) {
    toast('先写一句要练的话');
    return;
  }
  stopAudio();
  toast('先听示范，再听你的', 1600);
  await speak(p.text, { rate: state.rate });
  setTimeout(() => {
    const btn = els.takes.querySelector('.take.latest .take-play');
    playTake(take, btn);
  }, 320);
}

/* -------------------------------- drawing -------------------------------- */

function fitCanvas() {
  const canvas = els.wave;
  const dpr = window.devicePixelRatio || 1;
  const rect = canvas.getBoundingClientRect();
  if (!rect.width) return;
  canvas.width = Math.round(rect.width * dpr);
  canvas.height = Math.round(rect.height * dpr);
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
}

function drawIdle() {
  const canvas = els.wave;
  const ctx = canvas.getContext('2d');
  const dpr = window.devicePixelRatio || 1;
  const w = canvas.width / dpr;
  const h = canvas.height / dpr;
  ctx.clearRect(0, 0, w, h);
  ctx.strokeStyle = '#232830';
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(0, h / 2);
  ctx.lineTo(w, h / 2);
  ctx.stroke();
  ctx.fillStyle = '#3c434d';
  ctx.font = '11px ui-monospace, SF Mono, monospace';
  ctx.textAlign = 'center';
  ctx.fillText('按空格开始录音', w / 2, h / 2 - 12);
}

function startDrawLoop() {
  if (rafId) cancelAnimationFrame(rafId);
  fitCanvas();
  let last = 0;
  const loop = (t) => {
    rafId = requestAnimationFrame(loop);
    if (!analyser) return;
    if (t - last < 30) return; // ~33fps 足够
    last = t;

    analyser.getFloatTimeDomainData(sampleBuf);
    const canvas = els.wave;
    const ctx = canvas.getContext('2d');
    const dpr = window.devicePixelRatio || 1;
    const w = canvas.width / dpr;
    const h = canvas.height / dpr;
    ctx.clearRect(0, 0, w, h);

    ctx.strokeStyle = '#232830';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(0, h / 2);
    ctx.lineTo(w, h / 2);
    ctx.stroke();

    ctx.strokeStyle = recording ? '#ffb454' : '#4b535e';
    ctx.lineWidth = 1.3;
    ctx.beginPath();
    const step = Math.max(1, Math.floor(sampleBuf.length / w));
    for (let x = 0; x < w; x++) {
      let min = 1;
      let max = -1;
      for (let i = 0; i < step; i++) {
        const v = sampleBuf[x * step + i] || 0;
        if (v < min) min = v;
        if (v > max) max = v;
      }
      ctx.moveTo(x, (1 - min) * h / 2);
      ctx.lineTo(x, (1 - max) * h / 2);
    }
    ctx.stroke();

    let sum = 0;
    let peak = 0;
    for (let i = 0; i < sampleBuf.length; i++) {
      const v = sampleBuf[i];
      sum += v * v;
      if (Math.abs(v) > peak) peak = Math.abs(v);
    }
    const rms = Math.sqrt(sum / sampleBuf.length);
    const db = 20 * Math.log10(rms + 1e-9);
    const pct = Math.max(0, Math.min(1, (db + 60) / 60));
    els.meterFill.style.width = (pct * 100).toFixed(1) + '%';

    if (peak > 0.984) peakAt = performance.now();
    const clipping = peakAt && performance.now() - peakAt < 650;
    els.dbText.textContent = clipping ? 'PEAK' : (db < -58 ? '-∞ dB' : db.toFixed(1) + ' dB');
    els.dbText.classList.toggle('clip', !!clipping);
  };
  rafId = requestAnimationFrame(loop);
}

/* -------------------------------- devices -------------------------------- */

async function refreshDeviceList() {
  if (!navigator.mediaDevices?.enumerateDevices) return;
  let devices = [];
  try {
    devices = await navigator.mediaDevices.enumerateDevices();
  } catch {
    return;
  }
  const inputs = devices.filter((d) => d.kind === 'audioinput');
  const sel = els.deviceSelect;
  sel.innerHTML = '';

  if (!inputs.length) {
    const o = document.createElement('option');
    o.textContent = '没有检测到输入设备';
    o.value = '';
    sel.append(o);
    els.deviceHint.textContent = '检查 USB-C 连接，或在系统设置 → 声音 → 输入里确认。';
    return;
  }

  inputs.forEach((d, i) => {
    const o = document.createElement('option');
    o.value = d.deviceId;
    o.textContent = d.label || `输入设备 ${i + 1}（授权后显示名称）`;
    sel.append(o);
  });

  const hasSaved = state.deviceId && inputs.some((d) => d.deviceId === state.deviceId);
  if (hasSaved) {
    sel.value = state.deviceId;
  } else {
    const pd = inputs.find((d) => /PD200X|PD-200X|Maono|闪克/i.test(d.label || ''));
    if (pd) {
      state.deviceId = pd.deviceId;
      sel.value = pd.deviceId;
      persist();
      els.deviceHint.textContent = '已匹配 PD200X。'
      toast('已自动匹配 PD200X');
    } else {
      state.deviceId = null;
      sel.value = inputs[0].deviceId;
      els.deviceHint.textContent = inputs[0].label
        ? `当前没有 PD200X，先用「${inputs[0].label}」。`
        : '先在页面里按一次录音授权，再选设备。';
    }
  }
  updateDeviceHint();
}

function updateDeviceHint() {
  const label = els.deviceSelect.selectedOptions[0]?.textContent || '';
  if (/PD200X|PD-200X|Maono|闪克/i.test(label)) {
    els.deviceHint.textContent = 'PD200X 已选中。建议增益 50% 左右，离嘴 5–10 cm。';
  }
}

async function switchDevice(deviceId) {
  state.deviceId = deviceId || null;
  persist();
  if (recording) stopRecording();
  stopAudio();
  if (stream) {
    stream.getTracks().forEach((t) => t.stop());
    stream = null;
  }
  if (audioCtx) {
    try { await audioCtx.close(); } catch { /* noop */ }
    audioCtx = null;
  }
  analyser = null;
  setStatus('', '设备已切换', '下次录音生效');
  drawIdle();
  toast('输入设备已切换');
}

/* --------------------------------- voices -------------------------------- */

function loadVoices() {
  if (!('speechSynthesis' in window)) return;
  const voices = speechSynthesis.getVoices();
  const en = voices.filter((v) => /^en(-|_|$)/i.test(v.lang || ''));
  const list = en.length ? en : voices;
  els.voiceSelect.innerHTML = '';
  if (!list.length) {
    const o = document.createElement('option');
    o.textContent = '系统暂无可用音色';
    els.voiceSelect.append(o);
    return;
  }
  list.forEach((v) => {
    const o = document.createElement('option');
    o.value = v.voiceURI;
    o.textContent = `${v.name} · ${v.lang}`;
    els.voiceSelect.append(o);
  });
  const current = pickVoice();
  if (current) els.voiceSelect.value = current.voiceURI;
}

/* --------------------------------- export -------------------------------- */

function buildMarkdown(ymd, hm) {
  const now = new Date();
  const lines = [];
  lines.push('---');
  lines.push(`title: 口语练习 ${ymd} ${hm}`);
  lines.push(`date: ${ymd}`);
  lines.push('type: 口语练习');
  lines.push('tags:');
  lines.push('  - 口语练习');
  lines.push('  - english-speaking-loop');
  lines.push(`device: ${els.deviceSelect.selectedOptions[0]?.textContent || '未知设备'}`);
  lines.push('---');
  lines.push('');
  lines.push(`# 口语练习 · ${ymd} ${hm}`);
  lines.push('');
  const total = state.prompts.reduce((n, p) => n + takesOf(p.id).length, 0);
  lines.push(`**设备：** ${els.deviceSelect.selectedOptions[0]?.textContent || '未知设备'}　**句数：** ${state.prompts.length}　**take 数：** ${total}`);
  lines.push('');
  lines.push('> 练习方法：先听示范 → 录一遍 → A/B 对比 → 只改一个点 → 重录。');
  lines.push('');

  state.prompts.forEach((p, pi) => {
    const takes = takesOf(p.id);
    lines.push(`## ${pad(pi + 1)} · ${p.text || '（空白句子）'}`);
    lines.push('');
    if (!takes.length) {
      lines.push('- （未录）');
    } else {
      takes.forEach((t, ti) => {
        const ext = t.mime.includes('mp4') ? 'm4a' : 'webm';
        const file = `audio/s${pad(pi + 1)}-t${pad(ti + 1)}.${ext}`;
        lines.push(`- Take ${ti + 1} · ${fmt(t.duration)} · ![[${file}]]`);
      });
    }
    lines.push('');
  });

  lines.push('## 回听记录');
  lines.push('');
  lines.push('- [ ] 全部回听一遍');
  lines.push('- 最满意的一句：');
  lines.push('- 下次要先改：');
  lines.push('');
  lines.push(`> 由 EchoTake 导出 · ${now.toLocaleString('zh-CN')}`);
  lines.push('');
  return lines.join('\n');
}

function downloadBlob(blob, name) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}

async function exportSession() {
  const now = new Date();
  const ymd = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
  const hm = `${pad(now.getHours())}${pad(now.getMinutes())}`;
  const total = state.prompts.reduce((n, p) => n + takesOf(p.id).length, 0);
  if (!total) {
    toast('还没有 take 可以导出');
    return;
  }

  const md = buildMarkdown(ymd, hm);
  const mdBlob = new Blob([md], { type: 'text/markdown;charset=utf-8' });

  const files = [];
  for (let pi = 0; pi < state.prompts.length; pi++) {
    const p = state.prompts[pi];
    const takes = takesOf(p.id);
    for (let ti = 0; ti < takes.length; ti++) {
      const t = takes[ti];
      const blob = await idbGet('blobs', t.id);
      if (!blob) continue;
      const ext = t.mime.includes('mp4') ? 'm4a' : 'webm';
      files.push({ name: `s${pad(pi + 1)}-t${pad(ti + 1)}.${ext}`, blob });
    }
  }

  const folderName = `口语练习-${ymd}-${hm}`;

  if (window.showDirectoryPicker) {
    let root;
    try {
      root = await window.showDirectoryPicker({ mode: 'readwrite', id: 'echotake-export' });
    } catch (err) {
      if (err.name === 'AbortError') return;
      toast('无法写入文件夹：' + err.message + '，改为下载');
    }
    if (root) {
      try {
        const dir = await root.getDirectoryHandle(folderName, { create: true });
        const audioDir = await dir.getDirectoryHandle('audio', { create: true });

        for (const f of files) {
          const fh = await audioDir.getFileHandle(f.name, { create: true });
          const w = await fh.createWritable();
          await w.write(f.blob);
          await w.close();
        }

        const mfh = await dir.getFileHandle('练习记录.md', { create: true });
        const mw = await mfh.createWritable();
        await mw.write(mdBlob);
        await mw.close();

        toast(`已导出到「${folderName}」`, 3200);
        return;
      } catch (err) {
        toast('写入失败：' + err.message + '，改为下载');
      }
    }
  }

  // 回退：逐个下载
  downloadBlob(mdBlob, `口语练习-${ymd}-${hm}.md`);
  files.forEach((f, i) => setTimeout(() => downloadBlob(f.blob, f.name), 350 * (i + 1)));
  toast('已开始下载；Chrome 若拦截多文件，请允许本站下载', 3600);
}

/* --------------------------------- events -------------------------------- */

function bindEvents() {
  els.recordBtn.addEventListener('click', toggleRecord);
  els.speakBtn.addEventListener('click', speakCurrent);
  els.abBtn.addEventListener('click', () => {
    const t = latestTake();
    if (t) abWith(t);
  });
  els.rate.addEventListener('input', () => {
    state.rate = Number(els.rate.value);
    els.rateVal.textContent = state.rate.toFixed(2) + '×';
    persist();
  });

  els.promptText.addEventListener('input', () => {
    const p = activePrompt();
    if (!p) return;
    p.text = els.promptText.value;
    els.promptText.style.height = 'auto';
    els.promptText.style.height = Math.max(96, els.promptText.scrollHeight) + 'px';
    const item = els.promptList.querySelector(`.prompt-item[data-id="${p.id}"] .prompt-text`);
    if (item) item.textContent = p.text || '（空白句子）';
    persist();
  });

  els.promptText.addEventListener('keydown', (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
      e.preventDefault();
      toggleRecord();
    }
  });

  els.addPrompt.addEventListener('click', () => addPrompt());

  els.settingsBtn.addEventListener('click', openDrawer);
  els.closeDrawer.addEventListener('click', closeDrawer);
  els.drawerMask.addEventListener('click', closeDrawer);
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !els.drawer.classList.contains('hidden')) closeDrawer();
  });

  els.deviceSelect.addEventListener('change', () => {
    const id = els.deviceSelect.value;
    if (id && id !== state.deviceId) switchDevice(id);
  });
  els.refreshDevices.addEventListener('click', async () => {
    await refreshDeviceList();
    toast('设备列表已刷新');
  });
  els.voiceSelect.addEventListener('change', () => {
    state.voiceURI = els.voiceSelect.value;
    persist();
    toast('示范音色已切换');
  });
  els.autoPlay.addEventListener('change', () => {
    state.autoPlay = els.autoPlay.checked;
    persist();
  });
  els.exportBtn.addEventListener('click', exportSession);

  els.clearBtn.addEventListener('click', async () => {
    if (!confirm('清空全部 take？句子会保留。')) return;
    await idbClear('takes');
    await idbClear('blobs');
    state.takes = new Map();
    renderQueue();
    renderTakes();
    toast('已清空全部录音');
  });

  document.addEventListener('keydown', (e) => {
    const tag = (e.target.tagName || '').toLowerCase();
    if (tag === 'textarea' || tag === 'input' || tag === 'select' || e.target.isContentEditable) return;
    if (e.code === 'Space') {
      e.preventDefault();
      toggleRecord();
    } else if (e.key === 'r' || e.key === 'R') {
      e.preventDefault();
      speakCurrent();
    } else if (e.key === 'p' || e.key === 'P') {
      e.preventDefault();
      const t = latestTake();
      if (t) {
        const btn = els.takes.querySelector('.take.latest .take-play');
        playTake(t, btn);
      }
    } else if (e.key === 'ArrowRight') {
      e.preventDefault();
      nextPrompt(1);
    } else if (e.key === 'ArrowLeft') {
      e.preventDefault();
      nextPrompt(-1);
    }
  });

  window.addEventListener('resize', () => {
    fitCanvas();
    if (!analyser) drawIdle();
  });
  new ResizeObserver(() => {
    fitCanvas();
    if (!analyser) drawIdle();
  }).observe(els.wave);
}

function openDrawer() {
  els.drawer.classList.remove('hidden');
  els.drawerMask.classList.remove('hidden');
  refreshDeviceList().catch(() => {});
}

function closeDrawer() {
  els.drawer.classList.add('hidden');
  els.drawerMask.classList.add('hidden');
}

/* ---------------------------------- boot --------------------------------- */

async function boot() {
  bindEvents();

  els.rate.value = String(state.rate);
  els.rateVal.textContent = state.rate.toFixed(2) + '×';

  try {
    await loadState();
  } catch (err) {
    console.error(err);
    state.prompts = DEFAULT_PROMPTS.map((text) => ({ id: uid(), text }));
    state.activeId = state.prompts[0].id;
    toast('本地存储不可用，本次练习不会自动保存');
  }

  els.rate.value = String(state.rate);
  els.rateVal.textContent = state.rate.toFixed(2) + '×';
  els.autoPlay.checked = state.autoPlay;
  renderAll();
  persist(); // 首次启动就把默认句子写入，避免刷新后句子 id 变化导致 take 失联
  drawIdle();
  loadVoices();
  if ('speechSynthesis' in window) speechSynthesis.onvoiceschanged = loadVoices;

  refreshDeviceList().catch(() => {});

  if (!window.isSecureContext) {
    toast('请通过 localhost 打开，浏览器才允许使用麦克风', 5000);
  }
  if (!/Chrome|Edg/i.test(navigator.userAgent)) {
    toast('建议使用 Chrome：Safari 的录音与导出兼容性较差', 4200);
  }
}

boot();
