#!/usr/bin/env node
'use strict';

/**
 * Downloads the `yt-dlp` and `ffmpeg` binaries this app ships with.
 *
 *   node scripts/setup-binaries.js                 # current platform
 *   node scripts/setup-binaries.js --platform win32,darwin,linux
 *   node scripts/setup-binaries.js --only ffmpeg   # just one tool
 *   node scripts/setup-binaries.js --force         # re-download existing files
 *
 * Files land in bin/<platform>/, which electron-builder copies into the packaged
 * app as `resources/bin` (see the `extraResources` entries in package.json).
 *
 * Sources
 *  - yt-dlp : official GitHub releases (self-contained, no Python needed)
 *  - ffmpeg : yt-dlp's own FFmpeg-Builds for Windows/Linux, evermeet.cx for macOS
 */

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const https = require('node:https');
const { execFileSync } = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const BIN = path.join(ROOT, 'bin');
const TMP = path.join(os.tmpdir(), 'media-grabber-binaries');

const YTDLP = 'https://github.com/yt-dlp/yt-dlp/releases/latest/download';
const FFBUILDS = 'https://github.com/yt-dlp/FFmpeg-Builds/releases/download/latest';

/**
 * Per-platform download plan.
 * `archive` entries are unpacked and the listed members are pulled out by
 * basename; `direct` entries are saved as-is.
 */
const PLAN = {
  win32: {
    'yt-dlp': { type: 'direct', url: `${YTDLP}/yt-dlp.exe`, out: 'yt-dlp.exe' },
    ffmpeg: {
      type: 'archive',
      url: `${FFBUILDS}/ffmpeg-master-latest-win64-gpl.zip`,
      members: ['ffmpeg.exe', 'ffprobe.exe'],
    },
  },
  darwin: {
    'yt-dlp': { type: 'direct', url: `${YTDLP}/yt-dlp_macos`, out: 'yt-dlp' },
    ffmpeg: {
      type: 'archive',
      url: 'https://evermeet.cx/ffmpeg/getrelease/ffmpeg/zip',
      members: ['ffmpeg'],
    },
    ffprobe: {
      type: 'archive',
      url: 'https://evermeet.cx/ffmpeg/getrelease/ffprobe/zip',
      members: ['ffprobe'],
    },
  },
  linux: {
    'yt-dlp': { type: 'direct', url: `${YTDLP}/yt-dlp_linux`, out: 'yt-dlp' },
    ffmpeg: {
      type: 'archive',
      url: `${FFBUILDS}/ffmpeg-master-latest-linux64-gpl.tar.xz`,
      members: ['ffmpeg', 'ffprobe'],
    },
  },
};

/* -------------------------------------------------------------------------- */
/* CLI args                                                                   */
/* -------------------------------------------------------------------------- */

function parseArgs(argv) {
  const args = { platforms: [process.platform], only: null, force: false };
  for (let i = 0; i < argv.length; i += 1) {
    const [flag, inline] = argv[i].split('=');
    const value = inline ?? argv[i + 1];
    if (flag === '--platform') { args.platforms = value.split(','); if (!inline) i += 1; }
    else if (flag === '--only') { args.only = value; if (!inline) i += 1; }
    else if (flag === '--force') args.force = true;
  }
  return args;
}

/* -------------------------------------------------------------------------- */
/* Download                                                                   */
/* -------------------------------------------------------------------------- */

const log = (...a) => console.log(...a);

/** GET with redirect following and a simple progress readout. */
function download(url, dest, redirects = 0) {
  return new Promise((resolve, reject) => {
    if (redirects > 8) return reject(new Error('Too many redirects'));

    https
      .get(url, { headers: { 'User-Agent': 'media-grabber-setup' } }, (res) => {
        if ([301, 302, 303, 307, 308].includes(res.statusCode)) {
          res.resume();
          return resolve(download(new URL(res.headers.location, url).toString(), dest, redirects + 1));
        }
        if (res.statusCode !== 200) {
          res.resume();
          return reject(new Error(`HTTP ${res.statusCode} for ${url}`));
        }

        const total = Number(res.headers['content-length']) || 0;
        let received = 0;
        let lastPrint = 0;
        // Only animate when attached to a terminal; piped output stays clean.
        const tty = process.stdout.isTTY;

        const file = fs.createWriteStream(dest);
        res.on('data', (chunk) => {
          received += chunk.length;
          if (!tty) return;
          const now = Date.now();
          if (now - lastPrint > 250) {
            lastPrint = now;
            const mb = (received / 1048576).toFixed(1);
            const pct = total ? ` (${((received / total) * 100).toFixed(0)}%)` : '';
            process.stdout.write(`\r    ${mb} MB${pct}      `);
          }
        });
        res.pipe(file);
        file.on('finish', () =>
          file.close(() => {
            if (tty) process.stdout.write('\r'.padEnd(30) + '\r');
            resolve(dest);
          })
        );
        file.on('error', reject);
      })
      .on('error', reject);
  });
}

/* -------------------------------------------------------------------------- */
/* Extraction                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * Unpack an archive into `dir`.
 * Windows 10+ and macOS both ship bsdtar, which reads zip and tar.xz alike;
 * on Linux we prefer tar for .tar.xz and fall back to unzip for .zip.
 */
