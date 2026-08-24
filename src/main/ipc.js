'use strict';

/**
 * Every renderer-callable operation lives here.
 *
 * The renderer is sandboxed (contextIsolation on, nodeIntegration off), so this
 * is the app's entire trust boundary: validate inputs, never accept a path or a
 * command from the UI that has not been checked.
 */

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { ipcMain, dialog, shell, app, BrowserWindow } = require('electron');

const binaries = require('./binaries');
const { store } = require('./store');
const { analyze, DownloadJob } = require('./ytdlp');
const ffmpeg = require('./ffmpeg');

/** @type {Map<string, DownloadJob>} in-flight downloads, keyed by job id. */
const jobs = new Map();

/** @type {Map<string, import('./ffmpeg').MediaJob>} in-flight trim/join jobs. */
const editJobs = new Map();

/* -------------------------------------------------------------------------- */
/* Validation helpers                                                          */
/* -------------------------------------------------------------------------- */

/** Only http(s) URLs ever reach yt-dlp — no file:// or shell-ish strings. */
function assertHttpUrl(value) {
  let url;
  try {
    url = new URL(String(value).trim());
  } catch {
    throw new Error('That does not look like a valid link.');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error('Only http and https links are supported.');
  }
  return url.toString();
}

/** Make sure the target folder exists and is writable before we start. */
async function assertWritableDir(dir) {
  const resolved = path.resolve(String(dir || ''));
  await fsp.mkdir(resolved, { recursive: true });
  await fsp.access(resolved, fs.constants.W_OK);
  return resolved;
}

/**
 * Accept a media path from the renderer.
 *
 * Every path the UI can send originated in a file dialog or a drag-and-drop,
 * so this is a sanity check rather than a sandbox escape hatch: it must exist,
 * be a regular file, and carry an extension we are prepared to hand to ffmpeg.
 * @param {string} value
 * @returns {string} the resolved absolute path
 */
function assertMediaFile(value) {
  const resolved = path.resolve(String(value || ''));

  let stats;
  try {
    stats = fs.statSync(resolved);
  } catch {
    throw new Error(`That file no longer exists: ${path.basename(resolved)}`);
  }
  if (!stats.isFile()) throw new Error('That is not a file.');

  const ext = path.extname(resolved).slice(1).toLowerCase();
  if (!ffmpeg.MEDIA_EXTENSIONS.includes(ext)) {
    throw new Error(`"${path.basename(resolved)}" is not a media file we can edit.`);
  }
  return resolved;
}

/**
 * Where an edited file should land: beside its source when that folder is
 * writable, otherwise the configured download folder.
 * @param {string} sourceDir
 * @returns {Promise<string>}
 */
async function resolveOutputDir(sourceDir) {
  try {
    await fsp.access(sourceDir, fs.constants.W_OK);
    return sourceDir;
  } catch {
    return assertWritableDir(store().getSettings().downloadDir);
  }
}

/** Both binaries are needed before any editing can start. */
function requireEditingTools() {
  if (!binaries.ffmpegPath() || !binaries.ffprobePath()) {
    throw new Error(
      'ffmpeg and ffprobe are required for trimming and joining. Run "npm run setup:binaries".'
    );
  }
}

/** Broadcast an event to the window that owns the job. */
function send(webContents, channel, payload) {
  if (webContents && !webContents.isDestroyed()) webContents.send(channel, payload);
}

/* -------------------------------------------------------------------------- */
/* Registration                                                                */
/* -------------------------------------------------------------------------- */

