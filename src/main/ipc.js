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
const { ipcMain, dialog, shell, app, BrowserWindow } = require('electron');

const binaries = require('./binaries');
const { store } = require('./store');
const { analyze, DownloadJob } = require('./ytdlp');

/** @type {Map<string, DownloadJob>} in-flight downloads, keyed by job id. */
const jobs = new Map();

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

/** Kill any running download so the app can exit cleanly. */
function cancelAllJobs() {
  for (const job of jobs.values()) job.cancel();
  jobs.clear();
}

module.exports = { registerIpc, cancelAllJobs, jobs };
