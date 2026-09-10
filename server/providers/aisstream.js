/* -----------------------------------------------------------------------------
 * aisstream.js — the existing feed, read once for the whole company.
 *
 * THIS IS THE CHANGE THAT PAYS FOR THE RELAY ON ITS OWN, whatever we settle on
 * for a provider. AISstream has to be subscribed unfiltered — filtering by MMSI
 * at their end reached thirty-one of sixty-one and stopped, so the board asks
 * for every vessel on earth and throws away the 99.9% that are not ours. That
 * is about twelve gigabytes a day. Per screen. Five screens on five walls were
 * five separate subscriptions doing exactly the same work.
 *
 * Here it is done once. A screen now costs a few kilobytes a minute.
 *
 * IT RUNS THE BOARD'S OWN PARSER RATHER THAN A SECOND COPY. js/ais.js decodes
 * their message types, normalises names, and knows which fields are absent from
 * which report — a fortnight of corrections live in it. A server-side
 * reimplementation would be a second place for the two to disagree, and the
 * disagreement would show up as yachts that are subtly wrong rather than as an
 * error. So the file is loaded into a context holding just what it asks for:
 * a WebSocket, a config, the MID table, and a Store that writes here.
 * -------------------------------------------------------------------------- */

'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..', '..');

function create(cfg, store, log) {
  var reader = { stopped: false, ais: null };

  /**
   * Everything js/ais.js reaches for, and nothing else.
   *
   * A sandbox rather than the real globals: this loads a browser file into a
   * server process, and the narrower the surface, the less there is to be
   * surprised by. If that file one day starts wanting `document`, it will fail
   * here loudly instead of half-working.
   */
  function sandbox() {
    var shim = {
      CONFIG: null,
      MID: null,
      Fmt: { pad: function (n, w) { return String(n).padStart(w || 2, '0'); } },
      Store: {
        byMmsi: store.byMmsi,
        vessels: store.vessels,
        // Counters the parser keeps for the console's reception panel. Held
        // here so its bookkeeping has somewhere to go.
        bytes: 0, heard: 0, matched: 0, unreadable: 0, connection: 'idle',
        setConnection: function (state) {
          shim.Store.connection = state;
          store.connection = state;
        },
        applyFix: function (mmsi, fix) { return store.applyFix(mmsi, fix); },
        applyIdentity: function (mmsi, d) { return store.applyIdentity(mmsi, d); },
        applyVoyage: function (mmsi, d) { return store.applyVoyage(mmsi, d); }
      }
    };

    var ctx = vm.createContext({
      window: shim,
      WebSocket: globalThis.WebSocket,
      TextDecoder: globalThis.TextDecoder,
      setTimeout: setTimeout, clearTimeout: clearTimeout,
      setInterval: setInterval, clearInterval: clearInterval,
      console: console, JSON: JSON, Math: Math, Date: Date,
      isFinite: isFinite, parseInt: parseInt, parseFloat: parseFloat,
      Number: Number, String: String, Object: Object, Array: Array,
      Boolean: Boolean, RegExp: RegExp, Error: Error, Blob: globalThis.Blob,
      Uint8Array: Uint8Array, ArrayBuffer: ArrayBuffer
    });

    ['config.js', 'data/mid.js', 'js/ais.js'].forEach(function (f) {
      vm.runInContext(fs.readFileSync(path.join(ROOT, f), 'utf8'), ctx,
        { filename: f });
    });

    // The endpoint is the relay's to set, not the repository's.
    shim.CONFIG.ais.endpoint = cfg.aisStream.endpoint;
    // Never at the server. Filtering by MMSI there reached thirty-one of
    // sixty-one after a full day and stopped; this is the setting that cost a
    // fortnight to establish and it is not one to leave to a default.
    shim.CONFIG.ais.filterAtServer = false;
    return shim;
  }

  reader.start = function (mmsiList) {
    reader.stopped = false;
    var shim = sandbox();
    reader.shim = shim;
    reader.ais = shim.Ais;
    reader.ais.start(cfg.key, mmsiList);
    log('aisstream: subscribed, unfiltered, for ' + mmsiList.length + ' vessels');

    // The parser reports its own health through the Store shim; the relay only
    // has to notice that a pass happened, so the board can say how stale it is.
    reader.timer = setInterval(function () {
      store.lastPollAt = new Date();
      store.lastError = shim.Ais && shim.Ais.lastError ? shim.Ais.lastError : null;
    }, 30000);
    if (reader.timer.unref) reader.timer.unref();
  };

  reader.stop = function () {
    reader.stopped = true;
    clearInterval(reader.timer);
    if (reader.ais && reader.ais.stop) reader.ais.stop();
  };

  reader.stats = function () {
    var s = reader.shim && reader.shim.Store;
    return s ? { bytes: s.bytes, heard: s.heard, matched: s.matched,
                 unreadable: s.unreadable, connection: s.connection } : null;
  };

  return reader;
}

module.exports = { create: create };
