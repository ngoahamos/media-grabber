'use strict';

/**
 * Renderer — all UI state and DOM work.
 *
 * This file has no Node access at all; every privileged call goes through
 * `window.api`, which the preload script exposes over IPC.
 */

/* -------------------------------------------------------------------------- */
/* Element lookup                                                             */
/* -------------------------------------------------------------------------- */

const $ = (id) => document.getElementById(id);

const el = {
  url: $('url'),
  pasteBtn: $('pasteBtn'),
  analyzeBtn: $('analyzeBtn'),
  analyzeLabel: document.querySelector('#analyzeBtn .btn-label'),
  analyzeSpinner: document.querySelector('#analyzeBtn .spinner'),

  preview: $('preview'),
  pvThumb: $('pvThumb'),
  pvTitle: $('pvTitle'),
  pvUploader: $('pvUploader'),
  pvSource: $('pvSource'),
  pvBest: $('pvBest'),
  pvDuration: $('pvDuration'),

  segButtons: document.querySelectorAll('.seg'),
  qualityOption: $('qualityOption'),
  quality: $('quality'),
  folderPath: $('folderPath'),
  chooseFolderBtn: $('chooseFolderBtn'),
  openFolderBtn: $('openFolderBtn'),
  useCookies: $('useCookies'),
  cookieBrowser: $('cookieBrowser'),

  downloadBtn: $('downloadBtn'),
  cancelBtn: $('cancelBtn'),

  progressCard: $('progressCard'),
  progressPhase: $('progressPhase'),
  progressPct: $('progressPct'),
  progressBar: $('progressBar'),
  progressSize: $('progressSize'),
  progressSpeed: $('progressSpeed'),
  progressEta: $('progressEta'),
  logBox: $('logBox'),

  historyList: $('historyList'),
  historyEmpty: $('historyEmpty'),
  clearHistoryBtn: $('clearHistoryBtn'),

  binStatus: $('binStatus'),
  binStatusText: $('binStatusText'),
  toasts: $('toasts'),
};

/* -------------------------------------------------------------------------- */
/* App state                                                                  */
/* -------------------------------------------------------------------------- */

const state = {
  settings: null,
  /** Metadata from the last successful analyze, or null. */
  meta: null,
  /** URL that `meta` describes — guards against stale previews. */
  analyzedUrl: null,
  /** Active download job id, or null when idle. */
  jobId: null,
  analyzing: false,
  toolsReady: false,
};

/* -------------------------------------------------------------------------- */
/* Formatting helpers                                                         */
/* -------------------------------------------------------------------------- */

/** 1536000 → "1.5 MB" */
function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) return '—';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  const value = bytes / 1024 ** i;
  return `${value.toFixed(value >= 100 || i === 0 ? 0 : 1)} ${units[i]}`;
}

/** 3661 → "1:01:01" */
function formatDuration(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) return '';
  const s = Math.round(seconds);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const pad = (n) => String(n).padStart(2, '0');
  return h > 0 ? `${h}:${pad(m)}:${pad(sec)}` : `${m}:${pad(sec)}`;
}

/** Seconds remaining → "2m 05s left" */
function formatEta(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) return '—';
  return `${formatDuration(seconds)} left`;
}

function formatSpeed(bytesPerSecond) {
  if (!Number.isFinite(bytesPerSecond) || bytesPerSecond <= 0) return '—';
  return `${formatBytes(bytesPerSecond)}/s`;
}

function formatDate(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleString(undefined, {
    month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit',
  });
}

/* -------------------------------------------------------------------------- */
/* Toasts                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * @param {'info'|'success'|'error'|'warn'} type
 * @param {string} title
 * @param {string} [message]
 * @param {number} [timeout] ms; 0 keeps the toast until dismissed
 */
function toast(type, title, message = '', timeout = type === 'error' ? 9000 : 4000) {
  const node = document.createElement('div');
  node.className = `toast toast--${type}`;

  const body = document.createElement('div');
  body.className = 'toast-body';

  const heading = document.createElement('div');
  heading.className = 'toast-title';
  heading.textContent = title;          // textContent: never trust remote strings
  body.appendChild(heading);

  if (message) {
    const msg = document.createElement('div');
    msg.className = 'toast-msg';
    msg.textContent = message;
    body.appendChild(msg);
  }

  const close = document.createElement('button');
  close.className = 'toast-close';
  close.type = 'button';
  close.setAttribute('aria-label', 'Dismiss');
  close.textContent = '×';

  const dismiss = () => {
    node.classList.add('is-leaving');
    node.addEventListener('animationend', () => node.remove(), { once: true });
  };
  close.addEventListener('click', dismiss);

  node.append(body, close);
  el.toasts.appendChild(node);
  if (timeout > 0) setTimeout(dismiss, timeout);
}

