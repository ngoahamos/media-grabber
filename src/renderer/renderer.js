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

  // Scoped by data attribute: the editor pane reuses the .seg styling for its
  // own operation switch, and these two sets must never toggle each other.
  segButtons: document.querySelectorAll('.seg[data-format]'),
  opButtons: document.querySelectorAll('.seg[data-op]'),
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

  tabs: document.querySelectorAll('.tab'),
  downloadPane: $('downloadPane'),
  editPane: $('editPane'),

  trimView: $('trimView'),
  trimDrop: $('trimDrop'),
  trimFile: $('trimFile'),
  trimName: $('trimName'),
  trimSpecs: $('trimSpecs'),
  trimClearBtn: $('trimClearBtn'),
  trimPreview: $('trimPreview'),
  trimStart: $('trimStart'),
  trimEnd: $('trimEnd'),
  trimStartHere: $('trimStartHere'),
  trimEndHere: $('trimEndHere'),
  trimSummary: $('trimSummary'),
  trimStartRange: $('trimStartRange'),
  trimEndRange: $('trimEndRange'),

  joinView: $('joinView'),
  joinDrop: $('joinDrop'),
  joinList: $('joinList'),
  joinNote: $('joinNote'),

  editUnavailable: $('editUnavailable'),
  editMode: $('editMode'),
  editModeHint: $('editModeHint'),
  editRunBtn: $('editRunBtn'),
  editCancelBtn: $('editCancelBtn'),
  editProgressCard: $('editProgressCard'),
  editPhase: $('editPhase'),
  editPct: $('editPct'),
  editBar: $('editBar'),
  editTime: $('editTime'),
  editSpeed: $('editSpeed'),
  editTarget: $('editTarget'),
  editLogBox: $('editLogBox'),

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
  /** yt-dlp + ffmpeg — everything the downloader needs. */
  toolsReady: false,
  /** ffmpeg + ffprobe — the editor works even when yt-dlp is missing. */
  editToolsReady: false,

  /** 'download' | 'edit' */
  tab: 'download',
  /** 'trim' | 'join' */
  op: 'trim',
  /** Probe result for the file being trimmed, or null. */
  trimFile: null,
  /** Trim range in seconds. */
  trimStart: 0,
  trimEnd: 0,
  /** Probe results for the join queue, in output order. */
  joinFiles: [],
  /** Result of the last join compatibility check, or null. */
  joinCheck: null,
  /** Active trim/join job id, or null when idle. */
  editJobId: null,
  /** Number of probes in flight; the run button stays disabled above zero. */
  probesInFlight: 0,
  /** Bumped whenever the queue changes; older probe results are discarded. */
  probeToken: 0,
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
    setEditToolsReady(status.ffmpeg.ok && status.ffprobe.ok, status.binDir);

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
      updateEditButton();
      return;
    }

    el.binStatus.className = 'status-pill status-pill--ok';
    el.binStatusText.textContent = 'Tools ready';
    el.binStatus.title =
      `yt-dlp: ${status.ytDlp.path} (${status.ytDlp.source})\n` +
      `ffmpeg: ${status.ffmpeg.path} (${status.ffmpeg.source})`;
    updateDownloadButton();
    updateEditButton();

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
    setEditToolsReady(false, null);
    updateDownloadButton();
    updateEditButton();
  }
}

/**
 * The editor needs ffmpeg and ffprobe but not yt-dlp, so it stays usable on an
 * install where only the downloader's binary is missing — and says so plainly
 * rather than failing at spawn time when the tools it does need are absent.
 * @param {boolean} ready
 * @param {string|null} binDir
 */
function setEditToolsReady(ready, binDir) {
  state.editToolsReady = ready;
  el.editUnavailable.hidden = ready;
  if (!ready) {
    el.editUnavailable.textContent =
      'Trimming and joining need ffmpeg and ffprobe. Run "npm run setup:binaries"' +
      (binDir ? `, or place both binaries in ${binDir}.` : '.');
  }
  updateEditButton();
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
  scissors: '<circle cx="6" cy="7" r="2.6" /><circle cx="6" cy="17" r="2.6" />' +
    '<path d="M8.3 8.4 20 17M8.3 15.6 20 7" />',
};

/**
 * Label a library entry by its real container rather than by the format the
 * download used — an edited .mkv or .m4a must not be badged "MP4".
 * @param {object} item
 */
