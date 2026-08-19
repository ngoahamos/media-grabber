'use strict';

/**
 * Thin, typed wrapper around the `yt-dlp` CLI.
 *
 * Everything the app knows about yt-dlp lives here: argument construction,
 * process spawning, stdout/stderr line parsing and error translation.
 * The rest of the main process only deals with plain JS objects and events.
 */

const { spawn, execFile } = require('node:child_process');
const { EventEmitter } = require('node:events');
const path = require('node:path');

const { ytDlpPath, ffmpegPath } = require('./binaries');

/* -------------------------------------------------------------------------- */
/* Machine-readable output markers                                            */
/* -------------------------------------------------------------------------- */

// yt-dlp lets us define the exact shape of its progress lines. Using unique
// sentinels means we never have to regex-scrape the human-facing output.
const PROGRESS_TAG = '@@PROGRESS@@';
const POST_TAG = '@@POST@@';
const FILE_TAG = '@@FILE@@';

// `filename` comes last because it is the only field that could itself contain
// the "|" separator — the parser re-joins everything past field 5.
const PROGRESS_TEMPLATE =
  `download:${PROGRESS_TAG}%(progress.status)s|%(progress.downloaded_bytes)s|` +
  '%(progress.total_bytes)s|%(progress.total_bytes_estimate)s|' +
  '%(progress.speed)s|%(progress.eta)s|%(progress.filename)s';

const POST_TEMPLATE = `postprocess:${POST_TAG}%(progress.status)s|%(progress.postprocessor)s`;

/* -------------------------------------------------------------------------- */
/* Shared argument helpers                                                    */
/* -------------------------------------------------------------------------- */

/**
 * Flags applied to every yt-dlp invocation.
 * `--ignore-config` matters: a user's global yt-dlp config could otherwise
 * inject options that break our output parsing.
 */
function baseArgs() {
  return [
    '--ignore-config',
    '--no-colors',
    '--no-playlist',
    '--socket-timeout', '20',
    '--retries', '10',
    '--fragment-retries', '10',
  ];
}

/**
 * Cookie flags. Some sites (Facebook, age-gated or members-only YouTube) only
 * serve media to a logged-in session; yt-dlp can borrow one from a local browser.
 * @param {{useCookies?: boolean, cookieBrowser?: string, cookieFile?: string}} opts
 */
function cookieArgs(opts = {}) {
  if (!opts.useCookies) return [];
  if (opts.cookieFile) return ['--cookies', opts.cookieFile];
  return ['--cookies-from-browser', opts.cookieBrowser || 'chrome'];
}

/**
 * Format selection.
 *
 * video: pick the best video + best audio pair (falling back to a pre-muxed
 *        stream), preferring mp4/m4a so the merge is a fast remux.
 * audio: pick the best audio-only stream and let ffmpeg transcode it to mp3.
 *
 * @param {'video'|'audio'} format
 * @param {'best'|'1080'|'720'|'480'} quality
 * @returns {string[]}
 */
function formatArgs(format, quality) {
  if (format === 'audio') {
    return [
      '-f', 'ba/b',
      '--extract-audio',
      '--audio-format', 'mp3',
      '--audio-quality', '0',   // 0 = best VBR
      '--embed-metadata',
    ];
  }

  const cap = quality && quality !== 'best' ? Number(quality) : null;
  const selector = cap
    ? `bv*[height<=${cap}]+ba/b[height<=${cap}]/bv*+ba/b`
    : 'bv*+ba/b';

  return [
    '-f', selector,
    // Prefer mp4 video / m4a audio so merging avoids a re-encode.
    '-S', 'ext:mp4:m4a',
    '--merge-output-format', 'mp4',
    '--embed-metadata',
  ];
}

/** ffmpeg is needed for merging video+audio and for mp3 extraction. */
function ffmpegArgs() {
  const ff = ffmpegPath();
  // Pass the *directory*: yt-dlp looks for both ffmpeg and ffprobe there.
  return ff ? ['--ffmpeg-location', path.dirname(ff)] : [];
}