function registerIpc() {
  /* ---- app / environment ------------------------------------------------ */

  ipcMain.handle('app:info', async () => ({
    version: app.getVersion(),
    name: app.getName(),
    platform: process.platform,
    arch: process.arch,
    electron: process.versions.electron,
  }));

  ipcMain.handle('binaries:status', () => binaries.status());
  ipcMain.handle('binaries:versions', () => binaries.versions());

  /* ---- settings --------------------------------------------------------- */

  ipcMain.handle('settings:get', () => store().getSettings());

  ipcMain.handle('settings:set', (_e, patch) => {
    const allowed = ['downloadDir', 'format', 'quality', 'useCookies', 'cookieBrowser', 'theme'];
    const clean = {};
    for (const key of allowed) {
      if (patch && Object.hasOwn(patch, key)) clean[key] = patch[key];
    }
    return store().updateSettings(clean);
  });

  ipcMain.handle('dialog:chooseFolder', async (event) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    const { canceled, filePaths } = await dialog.showOpenDialog(win, {
      title: 'Choose download folder',
      defaultPath: store().getSettings().downloadDir,
      properties: ['openDirectory', 'createDirectory'],
    });
    if (canceled || !filePaths[0]) return null;
    return store().updateSettings({ downloadDir: filePaths[0] }).downloadDir;
  });

  /* ---- analysis --------------------------------------------------------- */

  ipcMain.handle('video:analyze', async (_e, { url, useCookies, cookieBrowser } = {}) => {
    const clean = assertHttpUrl(url);
    return analyze(clean, { useCookies, cookieBrowser });
  });

  /* ---- downloads -------------------------------------------------------- */

  ipcMain.handle('download:start', async (event, payload = {}) => {
    const settings = store().getSettings();
    const url = assertHttpUrl(payload.url);
    const outputDir = await assertWritableDir(payload.outputDir || settings.downloadDir);
    const format = payload.format === 'audio' ? 'audio' : 'video';
    const quality = ['best', '1080', '720', '480'].includes(String(payload.quality))
      ? String(payload.quality)
      : 'best';

    if (!binaries.ytDlpPath()) {
      throw new Error('yt-dlp is not installed. Run "npm run setup:binaries" first.');
    }
    if (!binaries.ffmpegPath()) {
      throw new Error(
        'ffmpeg is not installed — it is required to merge video and to create MP3 files. Run "npm run setup:binaries".'
      );
    }

    const id = `job-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
    const job = new DownloadJob({
      id,
      url,
      outputDir,
      format,
      quality,
      useCookies: Boolean(payload.useCookies ?? settings.useCookies),
      cookieBrowser: payload.cookieBrowser || settings.cookieBrowser,
    });

    const sender = event.sender;
    const meta = payload.meta || {};

    job.on('progress', (p) => send(sender, 'download:progress', { id, ...p }));
    job.on('log', (line) => send(sender, 'download:log', { id, line }));

    job.on('error', (err) => {
      jobs.delete(id);
      send(sender, 'download:error', { id, message: err.message, detail: err.detail || null });
    });

    job.on('done', async ({ filePath, canceled }) => {
      jobs.delete(id);

      if (canceled) return send(sender, 'download:canceled', { id });

      let sizeBytes = null;
      try {
        if (filePath) sizeBytes = (await fsp.stat(filePath)).size;
      } catch {
        /* file may have been moved by the user already */
      }

      const record = store().addHistory({
        title: meta.title || path.basename(filePath || url),
        url,
        filePath,
        thumbnail: meta.thumbnail || null,
        format,
        quality: format === 'audio' ? 'mp3' : quality,
        sizeBytes,
        durationSec: meta.duration ?? null,
      });

      send(sender, 'download:done', { id, record });
    });

    jobs.set(id, job);
    job.start();
    return { id };
  });

  ipcMain.handle('download:cancel', (_e, { id } = {}) => {
    const job = jobs.get(id);
    if (!job) return false;
    job.cancel();
    return true;
  });

  /* ---- editing ---------------------------------------------------------- */

  ipcMain.handle('edit:pickFiles', async (event, { multiple = false } = {}) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    const { canceled, filePaths } = await dialog.showOpenDialog(win, {
      title: multiple ? 'Choose media files' : 'Choose a media file',
      defaultPath: store().getSettings().downloadDir,
      filters: [
        { name: 'Media', extensions: ffmpeg.MEDIA_EXTENSIONS },
        { name: 'All files', extensions: ['*'] },
      ],
      properties: multiple ? ['openFile', 'multiSelections'] : ['openFile'],
    });
    return canceled ? [] : filePaths;
  });

  ipcMain.handle('edit:probe', async (_e, { filePaths = [] } = {}) => {
    requireEditingTools();

    const list = Array.isArray(filePaths) ? filePaths : [filePaths];
    if (!list.length) return { files: [], join: null };

    const files = [];
    for (const candidate of list) {
      const filePath = assertMediaFile(candidate);
      const info = await ffmpeg.probe(filePath);
      // The renderer cannot build a file:// URL itself — it never sees a path
      // it can trust to encode correctly — so hand it a ready-made one.
      files.push({ ...info, previewUrl: pathToFileURL(filePath).href });
    }

    return {
      files,
      join: files.length > 1 ? ffmpeg.joinCompatibility(files) : null,
    };
  });

  ipcMain.handle('edit:trim', async (event, payload = {}) => {
    requireEditingTools();

    const filePath = assertMediaFile(payload.filePath);
    const info = await ffmpeg.probe(filePath);

    const start = Number(payload.start);
    const end = Number(payload.end);
    if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0) {
      throw new Error('Enter a valid start and end time.');
    }
    if (end - start < 0.05) {
      throw new Error('The end time must be later than the start time.');
    }

    // A seek past the end of the file does not fail — ffmpeg quietly rewinds to
    // the start and copies the whole thing, which would land in the library as
    // a "trim" that is nothing of the sort. Nothing downstream catches that, so
    // the length has to be known and checked here.
    //
    // `sourceDuration` is the renderer's fallback for the handful of containers
    // that carry no duration in their header but report one once the preview
    // player opens them. It can only ever tighten this check: a value that is
    // too large is no weaker than the null it replaces, and one that is too
    // small merely rejects the request.
    const hint = Number(payload.sourceDuration);
    const duration = info.duration ?? (Number.isFinite(hint) && hint > 0 ? hint : null);
    if (!duration) {
      throw new Error('The length of that file could not be determined, so it cannot be trimmed.');
    }
    if (start >= duration) {
      throw new Error('The start time is past the end of the file.');
    }

    const stop = Math.min(end, duration);
    const mode = payload.mode === 'encode' ? 'encode' : 'copy';
    const dir = await resolveOutputDir(info.dir);
    const outputPath = ffmpeg.uniqueOutputPath(
      dir,
      path.basename(filePath, info.ext),
      'trim',
      info.ext
    );

    const id = `edit-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
    const job = ffmpeg.createTrimJob({ id, info, start, end: stop, mode, outputPath });

    wireEditJob(job, event.sender, {
      id,
      title: `${path.basename(filePath, info.ext)} (trim)`,
      hasVideo: info.hasVideo,
      durationSec: stop - start,
    });

    editJobs.set(id, job);
    job.start();
    return { id, outputPath };
  });

  ipcMain.handle('edit:join', async (event, payload = {}) => {
    requireEditingTools();

    const list = Array.isArray(payload.filePaths) ? payload.filePaths : [];
    if (list.length < 2) throw new Error('Choose at least two files to join.');

    const infos = [];
    for (const candidate of list) {
      infos.push(await ffmpeg.probe(assertMediaFile(candidate)));
    }

    const compatibility = ffmpeg.joinCompatibility(infos);
    if (compatibility.fatal) throw new Error(compatibility.reason);

    // The UI offers copy mode only when the probe said it would work, but the
    // request could still arrive stale — fall back rather than write garbage.
    const mode = payload.mode === 'copy' && compatibility.compatible ? 'copy' : 'encode';

    const first = infos[0];
    const dir = await resolveOutputDir(first.dir);
    const outputPath = ffmpeg.uniqueOutputPath(
      dir,
      path.basename(first.filePath, first.ext),
      'joined',
      first.ext
    );

    const totalSec = infos.every((i) => i.duration)
      ? infos.reduce((sum, i) => sum + i.duration, 0)
      : null;

    const id = `edit-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
    const job = await ffmpeg.createJoinJob({ id, infos, mode, outputPath });

    wireEditJob(job, event.sender, {
      id,
      title: `${path.basename(first.filePath, first.ext)} (joined)`,
      hasVideo: first.hasVideo,
      durationSec: totalSec,
    });

    editJobs.set(id, job);
    job.start();
    return { id, outputPath, mode };
  });

  ipcMain.handle('edit:cancel', (_e, { id } = {}) => {
    const job = editJobs.get(id);
    if (!job) return false;
    job.cancel();
    return true;
  });

  /* ---- history ---------------------------------------------------------- */

  ipcMain.handle('history:list', () =>
    // Flag entries whose file has since been deleted or moved, so the UI can
    // grey them out instead of opening a dead path.
    store().getHistory().map((h) => ({
      ...h,
      exists: Boolean(h.filePath && fs.existsSync(h.filePath)),
    }))
  );

  ipcMain.handle('history:remove', (_e, { id } = {}) => store().removeHistory(id));
  ipcMain.handle('history:clear', () => store().clearHistory());

  /* ---- shell integration ------------------------------------------------ */

  ipcMain.handle('shell:openFolder', async (_e, { dir } = {}) => {
    const target = path.resolve(dir || store().getSettings().downloadDir);
    if (!fs.existsSync(target)) throw new Error('That folder no longer exists.');
    const error = await shell.openPath(target);
    if (error) throw new Error(error);
    return true;
  });

  ipcMain.handle('shell:revealFile', (_e, { filePath } = {}) => {
    const target = path.resolve(String(filePath || ''));
    if (!fs.existsSync(target)) throw new Error('That file no longer exists.');
    shell.showItemInFolder(target);
    return true;
  });

  ipcMain.handle('shell:openFile', async (_e, { filePath } = {}) => {
    const target = path.resolve(String(filePath || ''));
    if (!fs.existsSync(target)) throw new Error('That file no longer exists.');
    const error = await shell.openPath(target);
    if (error) throw new Error(error);
    return true;
  });

  ipcMain.handle('shell:openExternal', async (_e, { url } = {}) => {
    await shell.openExternal(assertHttpUrl(url));
    return true;
  });
}

/**
 * Forward a trim/join job's events to the renderer and file the result in the
 * library, so an edited clip is reachable from the same list as a download.
 * @param {import('./ffmpeg').MediaJob} job
 * @param {Electron.WebContents} sender
 * @param {{id:string, title:string, hasVideo:boolean, durationSec:number|null}} meta
 */
function wireEditJob(job, sender, meta) {
  const { id } = meta;

  job.on('progress', (p) => send(sender, 'edit:progress', { id, ...p }));
  job.on('log', (line) => send(sender, 'edit:log', { id, line }));

  job.on('error', (err) => {
    editJobs.delete(id);
    send(sender, 'edit:error', { id, message: err.message, detail: err.detail || null });
  });

  job.on('done', async ({ filePath, canceled }) => {
    editJobs.delete(id);

    if (canceled) return send(sender, 'edit:canceled', { id });

    let sizeBytes = null;
    try {
      if (filePath) sizeBytes = (await fsp.stat(filePath)).size;
    } catch {
      /* the user may already have moved it */
    }

    const record = store().addHistory({
      title: meta.title,
      url: null,
      filePath,
      thumbnail: null,
      format: meta.hasVideo ? 'video' : 'audio',
      quality: 'best',
      sizeBytes,
      durationSec: meta.durationSec,
    });

    send(sender, 'edit:done', { id, record });
  });
}

/** Kill any running download or edit so the app can exit cleanly. */
function cancelAllJobs() {
  for (const job of jobs.values()) job.cancel();
  jobs.clear();
  for (const job of editJobs.values()) job.cancel();
  editJobs.clear();
}

module.exports = { registerIpc, cancelAllJobs, jobs, editJobs };