function formatBadge(item) {
  const ext = item.filePath?.split('.').pop();
  if (ext && ext.length <= 4 && !ext.includes('/') && !ext.includes('\\')) {
    return ext.toUpperCase();
  }
  return item.format === 'audio' ? 'MP3' : 'MP4';
}

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
    badge.textContent = `${formatBadge(item)} ${
      item.format === 'video' && item.quality !== 'best' ? `${item.quality}p` : ''
    }`.trim();

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

    const trimBtn = iconButton('Trim this file', ICON.scissors);
    trimBtn.disabled = !item.exists;
    trimBtn.addEventListener('click', () =>
      openInEditor(item.filePath, 'trim').catch((e) =>
        toast('error', 'Could not open in the editor', e.message)
      )
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

    actions.append(openBtn, trimBtn, revealBtn, removeBtn);
    li.append(body, actions);
    el.historyList.appendChild(li);
  }
}

async function refreshHistory() {
  renderHistory(await window.api.historyList());
}

/* -------------------------------------------------------------------------- */
/* Tabs                                                                       */
/* -------------------------------------------------------------------------- */

function setTab(name) {
  const value = name === 'edit' ? 'edit' : 'download';
  state.tab = value;

  el.tabs.forEach((tab) => {
    const active = tab.dataset.tab === value;
    tab.classList.toggle('is-active', active);
    tab.setAttribute('aria-selected', String(active));
  });

  el.downloadPane.hidden = value !== 'download';
  el.editPane.hidden = value !== 'edit';

  // Leaving the editor should not leave a video playing behind the other tab.
  if (value !== 'edit') el.trimPreview.pause();
}

/* -------------------------------------------------------------------------- */
/* Timecodes                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * Accepts "90", "1:30", "1:30.25" or "1:02:03" and returns seconds.
 * @param {string} value
 * @returns {number|null} null when the text is not a timecode
 */
function parseTimeInput(value) {
  const text = String(value).trim();
  if (!text) return null;
  if (!/^\d+(:\d{1,2}){0,2}(\.\d+)?$/.test(text)) return null;

  const parts = text.split(':').map(Number);
  if (parts.some((n) => !Number.isFinite(n))) return null;
  // Only the first field may exceed 59 — "1:75" is a typo, not 135 seconds.
  if (parts.slice(1).some((n) => n >= 60)) return null;

  return parts.reduce((total, part) => total * 60 + part, 0);
}

/** 83.4 → "1:23.4"; whole seconds lose the decimal. */
function formatTimecode(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) return '0:00';
  const whole = Math.floor(seconds);
  const tenths = Math.round((seconds - whole) * 10);
  const base = formatDuration(whole);
  return tenths > 0 ? `${base}.${tenths}` : base;
}

/* -------------------------------------------------------------------------- */
/* Editor — shared                                                            */
/* -------------------------------------------------------------------------- */

function setOp(name) {
  const value = name === 'join' ? 'join' : 'trim';
  state.op = value;

  el.opButtons.forEach((btn) => {
    const active = btn.dataset.op === value;
    btn.classList.toggle('is-active', active);
    btn.setAttribute('aria-checked', String(active));
  });

  el.trimView.hidden = value !== 'trim';
  el.joinView.hidden = value !== 'join';
  if (value !== 'trim') el.trimPreview.pause();

  el.editRunBtn.textContent = value === 'join' ? 'Join' : 'Trim';
  syncEditMode();
  updateEditButton();
}

/**
 * Keep the quality-mode select honest about what is actually possible:
 * a join of mismatched files cannot copy streams, so that option is removed
 * rather than left to fail halfway through.
 */
function syncEditMode() {
  const copyOption = el.editMode.querySelector('option[value="copy"]');
  const copyBlocked = state.op === 'join' && state.joinFiles.length > 1 && !state.joinCheck?.compatible;

  copyOption.disabled = copyBlocked;
  if (copyBlocked && el.editMode.value === 'copy') el.editMode.value = 'encode';

  const mode = el.editMode.value;
  el.editModeHint.textContent =
    state.op === 'trim'
      ? mode === 'copy'
        ? 'Instant, and the video is untouched — but the cut lands on the nearest keyframe before your start time.'
        : 'Exact to the frame, at the cost of a full re-encode. Slower, and slightly lossy.'
      : mode === 'copy'
        ? 'Instant. Only works when every file has identical codecs and dimensions.'
        : 'Re-encodes everything to one consistent stream. Works with any mix of files.';
}

