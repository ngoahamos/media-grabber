'use strict';

const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const path = require('node:path');
const { PassThrough } = require('node:stream');
const test = require('node:test');
const vm = require('node:vm');

// Stub only the process boundary: exercise the real argument construction,
// line parsing, retry logic, and events without network or browser access.
function loadWrapper({ execFile, spawn } = {}) {
  const module = { exports: {} };
  const hostProcess = {
    execPath: '/Applications/Media Grabber.app/Contents/MacOS/Media Grabber',
    env: { PATH: '/usr/bin', ELECTRON_RUN_AS_NODE: '0' },
    platform: 'darwin',
  };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../src/main/ytdlp.js'), 'utf8'), {
    module, process: hostProcess, queueMicrotask, setTimeout,
    require(name) {
      if (name === 'node:child_process') return { execFile, spawn };
      if (name === './binaries') {
        return { ytDlpPath: () => '/bundled/yt-dlp', ffmpegPath: () => '/bundled/ffmpeg' };
      }
      return require(name);
    },
  });
  return { ...module.exports, hostProcess };
}

function checkRuntime(args, options, hostProcess) {
  assert.equal(args[args.indexOf('--js-runtimes') + 1], `node:${hostProcess.execPath}`);
  assert.ok(args.includes('--no-js-runtimes'));
  assert.equal(options.env.ELECTRON_RUN_AS_NODE, '1');
  assert.equal(options.env.PATH, '/usr/bin');
  assert.equal(hostProcess.env.ELECTRON_RUN_AS_NODE, '0', 'must not mutate the app environment');
}

test('analysis and cookie retry both launch with the bundled runtime', async () => {
  const calls = [];
  const wrapper = loadWrapper({
    execFile(bin, args, options, callback) {
      calls.push({ bin, args, options });
      if (calls.length === 1) callback(new Error('failed'), '', 'ERROR: The page needs to be reloaded');
      else callback(null, JSON.stringify({ id: 'video', title: 'Example' }), '');
    },
  });
  const info = await wrapper.analyze('https://www.youtube.com/watch?v=example', { useCookies: true });
  assert.equal(info.id, 'video');
  assert.equal(calls.length, 2);
  for (const { args, options } of calls) checkRuntime(args, options, wrapper.hostProcess);
  assert.ok(calls[0].args.includes('--cookies-from-browser'));
  assert.ok(!calls[1].args.includes('--cookies-from-browser'));
});

test('download keeps runtime configuration through retry and completes once', () => {
  const calls = [];
  const wrapper = loadWrapper({
    spawn(bin, args, options) {
      const child = new EventEmitter();
      child.stdout = new PassThrough();
      child.stderr = new PassThrough();
      calls.push({ child, args, options });
      return child;
    },
  });
  const job = new wrapper.DownloadJob({
    id: 'job', url: 'https://www.youtube.com/watch?v=example',
    outputDir: '/downloads', format: 'video', useCookies: true,
  });
  const done = [];
  job.on('done', result => done.push(result));
  job.on('error', err => { throw err; });
  job.start();
  calls[0].child.stderr.write('ERROR: The page needs to be reloaded\n');
  calls[0].child.emit('close', 1);
  assert.equal(calls.length, 2);
  for (const { args, options } of calls) checkRuntime(args, options, wrapper.hostProcess);
  assert.ok(!calls[1].args.includes('--cookies-from-browser'));
  calls[1].child.stdout.write('@@FILE@@/downloads/example.mp4\n');
  calls[1].child.emit('close', 0);
  assert.equal(done.length, 1);
  assert.equal(done[0].filePath, '/downloads/example.mp4');
  assert.equal(done[0].canceled, false);
});

test('403 download reports actionable guidance and preserves the diagnostic', () => {
  let child;
  let count = 0;
  const wrapper = loadWrapper({
    spawn() {
      count++;
      child = new EventEmitter();
      child.stdout = new PassThrough();
      child.stderr = new PassThrough();
      return child;
    },
  });
  const job = new wrapper.DownloadJob({
    id: 'job', url: 'https://example.com/video', outputDir: '/downloads', format: 'audio',
  });
  const errors = [];
  job.on('error', err => errors.push(err));
  job.start();
  const diagnostic = 'ERROR: unable to download video data: HTTP Error 403: Forbidden';
  child.stderr.write(diagnostic + '\n');
  child.emit('close', 1);
  assert.equal(count, 1);
  assert.equal(errors.length, 1);
  assert.match(errors[0].message, /403.*Update the app/);
  assert.equal(errors[0].detail, diagnostic);
  assert.equal(errors[0].exitCode, 1);
  assert.match(wrapper.friendlyError('ERROR: Unable to download webpage: HTTP Error 403: Forbidden'), /403/);
  assert.match(wrapper.friendlyError('ERROR: Unsupported URL: example'), /not supported/);
});
