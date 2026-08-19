'use strict';

/**
 * Tiny JSON-file store for settings and download history.
 *
 * Deliberately dependency-free: the data set is a few kilobytes, so a debounced
 * atomic write to `userData/store.json` is plenty and keeps the install lean.
 */

const fs = require('node:fs');
const path = require('node:path');
const { app } = require('electron');

const MAX_HISTORY = 200;

const defaults = () => ({
  settings: {
    downloadDir: app.getPath('downloads'),
    format: 'video',          // 'video' | 'audio'
    quality: 'best',          // 'best' | '1080' | '720' | '480'
    useCookies: false,
    cookieBrowser: 'chrome',  // chrome | firefox | edge | brave | safari | opera | chromium | vivaldi
    theme: 'dark',
  },
  history: [],                // newest first
});

class Store {
  constructor() {
    this.file = path.join(app.getPath('userData'), 'store.json');
    this.data = this.#load();
    this.flushTimer = null;
  }

  #load() {
    const base = defaults();
    try {
      const raw = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      return {
        settings: { ...base.settings, ...(raw.settings || {}) },
        history: Array.isArray(raw.history) ? raw.history : [],
      };
    } catch {
      // Missing or corrupt file: start clean rather than crash on launch.
      return base;
    }
  }

  /** Debounced, atomic (write-temp-then-rename) persist. */
  #save() {
    clearTimeout(this.flushTimer);
    this.flushTimer = setTimeout(() => this.flushSync(), 150);
  }

  /** Immediate write — used on app quit. */
  flushSync() {
    clearTimeout(this.flushTimer);
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      const tmp = `${this.file}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2), 'utf8');
      fs.renameSync(tmp, this.file);
    } catch (err) {
      console.error('[store] failed to persist:', err.message);
    }
  }

  // ---- settings -----------------------------------------------------------

  getSettings() {
    return { ...this.data.settings };
  }

  /** @param {Partial<ReturnType<Store['getSettings']>>} patch */
  updateSettings(patch) {
    this.data.settings = { ...this.data.settings, ...patch };
    this.#save();
    return this.getSettings();
  }

  // ---- history ------------------------------------------------------------

  getHistory() {
    return this.data.history.slice();
  }

  /** @param {object} entry */
  addHistory(entry) {
    const record = {
      id: entry.id || `${Date.now()}-${Math.random().toString(16).slice(2, 8)}`,
      title: entry.title || 'Untitled',
      url: entry.url,
      filePath: entry.filePath || null,
      thumbnail: entry.thumbnail || null,
      format: entry.format,
      quality: entry.quality,
      sizeBytes: entry.sizeBytes ?? null,
      durationSec: entry.durationSec ?? null,
      completedAt: entry.completedAt || new Date().toISOString(),
    };
    this.data.history.unshift(record);
    if (this.data.history.length > MAX_HISTORY) {
      this.data.history.length = MAX_HISTORY;
    }
    this.#save();
    return record;
  }

  removeHistory(id) {
    this.data.history = this.data.history.filter((h) => h.id !== id);
    this.#save();
    return this.getHistory();
  }

  clearHistory() {
    this.data.history = [];
    this.#save();
    return [];
  }
}

let instance = null;
/** @returns {Store} lazily-created singleton (needs `app` to be ready). */
function store() {
  if (!instance) instance = new Store();
  return instance;
}

module.exports = { store };
