'use strict';

/**
 * Thin, typed wrapper around the `ffmpeg` / `ffprobe` CLIs for local editing.
 *
 * Mirrors ./ytdlp.js: argument construction, process spawning, progress parsing
 * and error translation all live here, and the rest of the main process only
 * ever sees plain objects and events.
 *
 * Two operations are supported:
 *   trim — cut one file down to a [start, end) range
 *   join — concatenate several files into one
 *
 * Both run in one of two modes:
 *   copy   — stream copy. Near-instant, no quality loss, but a trim can only
 *            start on a keyframe and a join needs identical stream parameters.
 *   encode — full re-encode. Frame-accurate and format-agnostic, but slow.
 */

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { spawn, execFile } = require('node:child_process');
const { EventEmitter } = require('node:events');

const { ffmpegPath, ffprobePath } = require('./binaries');

/** Container extensions we are willing to open or write. */
const MEDIA_EXTENSIONS = [
  'mp4', 'm4v', 'mov', 'mkv', 'webm', 'avi', 'flv', 'ts', 'm2ts', 'wmv', '3gp',
  'mp3', 'm4a', 'aac', 'wav', 'flac', 'ogg', 'opus', 'wma', 'aiff',
];

/* -------------------------------------------------------------------------- */
/* Binary guards                                                              */
/* -------------------------------------------------------------------------- */

/** Throws a friendly error when ffmpeg was never installed. */
function requireFfmpeg() {
  const bin = ffmpegPath();
  if (!bin) {
    const err = new Error(
      'ffmpeg was not found. Run "npm run setup:binaries" or drop the binary into the bin/ folder.'
    );
    err.code = 'FFMPEG_MISSING';
    throw err;
  }
  return bin;
}

/** Throws a friendly error when ffprobe was never installed. */
function requireFfprobe() {
  const bin = ffprobePath();
  if (!bin) {
    const err = new Error(
      'ffprobe was not found. It ships alongside ffmpeg — run "npm run setup:binaries".'
    );
    err.code = 'FFPROBE_MISSING';
    throw err;
  }
  return bin;
}

/* -------------------------------------------------------------------------- */
/* Error translation                                                          */
/* -------------------------------------------------------------------------- */

/**
 * Maps raw ffmpeg stderr onto a short, actionable message for the UI.
 * @param {string} stderr
 * @returns {string}
 */
function friendlyError(stderr) {
  const text = (stderr || '').trim();
  const rules = [
    [/Unknown encoder|Encoder .* not found|not compiled in/i,
      'This ffmpeg build is missing the encoder needed for that format. Try the fast (no re-encode) mode instead.'],
    [/Invalid data found when processing input|moov atom not found|could not find codec parameters/i,
      'That file could not be read — it may be incomplete or not a media file.'],
    [/No such file or directory|does not contain any stream/i,
      'One of the input files is missing or has no audio or video in it.'],
    [/No space left on device|ENOSPC/i, 'The disk is full — free up space and try again.'],
    [/Permission denied|EACCES|EPERM/i,
      'Permission denied writing the output file. Choose a different folder.'],
    [/Output file is empty|Output file #0 does not contain any stream/i,
      'The result came out empty. Check that the start time is before the end time.'],
    [/do not match the corresponding output|Input link .* parameters .* do not match/i,
      'These files have different formats and cannot be joined by copying. Switch to re-encode mode.'],
    [/Codec type or id mismatches|Stream mapping.*failed|Cannot determine format/i,
      'These files are not compatible with a fast join. Switch to re-encode mode.'],
  ];

  for (const [pattern, message] of rules) {
    if (pattern.test(text)) return message;
  }

  // ffmpeg's own last non-empty line is usually the real diagnosis.
  const last = text.split(/\r?\n/).filter((l) => l.trim()).pop();
  return last ? last.slice(0, 300) : 'The operation failed.';
}

/* -------------------------------------------------------------------------- */
/* Probing                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * Read a file's duration and stream layout.
 *
 * @param {string} filePath
 * @returns {Promise<{filePath:string, name:string, dir:string, ext:string,
 *                    sizeBytes:number|null, duration:number|null, formatName:string|null,
 *                    hasVideo:boolean, hasAudio:boolean,
 *                    video:{codec:string,width:number|null,height:number|null,pixFmt:string|null,fps:number|null}|null,
 *                    audio:{codec:string,sampleRate:number|null,channels:number|null}|null}>}
 */