function updateEditButton() {
  const busy = Boolean(state.editJobId) || state.probesInFlight > 0;

  const ready =
    state.op === 'trim'
      ? Boolean(state.trimFile) && state.trimEnd - state.trimStart >= 0.05
      : state.joinFiles.length >= 2 && !state.joinCheck?.fatal;

  el.editRunBtn.disabled = busy || !ready || !state.editToolsReady;
}

function setEditing(active) {
  el.editRunBtn.hidden = active;
  el.editCancelBtn.hidden = !active;
  el.opButtons.forEach((btn) => { btn.disabled = active; });
  el.editMode.disabled = active;
  el.trimDrop.classList.toggle('is-disabled', active);
  el.joinDrop.classList.toggle('is-disabled', active);
  updateEditButton();
}

/** Pull the paths out of a drop event; only the preload can resolve them. */
function pathsFromDrop(event) {
  return [...event.dataTransfer.files]
    .map((file) => window.api.pathForFile(file))
    .filter(Boolean);
}

/** Wire a dropzone to open a file dialog on click and accept drops. */
function bindDropzone(zone, { multiple, onFiles }) {
  const choose = async () => {
    const paths = await window.api.pickMediaFiles(multiple);
    if (paths.length) onFiles(paths);
  };

  zone.addEventListener('click', choose);
  zone.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      choose();
    }
  });

  zone.addEventListener('dragover', (e) => {
    e.preventDefault();
    zone.classList.add('is-over');
  });
  zone.addEventListener('dragleave', () => zone.classList.remove('is-over'));
  zone.addEventListener('drop', (e) => {
    e.preventDefault();
    zone.classList.remove('is-over');
    const paths = pathsFromDrop(e);
    if (paths.length) onFiles(multiple ? paths : paths.slice(0, 1));
  });
}

/**
 * Invalidate any probe still in flight.
 *
 * Every edit to the queue calls this first, so a reply that arrives for a list
 * the user has already moved on from is dropped instead of resurrecting it.
 * Removing two files in quick succession is the case that needs it: the second
 * removal takes the queue below two files and answers without probing at all,
 * and the first probe's reply would otherwise land afterwards and win.
 */
function invalidateProbes() {
  state.probeToken += 1;
}

/**
 * Probe files in the main process, turning any failure into a toast rather
 * than an unhandled rejection. Returns null when the result is stale.
 * @param {string[]} paths
 * @returns {Promise<{files: object[], join: object|null}|null>}
 */
async function probeFiles(paths) {
  const token = state.probeToken;

  // A count rather than a flag: the in-flight probe this one supersedes still
  // has to release the button when it finally answers.
  state.probesInFlight += 1;
  updateEditButton();
  try {
    const result = await window.api.probeMedia(paths);
    return token === state.probeToken ? result : null;
  } catch (err) {
    if (token === state.probeToken) toast('error', 'Could not read that file', err.message);
    return null;
  } finally {
    state.probesInFlight -= 1;
    updateEditButton();
  }
}

/** A one-line codec/size summary for a probed file. */
function describeFile(info) {
  return [
    info.hasVideo && info.video.height ? `${info.video.width}×${info.video.height}` : null,
    info.video?.codec || null,
    info.audio?.codec || null,
    formatDuration(info.duration),
    formatBytes(info.sizeBytes),
  ]
    .filter((v) => v && v !== '—')
    .join(' · ');
}

/* -------------------------------------------------------------------------- */
/* Editor — trim                                                              */
/* -------------------------------------------------------------------------- */

async function loadTrimFile(filePath) {
  invalidateProbes();
  const result = await probeFiles([filePath]);
  if (!result?.files.length) return;

  const info = result.files[0];
  state.trimFile = info;
  state.trimStart = 0;
  // A container with no duration in its header still plays; the preview's
  // loadedmetadata event fills the gap once the file is open.
  state.trimEnd = info.duration ?? 0;

  el.trimName.textContent = info.name;
  el.trimName.title = info.filePath;
  el.trimSpecs.textContent = describeFile(info);

  el.trimPreview.classList.toggle('is-audio', !info.hasVideo);
  el.trimPreview.src = info.previewUrl;

  el.trimDrop.hidden = true;
  el.trimFile.hidden = false;
  syncTrimUi();
}

function clearTrimFile() {
  state.trimFile = null;
  state.trimStart = 0;
  state.trimEnd = 0;
  el.trimPreview.pause();
  el.trimPreview.removeAttribute('src');
  el.trimPreview.load();
  el.trimFile.hidden = true;
  el.trimDrop.hidden = false;
  updateEditButton();
}