/* -------------------------------------------------------------------------- */
/* Settings & tool status                                                     */
/* -------------------------------------------------------------------------- */

async function loadSettings() {
  state.settings = await window.api.getSettings();
  const s = state.settings;

  setFormat(s.format, { persist: false });
  el.quality.value = s.quality;
  el.useCookies.checked = Boolean(s.useCookies);
  el.cookieBrowser.value = s.cookieBrowser;
  el.cookieBrowser.disabled = !s.useCookies;
  setFolder(s.downloadDir);
}

function setFolder(dir) {
  state.settings.downloadDir = dir;
  // The path is rendered RTL so the folder name stays visible when truncated;
  // the LTR mark keeps a leading "/" or "C:" from jumping to the wrong end.
  el.folderPath.textContent = `‪${dir}‬`;
  el.folderPath.title = dir;
}

/** Persist a settings patch without blocking the UI on the round-trip. */
function saveSettings(patch) {
  Object.assign(state.settings, patch);
  window.api.setSettings(patch).catch(() => {/* non-critical */});
}

/**
 * Check that yt-dlp and ffmpeg are present and reflect it in the header pill.
 *
 * Presence is decided by the main process without executing anything, so the
 * window is usable immediately. The version strings are fetched afterwards and
 * folded in when they arrive — a slow-starting binary is still a working one.
 */
async function refreshToolStatus() {
  try {
    const status = await window.api.binariesStatus();
    const missing = [];
    if (!status.ytDlp.ok) missing.push('yt-dlp');
    if (!status.ffmpeg.ok) missing.push('ffmpeg');

    state.toolsReady = missing.length === 0;

    if (!state.toolsReady) {
      el.binStatus.className = 'status-pill status-pill--error';
      el.binStatusText.textContent = `Missing: ${missing.join(' + ')}`;
      el.binStatus.title = `Expected in: ${status.binDir}\nRun "npm run setup:binaries".`;
      toast(
        'error',
        `${missing.join(' and ')} not found`,
        `Run "npm run setup:binaries", or place the binaries in ${status.binDir}.`,
        0
      );
      updateDownloadButton();
      return;
    }

    el.binStatus.className = 'status-pill status-pill--ok';
    el.binStatusText.textContent = 'Tools ready';
    el.binStatus.title =
      `yt-dlp: ${status.ytDlp.path} (${status.ytDlp.source})\n` +
      `ffmpeg: ${status.ffmpeg.path} (${status.ffmpeg.source})`;
    updateDownloadButton();

    // Decorate with the real version numbers once the probes come back.
    window.api
      .binariesVersions()
      .then(({ ytDlp }) => {
        if (ytDlp) el.binStatusText.textContent = `yt-dlp ${ytDlp}`;
      })
      .catch(() => {/* the pill already says the tools are present */});
  } catch (err) {
    el.binStatus.className = 'status-pill status-pill--error';
    el.binStatusText.textContent = 'Tool check failed';
    el.binStatus.title = err.message;
    updateDownloadButton();
  }
}

/* -------------------------------------------------------------------------- */
/* Format / quality                                                           */
/* -------------------------------------------------------------------------- */

function setFormat(format, { persist = true } = {}) {
  const value = format === 'audio' ? 'audio' : 'video';

  el.segButtons.forEach((btn) => {
    const active = btn.dataset.format === value;
    btn.classList.toggle('is-active', active);
    btn.setAttribute('aria-checked', String(active));
  });

  // Resolution is meaningless for an audio-only rip.
  el.qualityOption.style.opacity = value === 'audio' ? '0.4' : '1';
  el.quality.disabled = value === 'audio';

  el.downloadBtn.textContent = value === 'audio' ? 'Download MP3' : 'Download MP4';

  if (persist) saveSettings({ format: value });
  else state.settings.format = value;
}

