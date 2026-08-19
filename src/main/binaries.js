'use strict';

/**
 * Resolves the on-disk location of the bundled `yt-dlp` and `ffmpeg` binaries.
 *
 * Layout on disk
 * --------------
 * Development:  <project>/bin/<platform>/<binary>
 * Packaged:     <resourcesPath>/bin/<binary>
 *
 * electron-builder copies only the *current* platform's folder into the app
 * bundle (see the `extraResources` entries in package.json), which is why the
 * packaged layout has no per-platform sub-directory.
 */

const fs = require('node:fs');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { app } = require('electron');

/** `.exe` on Windows, no extension anywhere else. */
const EXE = process.platform === 'win32' ? '.exe' : '';

/**
 * Root folder that holds the binaries for the platform we are running on.
 * @returns {string}
 */
function binDir() {
  if (app.isPackaged) {
    // `process.resourcesPath` points at Contents/Resources (mac) or
    // resources\ (win/linux) inside the packaged app.
    return path.join(process.resourcesPath, 'bin');
  }
  return path.join(app.getAppPath(), 'bin', process.platform);
}

/**
 * Absolute path to a bundled binary, whether or not it actually exists.
 * @param {'yt-dlp'|'ffmpeg'|'ffprobe'} name
 * @returns {string}
 */
function bundledPath(name) {
  return path.join(binDir(), name + EXE);
}

/**
 * Looks the binary up on the user's PATH as a fallback, so the app still works
 * for developers who have `yt-dlp`/`ffmpeg` installed system-wide (e.g. via
 * Homebrew, winget or apt) and have not populated `bin/` yet.
 * @param {string} name
 * @returns {string|null}
 */
function fromPath(name) {
  const exe = name + EXE;
  const dirs = (process.env.PATH || '').split(path.delimiter).filter(Boolean);
  for (const dir of dirs) {
    const candidate = path.join(dir, exe);
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      return candidate;
    } catch {
      /* keep looking */
    }
  }
  return null;
}

/**
 * Resolve a binary: bundled copy first, PATH second.
 * @param {'yt-dlp'|'ffmpeg'|'ffprobe'} name
 * @returns {{ path: string|null, source: 'bundled'|'path'|'missing' }}
 */
function resolve(name) {
  const bundled = bundledPath(name);
  if (fs.existsSync(bundled)) {
    ensureExecutable(bundled);
    return { path: bundled, source: 'bundled' };
  }
  const onPath = fromPath(name);
  if (onPath) return { path: onPath, source: 'path' };
  return { path: null, source: 'missing' };
}

/**
 * git/zip archives frequently lose the executable bit on macOS and Linux.
 * Restore it silently rather than failing at spawn time with EACCES.
 * @param {string} file
 */
function ensureExecutable(file) {
  if (process.platform === 'win32') return;
  try {
    const mode = fs.statSync(file).mode;
    // 0o111 == owner/group/other execute bits
    if ((mode & 0o111) !== 0o111) fs.chmodSync(file, mode | 0o111);
  } catch {
    /* non-fatal: spawn will surface a clearer error */
  }
}

/** @returns {string|null} absolute path to yt-dlp, or null when unavailable. */
function ytDlpPath() {
  return resolve('yt-dlp').path;
}

/** @returns {string|null} absolute path to ffmpeg, or null when unavailable. */
function ffmpegPath() {
  return resolve('ffmpeg').path;
}

/**
 * Health report shown in the app's status strip.
 *
 * Deliberately does *not* execute anything: a tool is "available" when it is
 * present and executable. Running it just to read a version number would make
 * startup hostage to how fast that binary happens to launch — the PyInstaller
 * yt-dlp build can take tens of seconds to import its extractors on some
 * machines, and a slow probe must never be reported as a missing tool.
 *
 * @returns {{ytDlp: object, ffmpeg: object, ffprobe: object, binDir: string}}
 */
function status() {
  const ytDlp = resolve('yt-dlp');
  const ffmpeg = resolve('ffmpeg');
  const ffprobe = resolve('ffprobe');

  return {
    binDir: binDir(),
    ytDlp: { ...ytDlp, ok: Boolean(ytDlp.path) },
    ffmpeg: { ...ffmpeg, ok: Boolean(ffmpeg.path) },
    ffprobe: { ...ffprobe, ok: Boolean(ffprobe.path) },
  };
}

/**
 * Ask a binary for its version string. Best-effort decoration for the UI only —
 * a null result means "could not tell", never "not installed".
 * @param {string} file
 * @param {string[]} args
 * @returns {Promise<string|null>}
 */
function probeVersion(file, args) {
  return new Promise((done) => {
    execFile(file, args, { timeout: 90_000, windowsHide: true }, (err, stdout, stderr) => {
      if (err) return done(null);
      const line = String(stdout || stderr).trim().split(/\r?\n/)[0] || '';
      done(line.slice(0, 120) || null);
    });
  });
}

/**
 * Version strings for the resolved binaries, fetched in the background after
 * the window is already usable.
 * @returns {Promise<{ytDlp: string|null, ffmpeg: string|null}>}
 */
async function versions() {
  const ytDlp = ytDlpPath();
  const ffmpeg = ffmpegPath();

  const [ytVersion, ffVersion] = await Promise.all([
    ytDlp ? probeVersion(ytDlp, ['--version']) : Promise.resolve(null),
    ffmpeg ? probeVersion(ffmpeg, ['-version']) : Promise.resolve(null),
  ]);

  return { ytDlp: ytVersion, ffmpeg: ffVersion };
}

module.exports = { binDir, bundledPath, resolve, ytDlpPath, ffmpegPath, status, versions };