/** Push the current range into the text inputs, sliders and summary. */
function syncTrimUi() {
  const duration = state.trimFile?.duration || 0;

  el.trimStart.value = formatTimecode(state.trimStart);
  el.trimEnd.value = formatTimecode(state.trimEnd);
  el.trimStart.classList.remove('is-invalid');
  el.trimEnd.classList.remove('is-invalid');

  if (duration > 0) {
    el.trimStartRange.value = String(Math.round((state.trimStart / duration) * 1000));
    el.trimEndRange.value = String(Math.round((state.trimEnd / duration) * 1000));
  }

  const length = Math.max(0, state.trimEnd - state.trimStart);
  el.trimSummary.textContent = length > 0
    ? `${formatTimecode(length)} of ${formatDuration(duration)}`
    : '—';

  updateEditButton();
}

/**
 * Move one edge of the range, keeping start strictly before end.
 * @param {'start'|'end'} edge
 * @param {number} seconds
 */
function setTrimEdge(edge, seconds) {
  const duration = state.trimFile?.duration || 0;
  if (!duration) return;

  const MIN = 0.05;   // ffmpeg cannot make a shorter clip than this meaningfully
  const value = Math.max(0, Math.min(duration, seconds));

  if (edge === 'start') state.trimStart = Math.min(value, state.trimEnd - MIN);
  else state.trimEnd = Math.max(value, state.trimStart + MIN);

  syncTrimUi();
}

/** Commit a typed timecode, reverting the field when it cannot be parsed. */
function commitTimeInput(edge, input) {
  const seconds = parseTimeInput(input.value);
  if (seconds == null) {
    input.classList.add('is-invalid');
    return;
  }
  setTrimEdge(edge, seconds);
}

/* -------------------------------------------------------------------------- */
/* Editor — join                                                              */
/* -------------------------------------------------------------------------- */

async function addJoinFiles(paths) {
  invalidateProbes();
  // Re-probing the whole queue is what produces the compatibility verdict,
  // which depends on the set as a whole rather than on any one file.
  const existing = state.joinFiles.map((f) => f.filePath);
  const merged = [...existing, ...paths.filter((p) => !existing.includes(p))];
  if (merged.length === existing.length) return;

  const result = await probeFiles(merged);
  if (!result) return;

  state.joinFiles = result.files;
  state.joinCheck = result.join;
  renderJoinList();
}

async function reprobeJoin() {
  invalidateProbes();

  // Render the new order or the shortened list straight away; the probe only
  // supplies the compatibility verdict, which can land a moment later.
  renderJoinList();

  if (state.joinFiles.length < 2) {
    state.joinCheck = null;
    renderJoinList();
    return;
  }

  const result = await probeFiles(state.joinFiles.map((f) => f.filePath));
  if (!result) return;
  state.joinFiles = result.files;
  state.joinCheck = result.join;
  renderJoinList();
}

function moveJoinFile(index, delta) {
  const target = index + delta;
  if (target < 0 || target >= state.joinFiles.length) return;
  const list = state.joinFiles.slice();
  [list[index], list[target]] = [list[target], list[index]];
  state.joinFiles = list;
  // Order changes what the first file is, and the verdict is order-sensitive.
  reprobeJoin();
}

function removeJoinFile(index) {
  state.joinFiles = state.joinFiles.filter((_, i) => i !== index);
  reprobeJoin();
}

const JOIN_ICON = {
  up: '<path d="M12 19V6m0 0-6 6m6-6 6 6" />',
  down: '<path d="M12 5v13m0 0 6-6m-6 6-6-6" />',
};

function renderJoinList() {
  el.joinList.replaceChildren();

  state.joinFiles.forEach((info, index) => {
    const li = document.createElement('li');
    li.className = 'join-item';

    const position = document.createElement('span');
    position.className = 'join-index';
    position.textContent = String(index + 1);

    const body = document.createElement('div');
    body.className = 'join-body';

    const name = document.createElement('div');
    name.className = 'join-name';
    name.textContent = info.name;
    name.title = info.filePath;

    const meta = document.createElement('div');
    meta.className = 'join-meta';
    meta.textContent = describeFile(info);

    body.append(name, meta);

    const actions = document.createElement('div');
    actions.className = 'join-actions';

    const up = iconButton('Move up', JOIN_ICON.up);
    up.disabled = index === 0;
    up.addEventListener('click', () => moveJoinFile(index, -1));

    const down = iconButton('Move down', JOIN_ICON.down);
    down.disabled = index === state.joinFiles.length - 1;
    down.addEventListener('click', () => moveJoinFile(index, 1));

    const remove = iconButton('Remove', ICON.trash, 'icon-btn--danger');
    remove.addEventListener('click', () => removeJoinFile(index));

    actions.append(up, down, remove);
    li.append(position, body, actions);
    el.joinList.appendChild(li);
  });

  renderJoinNote();
  syncEditMode();
  updateEditButton();
}