/* -------------------------------------------------------------------------- */
/* Analyze                                                                    */
/* -------------------------------------------------------------------------- */

function setAnalyzing(busy) {
  state.analyzing = busy;
  el.analyzeBtn.disabled = busy;
  el.analyzeSpinner.hidden = !busy;
  el.analyzeLabel.textContent = busy ? 'Analyzing' : 'Analyze';
  updateDownloadButton();
}

async function analyze() {
  const url = el.url.value.trim();
  if (!url) {
    toast('warn', 'Paste a link first');
    el.url.focus();
    return;
  }
  if (state.analyzing) return;

  setAnalyzing(true);
  try {
    const meta = await window.api.analyze({
      url,
      useCookies: el.useCookies.checked,
      cookieBrowser: el.cookieBrowser.value,
    });
    state.meta = meta;
    state.analyzedUrl = url;
    renderPreview(meta);

    if (meta.isLive) {
      toast('warn', 'Live stream', 'Live streams cannot be downloaded until they end.');
    }
  } catch (err) {
    state.meta = null;
    state.analyzedUrl = null;
    el.preview.hidden = true;
    toast('error', 'Could not read that link', err.message);
  } finally {
    setAnalyzing(false);
  }
}

function renderPreview(meta) {
  el.pvTitle.textContent = meta.title;
  el.pvUploader.textContent = meta.uploader || '';
  el.pvSource.textContent = meta.source || '';
  el.pvDuration.textContent = formatDuration(meta.duration);
  el.pvBest.textContent = meta.heights?.length ? `up to ${meta.heights[0]}p` : '';

  if (meta.thumbnail) {
    el.pvThumb.src = meta.thumbnail;
    el.pvThumb.alt = meta.title;
    el.pvThumb.hidden = false;
  } else {
    el.pvThumb.removeAttribute('src');
    el.pvThumb.hidden = true;
  }

  // Offer only the resolutions this video actually has.
  for (const option of el.quality.options) {
    if (option.value === 'best') continue;
    const available = !meta.heights?.length || meta.heights.some((h) => h >= Number(option.value));
    option.disabled = !available;
  }
  if (el.quality.selectedOptions[0]?.disabled) el.quality.value = 'best';

  el.preview.hidden = false;
  updateDownloadButton();
}

/* -------------------------------------------------------------------------- */
/* Download                                                                   */
/* -------------------------------------------------------------------------- */

function updateDownloadButton() {
  const hasUrl = el.url.value.trim().length > 0;
  el.downloadBtn.disabled = !hasUrl || !state.toolsReady || Boolean(state.jobId) || state.analyzing;
}

function setDownloading(active) {
  el.downloadBtn.hidden = active;
  el.cancelBtn.hidden = !active;
  el.url.disabled = active;
  el.analyzeBtn.disabled = active;
  el.chooseFolderBtn.disabled = active;
  updateDownloadButton();
}

function resetProgress() {
  el.progressBar.style.width = '0%';
  el.progressBar.classList.remove('is-indeterminate');
  el.progressPct.textContent = '0%';
  el.progressPhase.textContent = 'Starting…';
  el.progressSize.textContent = '—';
  el.progressSpeed.textContent = '—';
  el.progressEta.textContent = '—';
  el.logBox.textContent = '';
}

async function startDownload() {
  const url = el.url.value.trim();
  if (!url || state.jobId) return;

  resetProgress();
  el.progressCard.hidden = false;
  setDownloading(true);

  try {
    // Pass along the analyzed metadata (if it still matches the URL in the
    // box) so history entries get a proper title and thumbnail.
    const meta = state.analyzedUrl === url ? state.meta : null;

    const { id } = await window.api.startDownload({
      url,
      outputDir: state.settings.downloadDir,
      format: state.settings.format,
      quality: el.quality.value,
      useCookies: el.useCookies.checked,
      cookieBrowser: el.cookieBrowser.value,
      meta: meta ? { title: meta.title, thumbnail: meta.thumbnail, duration: meta.duration } : {},
    });
    state.jobId = id;
    updateDownloadButton();
  } catch (err) {
    setDownloading(false);
    el.progressCard.hidden = true;
    toast('error', 'Could not start download', err.message);
  }
}