function probe(filePath) {
  const bin = requireFfprobe();
  const args = [
    '-v', 'error',
    '-print_format', 'json',
    '-show_format',
    '-show_streams',
    filePath,
  ];

  return new Promise((resolve, reject) => {
    execFile(
      bin,
      args,
      { maxBuffer: 16 * 1024 * 1024, timeout: 60_000, windowsHide: true },
      (err, stdout, stderr) => {
        if (err) {
          const e = new Error(friendlyError(stderr || err.message));
          e.detail = String(stderr || err.message).slice(-4000);
          return reject(e);
        }

        let info;
        try {
          info = JSON.parse(stdout);
        } catch (parseErr) {
          return reject(new Error(`Could not read that file: ${parseErr.message}`));
        }

        const streams = Array.isArray(info.streams) ? info.streams : [];
        // Skip cover art: it is tagged as a video stream but is a still image.
        const v = streams.find(
          (s) => s.codec_type === 'video' && !s.disposition?.attached_pic
        );
        const a = streams.find((s) => s.codec_type === 'audio');

        const num = (value) => {
          const n = Number(value);
          return Number.isFinite(n) ? n : null;
        };

        // "30000/1001" → 29.97
        const parseRate = (value) => {
          if (typeof value !== 'string' || !value.includes('/')) return num(value);
          const [n, d] = value.split('/').map(Number);
          return d ? Number((n / d).toFixed(3)) : null;
        };

        // Some containers only carry a duration on the stream, not the format.
        const duration =
          num(info.format?.duration) ?? num(v?.duration) ?? num(a?.duration);

        resolve({
          filePath,
          name: path.basename(filePath),
          dir: path.dirname(filePath),
          ext: path.extname(filePath).toLowerCase(),
          sizeBytes: num(info.format?.size),
          duration: duration && duration > 0 ? duration : null,
          formatName: info.format?.format_name || null,
          hasVideo: Boolean(v),
          hasAudio: Boolean(a),
          video: v
            ? {
                codec: v.codec_name || 'unknown',
                width: num(v.width),
                height: num(v.height),
                pixFmt: v.pix_fmt || null,
                fps: parseRate(v.r_frame_rate),
              }
            : null,
          audio: a
            ? {
                codec: a.codec_name || 'unknown',
                sampleRate: num(a.sample_rate),
                channels: num(a.channels),
              }
            : null,
        });
      }
    );
  });
}

/* -------------------------------------------------------------------------- */
/* Join compatibility                                                         */
/* -------------------------------------------------------------------------- */

/**
 * Decide whether a set of files can be concatenated by copying streams.
 *
 * The concat demuxer requires every input to have the same codecs and the same
 * decode parameters — otherwise the output plays back as garbage after the
 * first file, so we would rather re-encode than produce a broken file.
 *
 * @param {object[]} infos results of `probe()`, in join order
 * @returns {{compatible:boolean, reason:string|null}}
 */
function joinCompatibility(infos) {
  if (infos.length < 2) return { compatible: false, reason: 'Add at least two files.' };

  const shapes = infos.map((i) => `${i.hasVideo ? 'v' : ''}${i.hasAudio ? 'a' : ''}`);
  if (new Set(shapes).size > 1) {
    return {
      compatible: false,
      reason: 'Some files have video and some do not — they cannot be joined together.',
      fatal: true,
    };
  }
  if (shapes[0] === '') {
    return { compatible: false, reason: 'These files have no audio or video streams.', fatal: true };
  }

  const signature = (i) =>
    JSON.stringify({
      v: i.video ? [i.video.codec, i.video.width, i.video.height, i.video.pixFmt] : null,
      a: i.audio ? [i.audio.codec, i.audio.sampleRate, i.audio.channels] : null,
    });

  const first = signature(infos[0]);
  const mismatch = infos.findIndex((i) => signature(i) !== first);
  if (mismatch !== -1) {
    return {
      compatible: false,
      reason: `"${infos[mismatch].name}" uses different codecs or dimensions from the first file.`,
    };
  }

  return { compatible: true, reason: null };
}

/* -------------------------------------------------------------------------- */
/* Argument helpers                                                           */
/* -------------------------------------------------------------------------- */

/** Flags applied to every ffmpeg invocation. */
function baseArgs() {
  return [
    '-hide_banner',
    '-nostdin',        // never block waiting on a terminal we do not have
    '-loglevel', 'error',
    '-y',              // the output path is uniquified before we get here
  ];
}

/** Machine-readable progress on stdout, one `key=value` per line. */
function progressArgs() {
  return ['-progress', 'pipe:1', '-nostats'];
}