function extract(archive, dir) {
  const isZip = archive.endsWith('.zip');
  try {
    if (isZip && process.platform === 'linux') {
      execFileSync('unzip', ['-o', '-q', archive, '-d', dir], { stdio: 'inherit' });
    } else {
      execFileSync('tar', ['-xf', archive, '-C', dir], { stdio: 'inherit' });
    }
  } catch (err) {
    throw new Error(
      `Could not unpack ${path.basename(archive)}: ${err.message}\n` +
      '    Extract it by hand and copy the binaries into the bin/ folder instead.'
    );
  }
}

/** Recursively find a file by basename inside an extracted archive. */
function findFile(dir, name) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      const hit = findFile(full, name);
      if (hit) return hit;
    } else if (entry.name === name) {
      return full;
    }
  }
  return null;
}

/* -------------------------------------------------------------------------- */
/* Main                                                                       */
/* -------------------------------------------------------------------------- */

/**
 * Ad-hoc code-sign the macOS binaries (`codesign --sign -`).
 *
 * Apple Silicon refuses to execute an unsigned arm64 binary, and an unsigned
 * helper inside a signed .app trips the hardened runtime. Real distribution
 * still needs your own Developer ID signature — electron-builder applies that
 * during `npm run build:mac`. Best-effort: skipped when codesign is absent.
 */
function adhocSign(dir) {
  if (!fs.existsSync(dir)) return;
  const files = fs.readdirSync(dir).filter((f) => !f.startsWith('.'));
  for (const file of files) {
    try {
      execFileSync('codesign', ['--force', '--sign', '-', path.join(dir, file)], { stdio: 'pipe' });
    } catch (err) {
      log(`  ! could not sign ${file}: ${String(err.stderr || err.message).trim().slice(0, 120)}`);
    }
  }
  if (files.length) log(`  ✓ ad-hoc signed ${files.length} binaries`);
}

/** `--only ffmpeg` also pulls ffprobe, since yt-dlp needs both. */
function matchesOnly(tool, only) {
  if (!only) return true;
  if (tool === only) return true;
  return only === 'ffmpeg' && tool === 'ffprobe';
}

async function fetchTool(platform, tool, spec, force) {
  const targetDir = path.join(BIN, platform);
  await fsp.mkdir(targetDir, { recursive: true });

  const expected = spec.type === 'direct' ? [spec.out] : spec.members;
  const allPresent = expected.every((name) => fs.existsSync(path.join(targetDir, name)));
  if (allPresent && !force) {
    log(`  ✓ ${tool} already present (--force to re-download)`);
    return;
  }

  log(`  ↓ ${tool} — ${spec.url}`);
  await fsp.mkdir(TMP, { recursive: true });

  if (spec.type === 'direct') {
    const dest = path.join(targetDir, spec.out);
    await download(spec.url, dest);
    if (platform !== 'win32') await fsp.chmod(dest, 0o755);
    log(`  ✓ ${spec.out}`);
    return;
  }

  // Archive: download to temp, unpack, lift out the members we care about.
  const isTar = spec.url.includes('.tar.');
  const archive = path.join(TMP, `${platform}-${tool}${isTar ? '.tar.xz' : '.zip'}`);
  await download(spec.url, archive);

  const workDir = path.join(TMP, `${platform}-${tool}-x`);
  await fsp.rm(workDir, { recursive: true, force: true });
  await fsp.mkdir(workDir, { recursive: true });
  extract(archive, workDir);

  for (const member of spec.members) {
    const found = findFile(workDir, member);
    if (!found) {
      log(`  ! ${member} not found inside the archive — copy it manually`);
      continue;
    }
    const dest = path.join(targetDir, member);
    await fsp.copyFile(found, dest);
    if (platform !== 'win32') await fsp.chmod(dest, 0o755);
    log(`  ✓ ${member}`);
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  log('Media Grabber — binary setup\n');

  for (const platform of args.platforms) {
    const plan = PLAN[platform];
    if (!plan) {
      log(`! Unknown platform "${platform}" (expected win32, darwin or linux)`);
      continue;
    }

    log(`▸ ${platform} → bin/${platform}`);

    for (const [tool, spec] of Object.entries(plan)) {
      if (!matchesOnly(tool, args.only)) continue;
      try {
        await fetchTool(platform, tool, spec, args.force);
      } catch (err) {
        log(`  ✗ ${tool}: ${err.message}`);
      }
    }

    if (platform === 'darwin' && process.platform === 'darwin') {
      adhocSign(path.join(BIN, 'darwin'));
    }

    if (platform === 'darwin' && os.arch() === 'arm64') {
      log('  ℹ evermeet.cx ships x86_64 ffmpeg; it runs on Apple Silicon under Rosetta.');
      log('    For a native arm64 build: brew install ffmpeg && cp "$(brew --prefix)/bin/ffmpeg" bin/darwin/');
    }
    log('');
  }

  await fsp.rm(TMP, { recursive: true, force: true });
  log('Done. Run "npm start" to launch the app.');
}

main().catch((err) => {
  console.error('\nSetup failed:', err.message);
  process.exit(1);
});