async function cancelDownload() {
  if (!state.jobId) return;
  el.cancelBtn.disabled = true;
  try {
    await window.api.cancelDownload(state.jobId);
  } finally {
    el.cancelBtn.disabled = false;
  }
}

const PHASE_LABEL = {
  video: 'Downloading video',
  'audio-track': 'Downloading audio track',
  audio: 'Downloading audio',
  processing: 'Processing with ffmpeg…',
  done: 'Finished',
};

function onProgress(p) {
  if (p.id !== state.jobId) return;

  const percent = Math.max(0, Math.min(100, p.percent ?? 0));
  el.progressBar.style.width = `${percent.toFixed(1)}%`;
  el.progressPct.textContent = `${Math.floor(percent)}%`;
  el.progressPhase.textContent =
    p.phase === 'processing' && p.processor
      ? `Processing — ${p.processor}`
      : PHASE_LABEL[p.phase] || 'Downloading';

  // ffmpeg gives no byte counts, so show a moving stripe instead of a stalled bar.
  el.progressBar.classList.toggle('is-indeterminate', p.phase === 'processing');

  if (p.phase === 'processing') {
    el.progressSpeed.textContent = '—';
    el.progressEta.textContent = '—';
    return;
  }

  el.progressSize.textContent =
    p.total ? `${formatBytes(p.downloaded)} / ${formatBytes(p.total)}` : formatBytes(p.downloaded);
  el.progressSpeed.textContent = formatSpeed(p.speed);
  el.progressEta.textContent = formatEta(p.eta);
}

function onLog({ id, line }) {
  if (id !== state.jobId) return;
  // Keep the buffer bounded — long downloads emit thousands of lines.
  const lines = (el.logBox.textContent + line + '\n').split('\n');
  el.logBox.textContent = lines.slice(-300).join('\n');
  el.logBox.scrollTop = el.logBox.scrollHeight;
}

function onDone({ id, record }) {
  if (id !== state.jobId) return;
  state.jobId = null;
  setDownloading(false);
  el.progressBar.style.width = '100%';
  el.progressBar.classList.remove('is-indeterminate');
  el.progressPct.textContent = '100%';
  el.progressPhase.textContent = 'Finished';
  toast('success', 'Download complete', record.title);
  refreshHistory();
}

function onError({ id, message }) {
  if (id !== state.jobId) return;
  state.jobId = null;
  setDownloading(false);
  el.progressCard.hidden = true;
  toast('error', 'Download failed', message);
}

function onCanceled({ id }) {
  if (id !== state.jobId) return;
  state.jobId = null;
  setDownloading(false);
  el.progressCard.hidden = true;
  toast('info', 'Download canceled');
}

/* -------------------------------------------------------------------------- */
/* History                                                                    */
/* -------------------------------------------------------------------------- */

/** Small helper for the inline SVG action icons. */
function iconButton(label, pathData, className = '') {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = `icon-btn ${className}`.trim();
  btn.title = label;
  btn.setAttribute('aria-label', label);
  btn.innerHTML =
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" ' +
    `stroke-linecap="round" stroke-linejoin="round">${pathData}</svg>`;
  return btn;
}

const ICON = {
  play: '<polygon points="6 4 20 12 6 20 6 4" fill="currentColor" stroke="none" />',
  folder: '<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />',
  trash: '<path d="M3 6h18M8 6V4h8v2M6 6l1 14h10l1-14" />',
};