/**
 * Codec flags for a re-encode, chosen from the output container and whether
 * there is a video stream to carry.
 * @param {{hasVideo:boolean}} info
 * @param {string} ext output extension, lowercase, with the dot
 * @returns {string[]}
 */
function encodeArgs(info, ext) {
  if (!info.hasVideo) {
    if (ext === '.mp3') return ['-c:a', 'libmp3lame', '-q:a', '2'];
    if (ext === '.opus' || ext === '.ogg') return ['-c:a', 'libopus', '-b:a', '160k'];
    if (ext === '.flac') return ['-c:a', 'flac'];
    if (ext === '.wav') return ['-c:a', 'pcm_s16le'];
    return ['-c:a', 'aac', '-b:a', '192k'];
  }

  if (ext === '.webm') {
    return ['-c:v', 'libvpx-vp9', '-crf', '32', '-b:v', '0', '-c:a', 'libopus', '-b:a', '160k'];
  }

  const args = [
    '-c:v', 'libx264',
    '-preset', 'veryfast',
    '-crf', '20',
    '-pix_fmt', 'yuv420p',
    '-c:a', 'aac',
    '-b:a', '192k',
  ];
  // Put the index at the head of the file so the result starts playing instantly.
  if (['.mp4', '.m4v', '.mov'].includes(ext)) args.push('-movflags', '+faststart');
  return args;
}

/**
 * A free output path next to the source: "clip (trim).mp4", "clip (trim) 2.mp4", …
 * @param {string} dir
 * @param {string} base filename without extension
 * @param {string} suffix e.g. 'trim'
 * @param {string} ext with the dot
 * @returns {string}
 */
function uniqueOutputPath(dir, base, suffix, ext) {
  const stem = `${base} (${suffix})`;
  let candidate = path.join(dir, stem + ext);
  let n = 2;
  while (fs.existsSync(candidate)) {
    candidate = path.join(dir, `${stem} ${n}${ext}`);
    n += 1;
  }
  return candidate;
}

/* -------------------------------------------------------------------------- */
/* Media job                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * One running ffmpeg operation.
 *
 * Events
 * ------
 * 'progress' → { percent, phase, processedSec, totalSec, speed }
 * 'log'      → string  (raw ffmpeg line, for the debug drawer)
 * 'done'     → { filePath, canceled }
 * 'error'    → Error
 */
class MediaJob extends EventEmitter {
  /**
   * @param {{id:string, kind:'trim'|'join', args:string[], outputPath:string,
   *          totalSec:number|null, tempFiles?:string[]}} opts
   */
  constructor(opts) {
    super();
    this.id = opts.id;
    this.kind = opts.kind;
    this.args = opts.args;
    this.outputPath = opts.outputPath;
    this.totalSec = opts.totalSec && opts.totalSec > 0 ? opts.totalSec : null;
    this.tempFiles = opts.tempFiles || [];

    this.child = null;
    this.canceled = false;
    this.stderrTail = [];
    /** Encoding rate relative to realtime, as reported by -progress. */
    this.speed = null;
  }