/** Throws a friendly error when the binary was never installed. */
function requireYtDlp() {
  const bin = ytDlpPath();
  if (!bin) {
    const err = new Error(
      'yt-dlp was not found. Run "npm run setup:binaries" or drop the binary into the bin/ folder.'
    );
    err.code = 'YTDLP_MISSING';
    throw err;
  }
  return bin;
}

/* -------------------------------------------------------------------------- */
/* Error translation                                                          */
/* -------------------------------------------------------------------------- */

/**
 * Maps raw yt-dlp stderr onto a short, actionable message for the UI.
 * Falls back to the last real ERROR line so nothing is ever swallowed.
 * @param {string} stderr
 * @returns {string}
 */
function friendlyError(stderr) {
  const text = (stderr || '').trim();
  const rules = [
    [/Unsupported URL/i, 'That link is not supported. Check the URL and try again.'],
    [/is not a valid URL|Unable to extract|Unable to download webpage/i,
      'Could not read that page. The link may be wrong, private, or region-blocked.'],
    [/Sign in to confirm|confirm you.?re not a bot|Private video|members-only|login required|requires authentication/i,
      'This video needs a signed-in session. Turn on "Use browser cookies" and pick the browser you are logged into.'],
    [/Video unavailable|has been removed|no longer available/i, 'The video is unavailable or has been removed.'],
    [/This live event will begin|is live|premieres in/i, 'This is a live or upcoming stream and cannot be downloaded yet.'],
    [/Requested format is not available/i,
      'That quality is not available for this video. Try "Best" instead.'],
    [/ffmpeg (is )?not (found|installed)|ffprobe.*not found/i,
      'ffmpeg is missing. Run "npm run setup:binaries" or install ffmpeg to merge video and audio.'],
    [/No space left on device|ENOSPC/i, 'The disk is full — free up space and try again.'],
    [/Permission denied|EACCES|EPERM/i, 'Permission denied writing to the download folder. Choose a different folder.'],
    [/getaddrinfo|ENOTFOUND|ECONNRESET|network is unreachable|timed out/i,
      'Network problem. Check your connection and try again.'],
    [/could not copy .* cookie database|unable to (open|read) .* cookies|Permission denied.*[Cc]ookies/i,
      'Could not read cookies from that browser. Close it completely, or pick another browser.'],
  ];

  for (const [pattern, message] of rules) {
    if (pattern.test(text)) return message;
  }

  const errLine = text
    .split(/\r?\n/)
    .reverse()
    .find((l) => /^\s*ERROR[:\s]/i.test(l));
  if (errLine) return errLine.replace(/^\s*ERROR[:\s]+/i, '').trim().slice(0, 300);

  return text.split(/\r?\n/).filter(Boolean).slice(-1)[0]?.slice(0, 300) || 'Download failed.';
}

/* -------------------------------------------------------------------------- */
/* Metadata                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * Fetch metadata for a URL without downloading anything (`-J` = dump JSON).
 *
 * @param {string} url
 * @param {{useCookies?: boolean, cookieBrowser?: string}} [opts]
 * @returns {Promise<{id:string,title:string,thumbnail:string|null,duration:number|null,
 *                    uploader:string|null,source:string|null,isLive:boolean,heights:number[],
 *                    webpageUrl:string}>}
 */
function analyze(url, opts = {}) {
  const bin = requireYtDlp();
  const args = [...baseArgs(), ...cookieArgs(opts), '--no-warnings', '-J', url];

  return new Promise((resolve, reject) => {
    execFile(
      bin,
      args,
      { maxBuffer: 64 * 1024 * 1024, timeout: 90_000, windowsHide: true },
      (err, stdout, stderr) => {
        if (err) {
          const e = new Error(friendlyError(stderr || err.message));
          e.detail = String(stderr || err.message).slice(-4000);
          return reject(e);
        }
        try {
          const info = JSON.parse(stdout);
          // Playlists still slip through occasionally — use the first entry.
          const item = info._type === 'playlist' && info.entries?.length ? info.entries[0] : info;

          const heights = [
            ...new Set(
              (item.formats || [])
                .map((f) => f.height)
                .filter((h) => Number.isFinite(h) && h > 0)
            ),
          ].sort((a, b) => b - a);

          resolve({
            id: item.id,
            title: item.title || 'Untitled',
            thumbnail: item.thumbnail || item.thumbnails?.at(-1)?.url || null,
            duration: Number.isFinite(item.duration) ? item.duration : null,
            uploader: item.uploader || item.channel || item.uploader_id || null,
            source: item.extractor_key || item.extractor || null,
            isLive: Boolean(item.is_live),
            heights,
            webpageUrl: item.webpage_url || url,
          });
        } catch (parseErr) {
          reject(new Error(`Could not read video info: ${parseErr.message}`));
        }
      }
    );
  });
}

