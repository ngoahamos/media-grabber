'use strict';

/**
 * Electron main process — window lifecycle and security policy.
 *
 * All privileged work (spawning yt-dlp, touching the filesystem, opening the
 * shell) happens here or in ./ipc.js. The renderer never gets Node access.
 */

const path = require('node:path');
const { app, BrowserWindow, session, shell, Menu, nativeTheme } = require('electron');

const { registerIpc, cancelAllJobs } = require('./ipc');
const { store } = require('./store');

// `npm run dev` passes --dev; a plain `npm start` launches without DevTools.
const isDev = process.argv.includes('--dev');

/** @type {BrowserWindow|null} */
let mainWindow = null;

/* -------------------------------------------------------------------------- */
/* Window                                                                     */
/* -------------------------------------------------------------------------- */

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1080,
    height: 780,
    minWidth: 880,
    minHeight: 620,
    show: false,                       // avoid a white flash; show on ready-to-show
    backgroundColor: '#0c0e11',
    autoHideMenuBar: true,
    // A native-feeling inset traffic-light area on macOS; normal frame elsewhere.
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    trafficLightPosition: process.platform === 'darwin' ? { x: 18, y: 18 } : undefined,
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload', 'preload.js'),
      contextIsolation: true,          // renderer gets no direct Node/Electron access
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
      webviewTag: false,
    },
  });

  mainWindow.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));

  mainWindow.once('ready-to-show', () => {
    mainWindow.show();
    if (isDev) mainWindow.webContents.openDevTools({ mode: 'detach' });
  });

  // External links (channel pages, help links) open in the user's browser,
  // never inside the app window.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:$/.test(new URL(url).protocol)) shell.openExternal(url);
    return { action: 'deny' };
  });

  // Hard-block in-app navigation away from our own bundled UI.
  mainWindow.webContents.on('will-navigate', (event, url) => {
    if (!url.startsWith('file://')) event.preventDefault();
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

/* -------------------------------------------------------------------------- */
/* Security policy                                                            */
/* -------------------------------------------------------------------------- */

/**
 * Content-Security-Policy for the renderer.
 * `img-src https:` is required because thumbnails are loaded straight from the
 * source CDN; everything executable must come from the app bundle itself.
 */
function applyCsp() {
  session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
    callback({
      responseHeaders: {
        ...details.responseHeaders,
        'Content-Security-Policy': [
          [
            "default-src 'self'",
            "script-src 'self'",
            "style-src 'self' 'unsafe-inline'",
            "img-src 'self' data: https:",
            "media-src 'self'",
            "connect-src 'self'",
            "font-src 'self'",
            "object-src 'none'",
            "base-uri 'none'",
            "form-action 'none'",
          ].join('; '),
        ],
      },
    });
  });

  // The only capability the UI needs is reading the clipboard (the Paste
  // button). Everything else — camera, mic, geolocation, notifications — is
  // denied outright.
  const ALLOWED_PERMISSIONS = new Set(['clipboard-read', 'clipboard-sanitized-write']);
  session.defaultSession.setPermissionRequestHandler((_wc, permission, callback) =>
    callback(ALLOWED_PERMISSIONS.has(permission))
  );
  session.defaultSession.setPermissionCheckHandler((_wc, permission) =>
    ALLOWED_PERMISSIONS.has(permission)
  );
}

/* -------------------------------------------------------------------------- */
/* Menu                                                                       */
/* -------------------------------------------------------------------------- */

function buildMenu() {
  const template = [
    ...(process.platform === 'darwin'
      ? [{ role: 'appMenu' }]
      : []),
    {
      label: 'File',
      submenu: [process.platform === 'darwin' ? { role: 'close' } : { role: 'quit' }],
    },
    { role: 'editMenu' },
    {
      label: 'View',
      submenu: [
        { role: 'reload' },
        { role: 'toggleDevTools' },
        { type: 'separator' },
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' },
      ],
    },
    {
      role: 'help',
      submenu: [
        {
          label: 'Supported sites (yt-dlp)',
          click: () =>
            shell.openExternal(
              'https://github.com/yt-dlp/yt-dlp/blob/master/supportedsites.md'
            ),
        },
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

/* -------------------------------------------------------------------------- */
/* Lifecycle                                                                  */
/* -------------------------------------------------------------------------- */

// One window only: a second launch focuses the existing instance.
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (!mainWindow) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  });

  app.whenReady().then(() => {
    nativeTheme.themeSource = 'dark';
    store();            // create/migrate the settings file before the UI asks
    applyCsp();
    registerIpc();
    buildMenu();
    createWindow();

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });

  // Never leave an orphaned yt-dlp/ffmpeg process behind.
  app.on('before-quit', () => {
    cancelAllJobs();
    store().flushSync();
  });
}