  /** Spawn ffmpeg and start streaming events. */
  start() {
    let bin;
    try {
      bin = requireFfmpeg();
    } catch (err) {
      queueMicrotask(() => this.emit('error', err));
      return this;
    }

    this.emit('progress', { percent: 0, phase: this.kind });
    this.child = spawn(bin, this.args, { windowsHide: true });

    this.#pipeLines(this.child.stdout, (line) => this.#handleProgressLine(line));
    this.#pipeLines(this.child.stderr, (line) => {
      // -loglevel error means anything arriving here is worth keeping.
      this.stderrTail.push(line);
      if (this.stderrTail.length > 80) this.stderrTail.shift();
      this.emit('log', line);
    });

    this.child.on('error', (err) => {
      this.#cleanupTemp();
      this.emit('error', new Error(`Could not start ffmpeg: ${err.message}`));
    });

    this.child.on('close', (code) => {
      this.#cleanupTemp();

      if (this.canceled) {
        this.#discardOutput();
        return this.emit('done', { filePath: null, canceled: true });
      }

      if (code === 0) {
        this.emit('progress', { percent: 100, phase: 'done' });
        return this.emit('done', { filePath: this.outputPath, canceled: false });
      }

      // A failed run leaves a truncated file behind; never present it as a result.
      this.#discardOutput();
      const err = new Error(friendlyError(this.stderrTail.join('\n')));
      err.detail = this.stderrTail.join('\n').slice(-4000);
      err.exitCode = code;
      this.emit('error', err);
    });

    return this;
  }

  /** Split a stream into complete lines. */
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

  /**
   * `-progress pipe:1` emits `key=value` lines; the ones we care about are
   * `out_time` (the timestamp written so far) and `speed`.
   *
   * `out_time` is parsed in preference to `out_time_ms`, whose unit has been
   * microseconds rather than milliseconds in ffmpeg for years — the timecode
   * form is the only one that is unambiguous across builds.
   */
  #handleProgressLine(line) {
    const eq = line.indexOf('=');
    if (eq === -1) return;
    const key = line.slice(0, eq).trim();
    const value = line.slice(eq + 1).trim();

    if (key === 'speed') {
      const n = Number.parseFloat(value);
      if (Number.isFinite(n)) this.speed = n;
      return;
    }

    if (key !== 'out_time') return;

    const seconds = parseTimecode(value);
    if (seconds == null) return;

    // Without a known duration there is nothing to divide by, so report the
    // elapsed output time and let the UI show an indeterminate bar.
    const percent = this.totalSec
      ? Math.max(0, Math.min(99.5, (seconds / this.totalSec) * 100))
      : null;

    this.emit('progress', {
      percent,
      phase: this.kind,
      processedSec: seconds,
      totalSec: this.totalSec,
      speed: this.speed ?? null,
    });
  }

  /** Remove the concat list file and anything else we wrote for this run. */
  #cleanupTemp() {
    for (const file of this.tempFiles) {
      fsp.rm(file, { force: true }).catch(() => {/* best effort */});
    }
    this.tempFiles = [];
  }

  /** Delete a partial output so a canceled or failed run leaves no debris. */
  #discardOutput() {
    if (!this.outputPath) return;
    fsp.rm(this.outputPath, { force: true }).catch(() => {/* best effort */});
  }

  /** Stop the operation. On Windows the whole tree goes, POSIX gets SIGTERM. */
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

/* -------------------------------------------------------------------------- */
/* Job builders                                                               */
/* -------------------------------------------------------------------------- */

/**
 * Build a trim job.
 *
 * `-ss` sits *before* `-i` in both modes: that makes it an input seek, so
 * ffmpeg jumps straight to the keyframe before the cut instead of decoding the
 * whole file up to it. In encode mode the frames between that keyframe and the
 * requested start are decoded and discarded, which is what makes the cut exact.
 *
 * @param {{id:string, info:object, start:number, end:number,
 *          mode:'copy'|'encode', outputPath:string}} opts
 * @returns {MediaJob}
 */
function createTrimJob({ id, info, start, end, mode, outputPath }) {
  const duration = end - start;
  const ext = path.extname(outputPath).toLowerCase();

  const args = [
    ...baseArgs(),
    ...progressArgs(),
    '-ss', start.toFixed(3),
    '-i', info.filePath,
    '-t', duration.toFixed(3),
  ];

  if (mode === 'copy') {
    // -map 0 keeps every stream (multi-language audio, subtitles) rather than
    // just ffmpeg's one-per-type default.
    args.push('-map', '0', '-c', 'copy', '-avoid_negative_ts', 'make_zero');
  } else {
    args.push(...encodeArgs(info, ext));
  }

  args.push(outputPath);

  return new MediaJob({ id, kind: 'trim', args, outputPath, totalSec: duration });
}

/**
 * Build a join job.
 *
 * copy mode uses the concat *demuxer*, which needs a list file on disk and
 * identical stream parameters. encode mode uses the concat *filter*, which
 * decodes everything to raw frames first and so accepts any mix of inputs.
 *
 * @param {{id:string, infos:object[], mode:'copy'|'encode', outputPath:string}} opts
 * @returns {Promise<MediaJob>}
 */
async function createJoinJob({ id, infos, mode, outputPath }) {
  const ext = path.extname(outputPath).toLowerCase();
  // Unknown durations make the total an underestimate rather than a wrong
  // number; the UI falls back to an indeterminate bar when nothing is known.
  const known = infos.map((i) => i.duration).filter((d) => Number.isFinite(d) && d > 0);
  const totalSec = known.length === infos.length ? known.reduce((a, b) => a + b, 0) : null;

  if (mode === 'copy') {
    const listFile = await writeConcatList(infos, id);
    const args = [
      ...baseArgs(),
      ...progressArgs(),
      '-f', 'concat',
      '-safe', '0',        // absolute paths are fine: they came from a file dialog
      '-i', listFile,
      '-map', '0',
      '-c', 'copy',
    ];
    if (['.mp4', '.m4v', '.mov'].includes(ext)) args.push('-movflags', '+faststart');
    args.push(outputPath);

    return new MediaJob({
      id, kind: 'join', args, outputPath, totalSec, tempFiles: [listFile],
    });
  }

  const hasVideo = infos[0].hasVideo;
  const hasAudio = infos[0].hasAudio;

  const args = [...baseArgs(), ...progressArgs()];
  for (const info of infos) args.push('-i', info.filePath);

  args.push('-filter_complex', concatFilter(infos));
  if (hasVideo) args.push('-map', '[v]');
  if (hasAudio) args.push('-map', '[a]');
  args.push(...encodeArgs(infos[0], ext), outputPath);

  return new MediaJob({ id, kind: 'join', args, outputPath, totalSec });
}

