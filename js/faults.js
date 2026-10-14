/* -----------------------------------------------------------------------------
 * faults.js — what is down on board, by name. The console's, not the board's.
 *
 * The board learns a state per yacht from /api/fleet and draws a mark. This
 * asks the relay's /api/faults for the list behind the mark — which devices,
 * since when — and is only loaded by console.html, so a wall screen never
 * fetches it at all.
 *
 * In demo mode it reads the simulator's invented list instead, so the panel
 * can be seen before Domotz is connected.
 * -------------------------------------------------------------------------- */

(function () {
  'use strict';

  var Faults = {
    detail: null,        // { checkedAt, error, vessels: { mmsi: {...} } }
    available: false,    // whether this console has a Domotz reading at all
    lastError: null,
    timer: null
  };

  var POLL_MS = 60000;

  Faults.start = function (onUpdate) {
    clearInterval(Faults.timer);
    var run = function () { load().then(onUpdate, onUpdate); };
    run();
    Faults.timer = setInterval(run, POLL_MS);
  };

  function load() {
    if (window.Store.mode !== 'live') {
      Faults.detail = window.Demo && window.Demo.faults || null;
      Faults.available = !!Faults.detail;
      return Promise.resolve();
    }
    if (window.CONFIG.provider !== 'relay') {
      // A console straight onto a provider has no relay to ask, and so no key.
      Faults.available = false;
      return Promise.resolve();
    }
    var url = (window.CONFIG.faults && window.CONFIG.faults.detailEndpoint) || '/api/faults';
    return window.fetch(url, { cache: 'no-store' }).then(function (res) {
      if (res.status === 503) { Faults.available = false; return null; }
      if (!res.ok) throw new Error('HTTP ' + res.status);
      return res.json();
    }).then(function (body) {
      if (!body) return;
      Faults.detail = body;
      Faults.available = true;
      Faults.lastError = body.error || null;
    }).catch(function (err) {
      Faults.lastError = (err && err.message) || String(err);
    });
  }

  // The list for one yacht, or null when Domotz has nothing on her.
  Faults.forVessel = function (mmsi) {
    var d = Faults.detail;
    return d && d.vessels ? d.vessels[String(mmsi)] || null : null;
  };

  window.Faults = Faults;
})();