/* -------------------------------------------------------------------------- */
/* Download job                                                               */
/* -------------------------------------------------------------------------- */

/**
 * A single running download.
 *
 * Events
 * ------
 * 'progress' → { percent, phase, speed, eta, downloaded, total }
 * 'log'      → string  (raw yt-dlp line, for the debug drawer)
 * 'done'     → { filePath, canceled }
 * 'error'    → Error
 */
class DownloadJob extends EventEmitter {
  /**
   * @param {{id:string, url:string, outputDir:string, format:'video'|'audio',
   *          quality?:string, useCookies?:boolean, cookieBrowser?:string}} opts
   */
  constructor(opts) {
    super();
    this.opts = opts;
    this.id = opts.id;
    this.child = null;
    this.canceled = false;
    this.filePath = null;
    this.stderrTail = [];

    // Progress is reported per *stream*. A merged mp4 downloads video then
    // audio, so we blend the two into one monotonic 0-100 bar.
    this.streamIndex = 0;
    this.expectedStreams = opts.format === 'audio' ? 1 : 2;
    this.currentFile = null;
  }

  /** Full argv for this job. */
  buildArgs() {
    const { url, outputDir, format, quality } = this.opts;
    // %(title).150B truncates on *bytes*, keeping paths under filesystem limits
    // even for titles full of multi-byte characters.
    const outputTemplate = path.join(outputDir, '%(title).150B [%(id)s].%(ext)s');

    return [
      ...baseArgs(),
      ...cookieArgs(this.opts),
      ...formatArgs(format, quality),
      ...ffmpegArgs(),
      '--newline',                       // one progress update per line
      '--progress',                      // keep progress even when not a TTY
      '--progress-template', PROGRESS_TEMPLATE,
      '--progress-template', POST_TEMPLATE,
      '--concurrent-fragments', '4',
      // --print implies --quiet *and* --simulate; undo both so the download
      // actually runs and yt-dlp's normal log lines still reach the UI.
      '--no-simulate',
      '--no-quiet',
      '--print', `after_move:${FILE_TAG}%(filepath)s`,
      '-o', outputTemplate,
      url,
    ];
  }

