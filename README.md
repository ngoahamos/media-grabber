# Media Grabber

A cross-platform Electron desktop app that downloads video and audio from
YouTube, Facebook and the [1000+ other sites yt-dlp supports](https://github.com/yt-dlp/yt-dlp/blob/master/supportedsites.md).

- **MP4 video** at best available quality, or capped at 1080p / 720p / 480p
- **MP3 audio** extraction at the highest bitrate the source allows
- Live progress bar parsed straight from yt-dlp, with speed and ETA
- Video title, channel, duration and thumbnail preview before you commit
- Download history with play / reveal-in-folder / remove actions
- Choosable download folder, cancellable downloads, optional browser cookies
- Dark UI, no telemetry, no external runtime dependencies

---

## Quick start

```bash
npm install              # dependencies (Electron + electron-builder only)
npm run setup:binaries   # fetch yt-dlp + ffmpeg for your platform
npm start                # launch the app
```

`npm run dev` does the same but opens DevTools.

---

## Project structure

```
yt-downloader/
├── package.json                 # deps, scripts, electron-builder config
├── build/
│   ├── icon-v2.png              # active 1024×1024 app icon (generated)
│   ├── icon.png                 # original app icon (retained as a fallback)
│   └── entitlements.mac.plist   # hardened-runtime entitlements for macOS
├── bin/                         # bundled binaries, one folder per platform
│   ├── win32/   yt-dlp.exe  ffmpeg.exe  ffprobe.exe
│   ├── darwin/  yt-dlp      ffmpeg      ffprobe
│   ├── linux/   yt-dlp      ffmpeg      ffprobe
│   └── README.md                # manual download instructions
├── scripts/
│   ├── setup-binaries.js        # downloads + ad-hoc signs the binaries
│   └── make-icon.js             # regenerates build/icon-v2.png
└── src/
    ├── main/                    # Node/Electron side (privileged)
    │   ├── main.js              # windows, security policy, lifecycle
    │   ├── ipc.js               # every renderer-callable operation
    │   ├── ytdlp.js             # yt-dlp wrapper: args, spawn, parsing
    │   ├── binaries.js          # per-platform binary resolution
    │   └── store.js             # settings + history JSON store
    ├── preload/preload.js       # contextBridge API surface
    └── renderer/                # the UI (no Node access)
        ├── index.html
        ├── styles.css
        └── renderer.js
```

---

## How it works

### Binary resolution — `src/main/binaries.js`

The app never assumes yt-dlp is on the user's machine. It looks in two places,
in order:

| | Development | Packaged |
| --- | --- | --- |
| Bundled | `bin/<process.platform>/` | `<process.resourcesPath>/bin/` |
| Fallback | anything on `PATH` | anything on `PATH` |

`electron-builder` copies only the folder matching the build target, which is
why the packaged layout has no per-platform sub-directory:

```jsonc
"mac":   { "extraResources": [{ "from": "bin/darwin", "to": "bin" }] },
"win":   { "extraResources": [{ "from": "bin/win32",  "to": "bin" }] },
"linux": { "extraResources": [{ "from": "bin/linux",  "to": "bin" }] }
```

The `.exe` suffix is applied only on `win32`, and the executable bit is
restored automatically on macOS/Linux (archives and git checkouts routinely
drop it).

### Running yt-dlp — `src/main/ytdlp.js`

Two entry points: `analyze(url)` for metadata and `new DownloadJob(opts)` for
the download itself, both using `child_process.spawn`/`execFile` — no `execa`
dependency needed.

**Metadata** comes from `yt-dlp -J`, which dumps the full info JSON. The app
pulls out the title, thumbnail, duration, uploader, extractor name and the list
of available heights (used to grey out resolutions the video does not have).

**Format selection** is a single `-f` expression:

```js
// video, optionally capped:  bv*[height<=720]+ba/b[height<=720]/bv*+ba/b
// audio:                     ba/b  →  --extract-audio --audio-format mp3
```

`-S ext:mp4:m4a` makes yt-dlp prefer streams that merge into MP4 without
re-encoding, and `--merge-output-format mp4` fixes the container.

**Progress parsing** does not scrape human-readable output. yt-dlp lets you
define the progress line format, so the app asks for exactly the fields it
needs behind a unique sentinel:

```js
--progress-template "download:@@PROGRESS@@%(progress.status)s|%(progress.downloaded_bytes)s|…|%(progress.filename)s"
--progress-template "postprocess:@@POST@@%(progress.status)s|%(progress.postprocessor)s"
--print "after_move:@@FILE@@%(filepath)s"
```

Both stdout and stderr are split into lines and routed by sentinel. Three
details worth knowing:

1. **`--print` implies `--quiet` *and* `--simulate`.** Both are undone with
   `--no-simulate --no-quiet`, otherwise nothing downloads and the log drawer
   stays empty.
2. **A merged MP4 is two downloads** (video stream, then audio stream), each
   reporting 0→100%. The job watches `progress.filename`; when it changes, the
   stream index advances and the overall bar is computed as
   `(streamIndex + fraction) / expectedStreams`, so it rises monotonically
   0→50→100 instead of resetting halfway.
3. **ffmpeg post-processing reports no byte counts**, so merging and MP3
   transcoding pin the bar at 99.5% and switch it to an animated stripe.

**Cancellation** kills the process tree — `taskkill /T /F` on Windows, SIGTERM
with a SIGKILL fallback elsewhere — because yt-dlp spawns ffmpeg as a child.
Partial `.part` files are left in place on purpose: re-running the same
download resumes from where it stopped.

**Errors** are translated from yt-dlp's stderr into one actionable sentence
(`friendlyError`), e.g. *"This video needs a signed-in session. Turn on 'Use
browser cookies'…"* rather than a stack trace. Anything unrecognised falls back
to the last `ERROR:` line, so nothing is ever swallowed. The raw output is
always available in the collapsible log drawer.

### Security model

The renderer is fully sandboxed and has no Node access at all:

```js
contextIsolation: true, nodeIntegration: false, sandbox: true
```

Everything it can do is the explicit list in `src/preload/preload.js`, exposed
via `contextBridge`. The main process validates on the way in — URLs must be
`http(s)`, the download folder must exist and be writable, and history paths are
resolved before being handed to the shell. A CSP is applied to all responses
(`img-src` allows `https:` so thumbnails load from the source CDN; scripts are
restricted to the app bundle), external links open in the system browser, and
in-app navigation away from the bundled UI is blocked.

---

## Adding the binaries

`npm run setup:binaries` handles this for you:

```bash
npm run setup:binaries                                  # current platform
npm run setup:binaries -- --platform win32,darwin,linux # cross-build prep
npm run setup:binaries -- --force                       # update to latest
npm run setup:binaries -- --only ffmpeg                 # one tool (+ffprobe)
```

It downloads yt-dlp from the official GitHub releases and ffmpeg from
[yt-dlp/FFmpeg-Builds](https://github.com/yt-dlp/FFmpeg-Builds) (Windows/Linux)
or [evermeet.cx](https://evermeet.cx/ffmpeg/) (macOS), unpacks them into
`bin/<platform>/`, sets the executable bit, and ad-hoc code-signs the macOS
binaries so Apple Silicon will run them.

To do it by hand, see [`bin/README.md`](bin/README.md). If `bin/` is empty the
app falls back to whatever is on your `PATH`, so `brew install yt-dlp ffmpeg`
also works during development.

---

## Running and building

| Command | What it does |
| --- | --- |
| `npm start` | Run the app |
| `npm run dev` | Run with DevTools open |
| `npm run setup:binaries` | Download yt-dlp + ffmpeg |
| `npm run make:icon` | Regenerate `build/icon-v2.png` |
| `npm run pack` | Unpacked build in `dist/` (fast, for testing) |
| `npm run build` | Installers for the current OS |
| `npm run build:win` | NSIS installer + portable `.exe` |
| `npm run build:mac` | `.dmg` + `.zip`, x64 and arm64 |
| `npm run build:linux` | AppImage + `.deb` |

Populate `bin/<platform>/` for the target **before** building — electron-builder
copies whatever is there at build time.

Cross-building has the usual limits: Windows and Linux targets build fine on
any host, but macOS targets require a Mac. To skip code signing while testing:

```bash
CSC_IDENTITY_AUTO_DISCOVERY=false npm run build:mac
```

For real macOS distribution you need a Developer ID certificate and
notarization; `build/entitlements.mac.plist` already grants the hardened-runtime
exceptions required to spawn the bundled yt-dlp and ffmpeg.

---

## Notes and gotchas

**Playlists.** Every invocation passes `--no-playlist`, so a link that points at
a video inside a playlist downloads just that video. Remove the flag in
`baseArgs()` if you want whole-playlist support.

**Cookies.** The toggle maps to `--cookies-from-browser <browser>`, which reads
the cookie database of a locally installed browser. Chromium-based browsers
usually need to be **fully closed** first, and on macOS the OS may prompt for
keychain access. `cookieArgs()` also accepts a `cookieFile` for the
`--cookies <file>` (Netscape format) route if you prefer exporting them.

**Slow yt-dlp startup.** The official macOS/Linux yt-dlp binaries are
PyInstaller bundles that unpack and import a few thousand extractor modules on
every run. That is normally a second or two, but on machines with aggressive
file-scanning security software it can take considerably longer, which shows up
as a slow "Analyze". This is why the tool health check only tests for the
binary's *presence* — the version string is probed in the background and folded
into the header pill when it arrives, so a slow binary is never reported as a
missing one. A `pip`/`brew`-installed yt-dlp on `PATH` starts much faster if
this affects you.

**ffmpeg is required**, not optional: merging separate video and audio streams
and producing MP3 both go through it. The app refuses to start a download
without it and says so plainly.

**Licensing.** The ffmpeg builds fetched by the setup script are GPL builds,
which makes a distributed bundle GPL-licensed. Swap in an LGPL build if that
matters for how you ship this.