/**
 * Build the `-filter_complex` graph for an encoded join.
 *
 * The concat filter is no more forgiving than the demuxer about mismatched
 * inputs — it refuses outright if two streams differ in size, SAR, frame rate
 * or sample format. What makes the encode path universal is the normalising
 * stage in front of it: every input is scaled and padded into one common frame
 * and resampled to one common audio format first, so by the time concat sees
 * them they genuinely are identical.
 *
 * Letterboxing (scale + pad) rather than stretching keeps a 4:3 clip from being
 * distorted when it is joined onto 16:9 footage.
 *
 * @param {object[]} infos
 * @returns {string}
 */
function concatFilter(infos) {
  const hasVideo = infos[0].hasVideo;
  const hasAudio = infos[0].hasAudio;
  const max = (pick) => Math.max(...infos.map((i) => pick(i) || 0));

  // The largest input sets the canvas, so nothing is downscaled and lost.
  // h264 needs even dimensions for yuv420p.
  const even = (n) => Math.max(2, Math.floor(n / 2) * 2);
  const width = even(max((i) => i.video?.width) || 1280);
  const height = even(max((i) => i.video?.height) || 720);
  const fps = max((i) => i.video?.fps) || 30;
  const sampleRate = max((i) => i.audio?.sampleRate) || 48000;
  const layout = (max((i) => i.audio?.channels) || 2) >= 2 ? 'stereo' : 'mono';

  const stages = [];
  const labels = [];

  infos.forEach((_, i) => {
    if (hasVideo) {
      stages.push(
        `[${i}:v:0]scale=${width}:${height}:force_original_aspect_ratio=decrease,` +
        `pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2,setsar=1,fps=${fps},format=yuv420p[v${i}]`
      );
      labels.push(`[v${i}]`);
    }
    if (hasAudio) {
      stages.push(
        `[${i}:a:0]aresample=${sampleRate},` +
        `aformat=sample_fmts=fltp:channel_layouts=${layout}[a${i}]`
      );
      labels.push(`[a${i}]`);
    }
  });

  const outputs = `${hasVideo ? '[v]' : ''}${hasAudio ? '[a]' : ''}`;
  const concat =
    `${labels.join('')}concat=n=${infos.length}:v=${hasVideo ? 1 : 0}:a=${hasAudio ? 1 : 0}${outputs}`;

  return [...stages, concat].join(';');
}

/**
 * Write the concat demuxer's list file into the OS temp folder.
 * Its quoting rules are its own: single-quote each path and escape any single
 * quote inside it as `'\''`.
 * @param {object[]} infos
 * @param {string} id
 * @returns {Promise<string>} the list file path
 */
async function writeConcatList(infos, id) {
  const listFile = path.join(os.tmpdir(), `media-grabber-concat-${id}.txt`);
  const body = infos
    .map((i) => `file '${i.filePath.replace(/'/g, "'\\''")}'`)
    .join('\n');
  await fsp.writeFile(listFile, `${body}\n`, 'utf8');
  return listFile;
}

/* -------------------------------------------------------------------------- */
/* Time helpers                                                               */
/* -------------------------------------------------------------------------- */

/**
 * `"00:01:23.456"` → 83.456. Returns null for ffmpeg's "N/A" placeholder.
 * @param {string} value
 * @returns {number|null}
 */
function parseTimecode(value) {
  if (!value || value === 'N/A') return null;
  const parts = value.split(':').map(Number);
  if (parts.some((n) => !Number.isFinite(n))) return null;

  let seconds = 0;
  for (const part of parts) seconds = seconds * 60 + part;
  return seconds;
}

module.exports = {
  MEDIA_EXTENSIONS,
  probe,
  joinCompatibility,
  createTrimJob,
  createJoinJob,
  uniqueOutputPath,
  friendlyError,
  parseTimecode,
};
