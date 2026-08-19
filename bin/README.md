# Third-party binaries

The app expects `yt-dlp` and `ffmpeg` (plus `ffprobe`) to live here, one folder
per platform. They are **not** committed to git — fetch them with:

```bash
npm run setup:binaries              # current platform
npm run setup:binaries -- --platform win32,darwin,linux
npm run setup:binaries -- --force   # refresh to the latest release
```

## Expected layout

```
bin/
├── win32/    yt-dlp.exe   ffmpeg.exe   ffprobe.exe
├── darwin/   yt-dlp       ffmpeg       ffprobe
└── linux/    yt-dlp       ffmpeg       ffprobe
```

`electron-builder` copies only the folder matching the build target into the
packaged app, where it becomes `resources/bin` (see `extraResources` in
`package.json`). At runtime `src/main/binaries.js` resolves that path, and falls
back to whatever is on your `PATH` when the folder is empty — so a system-wide
`brew install yt-dlp ffmpeg` also works during development.

## Manual downloads

| Tool | Windows | macOS | Linux |
| --- | --- | --- | --- |
| yt-dlp | [`yt-dlp.exe`](https://github.com/yt-dlp/yt-dlp/releases/latest) | [`yt-dlp_macos`](https://github.com/yt-dlp/yt-dlp/releases/latest) | [`yt-dlp_linux`](https://github.com/yt-dlp/yt-dlp/releases/latest) |
| ffmpeg | [FFmpeg-Builds](https://github.com/yt-dlp/FFmpeg-Builds/releases/tag/latest) `win64-gpl.zip` | [evermeet.cx](https://evermeet.cx/ffmpeg/) (x86_64) or `brew install ffmpeg` | [FFmpeg-Builds](https://github.com/yt-dlp/FFmpeg-Builds/releases/tag/latest) `linux64-gpl.tar.xz` |

Rename the yt-dlp download to plain `yt-dlp` (or `yt-dlp.exe` on Windows) and,
on macOS/Linux, make it executable:

```bash
chmod +x bin/darwin/yt-dlp bin/darwin/ffmpeg bin/darwin/ffprobe
```

> **Licensing note.** ffmpeg GPL builds make the distributed bundle GPL-licensed.
> If that matters for your distribution, use an LGPL ffmpeg build instead.