function renderJoinNote() {
  const check = state.joinCheck;

  if (state.joinFiles.length < 2) {
    el.joinNote.hidden = state.joinFiles.length === 0;
    el.joinNote.className = 'join-note';
    el.joinNote.textContent = 'Add one more file — joining needs at least two.';
    return;
  }

  el.joinNote.hidden = false;

  if (check?.fatal) {
    el.joinNote.className = 'join-note join-note--error';
    el.joinNote.textContent = check.reason;
    return;
  }

  if (check?.compatible) {
    el.joinNote.className = 'join-note join-note--ok';
    el.joinNote.textContent =
      'These files match — they can be joined instantly without re-encoding.';
    return;
  }

  el.joinNote.className = 'join-note join-note--warn';
  el.joinNote.textContent = `${check?.reason || 'These files differ.'} They will be re-encoded to a single consistent stream, which takes longer.`;
}

/* -------------------------------------------------------------------------- */
/* Editor — running                                                           */
/* -------------------------------------------------------------------------- */

function resetEditProgress() {
  el.editBar.style.width = '0%';
  el.editBar.classList.remove('is-indeterminate');
  el.editPct.textContent = '0%';
  el.editPhase.textContent = 'Starting…';
  el.editTime.textContent = '—';
  el.editSpeed.textContent = '—';
  el.editTarget.textContent = '—';
  el.editLogBox.textContent = '';
}

async function runEdit() {
  if (state.editJobId) return;

  resetEditProgress();
  el.editProgressCard.hidden = false;
  setEditing(true);

  try {
    const mode = el.editMode.value;
    const { id, outputPath } =
      state.op === 'trim'
        ? await window.api.startTrim({
            filePath: state.trimFile.filePath,
            start: state.trimStart,
            end: state.trimEnd,
            sourceDuration: state.trimFile.duration,
            mode,
          })
        : await window.api.startJoin({
            filePaths: state.joinFiles.map((f) => f.filePath),
            mode,
          });

    state.editJobId = id;
    el.editTarget.textContent = outputPath.split(/[\\/]/).pop();
    el.editTarget.title = outputPath;
    updateEditButton();
  } catch (err) {
    setEditing(false);
    el.editProgressCard.hidden = true;
    toast('error', state.op === 'trim' ? 'Could not start trim' : 'Could not start join', err.message);
  }
}

async function cancelEdit() {
  if (!state.editJobId) return;
  el.editCancelBtn.disabled = true;
  try {
    await window.api.cancelEdit(state.editJobId);
  } finally {
    el.editCancelBtn.disabled = false;
  }
}

function onEditProgress(p) {
  if (p.id !== state.editJobId) return;

  el.editPhase.textContent = p.phase === 'join' ? 'Joining…'
    : p.phase === 'done' ? 'Finished'
    : 'Trimming…';

  // A file with no duration in its header gives nothing to divide by, so the
  // bar animates instead of pretending to know how far along it is.
  if (p.percent == null) {
    el.editBar.classList.add('is-indeterminate');
    el.editBar.style.width = '100%';
    el.editPct.textContent = '—';
  } else {
    el.editBar.classList.remove('is-indeterminate');
    el.editBar.style.width = `${p.percent.toFixed(1)}%`;
    el.editPct.textContent = `${Math.floor(p.percent)}%`;
  }

  el.editTime.textContent = p.processedSec != null
    ? `${formatDuration(p.processedSec)}${p.totalSec ? ` / ${formatDuration(p.totalSec)}` : ''}`
    : '—';
  el.editSpeed.textContent = p.speed ? `${p.speed.toFixed(1)}×` : '—';
}

function onEditLog({ id, line }) {
  if (id !== state.editJobId) return;
  const lines = (el.editLogBox.textContent + line + '\n').split('\n');
  el.editLogBox.textContent = lines.slice(-300).join('\n');
  el.editLogBox.scrollTop = el.editLogBox.scrollHeight;
}