  /** Spawn yt-dlp and start streaming events. */
  start() {
    let bin;
    try {
      bin = requireYtDlp();
    } catch (err) {
      queueMicrotask(() => this.emit('error', err));
      return this;
    }

    this.child = spawn(bin, this.buildArgs(), { windowsHide: true });

    this.#pipeLines(this.child.stdout, (line) => this.#handleLine(line));
    this.#pipeLines(this.child.stderr, (line) => {
      // yt-dlp writes warnings *and* fatal errors here; keep a rolling tail.
      this.stderrTail.push(line);
      if (this.stderrTail.length > 80) this.stderrTail.shift();
      this.#handleLine(line);
    });

    this.child.on('error', (err) => {
      this.emit('error', new Error(`Could not start yt-dlp: ${err.message}`));
    });

    this.child.on('close', (code) => {
      if (this.canceled) return this.emit('done', { filePath: null, canceled: true });
      if (code === 0) {
        this.emit('progress', { percent: 100, phase: 'done' });
        return this.emit('done', { filePath: this.filePath, canceled: false });
      }
      const err = new Error(friendlyError(this.stderrTail.join('\n')));
      err.detail = this.stderrTail.join('\n').slice(-4000);
      err.exitCode = code;
      this.emit('error', err);
    });

    return this;
  }

  /** Split a stream into complete lines (yt-dlp also emits bare \r updates). */
  #pipeLines(stream, onLine) {
    let buffer = '';
    stream.setEncoding('utf8');
    stream.on('data', (chunk) => {
      buffer += chunk;
      const parts = buffer.split(/\r\n|\n|\r/);
      buffer = parts.pop() ?? '';
      for (const line of parts) {
        if (line.trim()) onLine(line);
      }
    });
    stream.on('end', () => {
      if (buffer.trim()) onLine(buffer);
    });
  }

  /** Route one output line to the right handler. */
  #handleLine(line) {
    if (line.includes(PROGRESS_TAG)) return this.#handleProgress(line);
    if (line.includes(POST_TAG)) return this.#handlePostProcess(line);

    if (line.includes(FILE_TAG)) {
      this.filePath = line.slice(line.indexOf(FILE_TAG) + FILE_TAG.length).trim();
      return;
    }

    // Fall back to yt-dlp's own final path lines when --print gave us nothing
    // (happens when a file was already downloaded, or after a remux).
    const merged = line.match(/\[Merger\] Merging formats into "(.+)"/)
      || line.match(/\[ExtractAudio\] Destination: (.+)/)
      || line.match(/\[download\] (.+) has already been downloaded/);
    if (merged) this.filePath = merged[1].trim();

    this.emit('log', line);
  }

  /** `@@PROGRESS@@status|downloaded|total|totalEstimate|speed|eta|filename` */
  #handleProgress(line) {
    const raw = line.slice(line.indexOf(PROGRESS_TAG) + PROGRESS_TAG.length);
    const parts = raw.split('|');
    const [status, downloaded, total, totalEst, speed, eta] = parts;
    const filename = parts.slice(6).join('|');

    // A merged mp4 downloads video and audio as two separate files. A change of
    // filename is the signal that yt-dlp moved on to the next stream.
    if (filename && filename !== 'NA' && filename !== this.currentFile) {
      if (this.currentFile !== null) this.streamIndex += 1;
      this.currentFile = filename;
      // More streams than we assumed? Widen the scale so the bar never exceeds 100%.
      if (this.streamIndex >= this.expectedStreams) {
        this.expectedStreams = this.streamIndex + 1;
      }
    }

    const num = (v) => {
      const n = Number(v);
      return Number.isFinite(n) && v !== 'NA' && v !== '' ? n : null;
    };

    const got = num(downloaded);
    const size = num(total) ?? num(totalEst);
    const fraction = size && got != null ? Math.min(got / size, 1) : 0;

    // Blend the current stream's fraction into the overall bar.
    const overall = ((this.streamIndex + fraction) / this.expectedStreams) * 100;

    this.emit('progress', {
      percent: Math.max(0, Math.min(99.5, overall)),
      phase: this.expectedStreams > 1 && this.streamIndex === 0 ? 'video'
        : this.opts.format === 'audio' ? 'audio' : 'audio-track',
      status,
      speed: num(speed),
      eta: num(eta),
      downloaded: got,
      total: size,
    });
  }

  /** `@@POST@@status|postprocessor` — merging / transcoding, no byte counts. */
  #handlePostProcess(line) {
    const raw = line.slice(line.indexOf(POST_TAG) + POST_TAG.length);
    const [status, processor] = raw.split('|');
    if (status === 'finished') return;
    this.emit('progress', {
      percent: 99.5,
      phase: 'processing',
      processor: processor && processor !== 'NA' ? processor : null,
    });
  }

  /**
   * Stop the download. yt-dlp spawns ffmpeg as a child, so on Windows we kill
   * the whole tree; POSIX gets SIGTERM with a SIGKILL safety net.
   */
  cancel() {
    if (!this.child || this.canceled) return;
    this.canceled = true;

    if (process.platform === 'win32') {
      spawn('taskkill', ['/pid', String(this.child.pid), '/T', '/F'], { windowsHide: true });
    } else {
      this.child.kill('SIGTERM');
      setTimeout(() => {
        if (this.child && this.child.exitCode === null) this.child.kill('SIGKILL');
      }, 3000).unref();
    }
  }
}

module.exports = { analyze, DownloadJob, friendlyError };