function renderHistory(items) {
  el.historyList.replaceChildren();
  el.historyEmpty.hidden = items.length > 0;
  el.clearHistoryBtn.disabled = items.length === 0;

  for (const item of items) {
    const li = document.createElement('li');
    li.className = `history-item${item.exists ? '' : ' is-missing'}`;

    if (item.thumbnail) {
      const img = document.createElement('img');
      img.className = 'history-thumb';
      img.src = item.thumbnail;
      img.alt = '';
      img.loading = 'lazy';
      li.appendChild(img);
    }

    const body = document.createElement('div');
    body.className = 'history-body';

    const title = document.createElement('div');
    title.className = 'history-title';
    title.textContent = item.title;
    title.title = item.filePath || item.url;

    const meta = document.createElement('div');
    meta.className = 'history-meta';

    const badge = document.createElement('span');
    badge.className = `badge badge--${item.format === 'audio' ? 'audio' : 'video'}`;
    badge.textContent = item.format === 'audio' ? 'MP3' : `MP4 ${item.quality === 'best' ? '' : item.quality + 'p'}`.trim();

    const details = [
      formatBytes(item.sizeBytes),
      formatDuration(item.durationSec),
      formatDate(item.completedAt),
      item.exists ? '' : 'file moved or deleted',
    ].filter((v) => v && v !== '—');

    meta.append(badge, document.createTextNode(details.join(' · ')));
    body.append(title, meta);

    const actions = document.createElement('div');
    actions.className = 'history-actions';

    const openBtn = iconButton('Play file', ICON.play);
    openBtn.disabled = !item.exists;
    openBtn.addEventListener('click', () =>
      window.api.openFile(item.filePath).catch((e) => toast('error', 'Could not open file', e.message))
    );

    const revealBtn = iconButton('Show in folder', ICON.folder);
    revealBtn.disabled = !item.exists;
    revealBtn.addEventListener('click', () =>
      window.api.revealFile(item.filePath).catch((e) => toast('error', 'Could not reveal file', e.message))
    );

    const removeBtn = iconButton('Remove from history', ICON.trash, 'icon-btn--danger');
    removeBtn.addEventListener('click', async () => {
      await window.api.historyRemove(item.id);
      refreshHistory();
    });

    actions.append(openBtn, revealBtn, removeBtn);
    li.append(body, actions);
    el.historyList.appendChild(li);
  }
}

async function refreshHistory() {
  renderHistory(await window.api.historyList());
}

/* -------------------------------------------------------------------------- */
/* Wiring                                                                     */
/* -------------------------------------------------------------------------- */

function bindEvents() {
  el.url.addEventListener('input', () => {
    updateDownloadButton();
    // Any edit invalidates the preview shown for the previous link.
    if (state.analyzedUrl && el.url.value.trim() !== state.analyzedUrl) {
      el.preview.hidden = true;
    }
  });

  el.url.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') analyze();
  });

  el.analyzeBtn.addEventListener('click', analyze);

  el.pasteBtn.addEventListener('click', async () => {
    try {
      const text = (await navigator.clipboard.readText()).trim();
      if (!text) return toast('warn', 'Clipboard is empty');
      el.url.value = text;
      updateDownloadButton();
      analyze();
    } catch {
      el.url.focus();
      toast('warn', 'Clipboard unavailable', 'Paste into the field manually.');
    }
  });

  el.segButtons.forEach((btn) =>
    btn.addEventListener('click', () => setFormat(btn.dataset.format))
  );

  el.quality.addEventListener('change', () => saveSettings({ quality: el.quality.value }));

  el.useCookies.addEventListener('change', () => {
    el.cookieBrowser.disabled = !el.useCookies.checked;
    saveSettings({ useCookies: el.useCookies.checked });
  });

  el.cookieBrowser.addEventListener('change', () =>
    saveSettings({ cookieBrowser: el.cookieBrowser.value })
  );

  el.chooseFolderBtn.addEventListener('click', async () => {
    const dir = await window.api.chooseFolder();
    if (dir) setFolder(dir);
  });

  el.openFolderBtn.addEventListener('click', () =>
    window.api
      .openFolder(state.settings.downloadDir)
      .catch((e) => toast('error', 'Could not open folder', e.message))
  );

  el.downloadBtn.addEventListener('click', startDownload);
  el.cancelBtn.addEventListener('click', cancelDownload);

  el.clearHistoryBtn.addEventListener('click', async () => {
    await window.api.historyClear();
    refreshHistory();
  });

  // Live events from the main process.
  window.api.onProgress(onProgress);
  window.api.onDone(onDone);
  window.api.onError(onError);
  window.api.onCanceled(onCanceled);
  window.api.onLog(onLog);

  // Ctrl/Cmd+V anywhere focuses the URL field.
  document.addEventListener('keydown', (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'v' && document.activeElement !== el.url) {
      el.url.focus();
    }
  });
}

async function init() {
  bindEvents();
  const { platform } = await window.api.appInfo();
  document.body.dataset.platform = platform;
  await loadSettings();
  await Promise.all([refreshToolStatus(), refreshHistory()]);
  el.url.focus();
}

init().catch((err) => toast('error', 'Startup failed', err.message));
