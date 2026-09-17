/* -----------------------------------------------------------------------------
 * myshiptracking.js — reading vessel positions from MyShipTracking.
 *
 * MyShipTracking bulk endpoint returns all vessel positions in one call.
 * No pagination, no cursor — fetch all 61 vessels at once.
 * -------------------------------------------------------------------------- */

'use strict';

function create(cfg, store, log) {
  var c = cfg.myShipTracking;
  var reader = {
    calls: 0,
    lastPollCalls: 0,
    lastAudit: null,
    timer: null,
    stopped: false
  };

  async function poll(mmsiList) {
    var applied = 0;
    var strangers = {};
    var oldest = null, newest = null;
    var creditsCharged = 0;

    reader.lastPollCalls = 0;
    reader.calls++;
    reader.lastPollCalls++;

    // MyShipTracking bulk endpoint - all vessels in one call
    const mmsiParam = mmsiList.join(',');
    const url = `${c.endpoint}?mmsi=${encodeURIComponent(mmsiParam)}&response=simple`;

    const res = await fetch(url, {
      headers: {
        'Authorization': `Bearer ${cfg.key}`,
        'Accept': 'application/json'
      }
    });

    if (!res.ok) {
      const detail = (await res.text()).slice(0, 400);
      throw new Error(`HTTP ${res.status} ${res.statusText} — ${detail}`);
    }

    const body = await res.json();

    if (body.status !== 'success') {
      throw new Error(`API error: ${body.message}`);
    }

    const vessels = body.data || [];
    creditsCharged = parseInt(res.headers.get('x-credit-charged') || 0);

    // Process each vessel position
    vessels.forEach(function (v) {
      const mmsi = v.mmsi != null ? String(v.mmsi) : null;
      if (!mmsi) return;

      const at = new Date(String(v.received));
      if (!isFinite(at.getTime())) return;

      if (!oldest || at < oldest) oldest = at;
      if (!newest || at > newest) newest = at;

      if (!store.byMmsi[mmsi]) {
        strangers[mmsi] = true;
        return;
      }

      if (store.applyFix(mmsi, {
        lat: num(v.lat),
        lon: num(v.lng),
        sog: num(v.speed),
        cog: num(v.course),
        heading: null,
        navStatus: null,
        source: 'ter',
        at: at
      })) applied++;

      if (v.vessel_name != null || v.imo != null) {
        store.applyIdentity(mmsi, {
          name: text(v.vessel_name),
          imo: num(v.imo) || null
        });
      }
    });

    store.lastPollAt = new Date();
    reader.lastAudit = {
      pages: 1,
      calls: reader.lastPollCalls,
      reports: vessels.length,
      applied: applied,
      glitches: 0,
      strangers: Object.keys(strangers),
      windowMinutes: oldest && newest ? (newest - oldest) / 60000 : 0,
      caughtUpTo: newest ? newest.toISOString() : null,
      creditsCharged: creditsCharged
    };
    return reader.lastAudit;
  }

  reader.poll = poll;

  reader.start = function (mmsiList) {
    reader.stopped = false;
    // For MyShipTracking testing: don't auto-poll, only poll on demand via /api/refresh
    // Set MYSHIPTRACKING_AUTO_POLL=1 to enable auto-polling
    if (process.env.MYSHIPTRACKING_AUTO_POLL === '1') {
      var run = function () {
        if (reader.stopped) return;
        poll(mmsiList).then(function (a) {
          store.lastError = null;
          log('myshiptracking: ' + a.applied + ' new fixes from ' + a.reports +
            ' vessels | ' + a.creditsCharged + ' credits' +
            (a.strangers.length ? ', ' + a.strangers.length + ' not ours' : ''));
        }).catch(function (err) {
          store.lastError = (err && err.message) || String(err);
          log('myshiptracking: ' + store.lastError);
        });
      };
      run();
      reader.timer = setInterval(run, Math.max(30, c.pollSeconds) * 1000);
      if (reader.timer.unref) reader.timer.unref();
    } else {
      log('myshiptracking: on-demand polling only. Use /api/refresh to fetch data.');
    }
  };

  reader.stop = function () {
    reader.stopped = true;
    clearInterval(reader.timer);
    reader.timer = null;
  };

  function num(v) {
    if (v == null || v === '') return null;
    var n = Number(v);
    return isFinite(n) ? n : null;
  }

  function text(v) {
    if (v == null) return null;
    var s = String(v).trim();
    return s ? s : null;
  }

  return reader;
}

module.exports = { create: create };