function onEditDone({ id, record }) {
  if (id !== state.editJobId) return;
  state.editJobId = null;
  setEditing(false);
  el.editBar.classList.remove('is-indeterminate');
  el.editBar.style.width = '100%';
  el.editPct.textContent = '100%';
  el.editPhase.textContent = 'Finished';
  toast('success', state.op === 'trim' ? 'Trim complete' : 'Join complete', record.title);
  refreshHistory();
}

function onEditError({ id, message }) {
  if (id !== state.editJobId) return;
  state.editJobId = null;
  setEditing(false);
  el.editProgressCard.hidden = true;
  toast('error', state.op === 'trim' ? 'Trim failed' : 'Join failed', message);
}

function onEditCanceled({ id }) {
  if (id !== state.editJobId) return;
  state.editJobId = null;
  setEditing(false);
  el.editProgressCard.hidden = true;
  toast('info', 'Canceled');
}

/** Jump from a library entry straight into the editor with that file loaded. */
async function openInEditor(filePath, op) {
  if (state.editJobId) {
    toast('warn', 'Still working', 'Wait for the current operation to finish, or cancel it.');
    return;
  }
  setTab('edit');
  setOp(op);
  if (op === 'trim') await loadTrimFile(filePath);
  else await addJoinFiles([filePath]);
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

  /* tabs ------------------------------------------------------------------ */
  el.tabs.forEach((tab) => tab.addEventListener('click', () => setTab(tab.dataset.tab)));

  /* editor ---------------------------------------------------------------- */
  el.opButtons.forEach((btn) => btn.addEventListener('click', () => setOp(btn.dataset.op)));

  bindDropzone(el.trimDrop, { multiple: false, onFiles: (paths) => loadTrimFile(paths[0]) });
  bindDropzone(el.joinDrop, { multiple: true, onFiles: addJoinFiles });

  el.trimClearBtn.addEventListener('click', clearTrimFile);

  // Some containers only reveal their duration once decoding starts.
  el.trimPreview.addEventListener('loadedmetadata', () => {
    const duration = el.trimPreview.duration;
    if (!state.trimFile || !Number.isFinite(duration) || duration <= 0) return;
    if (state.trimFile.duration) return;
    state.trimFile.duration = duration;
    state.trimEnd = duration;
    el.trimSpecs.textContent = describeFile(state.trimFile);
    syncTrimUi();
  });

  el.trimStart.addEventListener('change', () => commitTimeInput('start', el.trimStart));
  el.trimEnd.addEventListener('change', () => commitTimeInput('end', el.trimEnd));
  el.trimStart.addEventListener('keydown', (e) => { if (e.key === 'Enter') el.trimStart.blur(); });
  el.trimEnd.addEventListener('keydown', (e) => { if (e.key === 'Enter') el.trimEnd.blur(); });

  el.trimStartHere.addEventListener('click', () => setTrimEdge('start', el.trimPreview.currentTime));
  el.trimEndHere.addEventListener('click', () => setTrimEdge('end', el.trimPreview.currentTime));

  const rangeToSeconds = (input) =>
    (Number(input.value) / 1000) * (state.trimFile?.duration || 0);

  el.trimStartRange.addEventListener('input', () => {
    setTrimEdge('start', rangeToSeconds(el.trimStartRange));
    // Scrubbing the start handle doubles as seeking, so you can see the cut.
    el.trimPreview.currentTime = state.trimStart;
  });
  el.trimEndRange.addEventListener('input', () => {
    setTrimEdge('end', rangeToSeconds(el.trimEndRange));
    el.trimPreview.currentTime = state.trimEnd;
  });

  el.editMode.addEventListener('change', syncEditMode);
  el.editRunBtn.addEventListener('click', runEdit);
  el.editCancelBtn.addEventListener('click', cancelEdit);

  // Live events from the main process.
  window.api.onProgress(onProgress);
  window.api.onDone(onDone);
  window.api.onError(onError);
  window.api.onCanceled(onCanceled);
  window.api.onLog(onLog);
  window.api.onEditProgress(onEditProgress);
  window.api.onEditDone(onEditDone);
  window.api.onEditError(onEditError);
  window.api.onEditCanceled(onEditCanceled);
  window.api.onEditLog(onEditLog);

  // Ctrl/Cmd+V anywhere focuses the URL field.
  document.addEventListener('keydown', (e) => {
    if (state.tab !== 'download') return;
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
  setTab('download');
  setOp('trim');
  await Promise.all([refreshToolStatus(), refreshHistory()]);
  el.url.focus();
}

init().catch((err) => toast('error', 'Startup failed', err.message));
