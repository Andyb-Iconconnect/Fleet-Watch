/* -----------------------------------------------------------------------------
 * vesselapi.js — reading the stream, once, for everybody.
 *
 * The same shape as the browser adapter and for the same reasons: VesselAPI
 * answers with position REPORTS, newest first, a page at a time, with a cursor,
 * so this keeps a watermark and reads forward from it rather than asking "where
 * is everyone" on a timer.
 *
 * WHAT IS DIFFERENT HERE IS THAT IT IS THE ONLY READER. Every screen used to
 * hold its own feed; now one process reads and every screen reads from it. On
 * a metered provider that is the difference between a fixed bill and a bill
 * that grows every time somebody hangs another television on a wall.
 *
 * Which makes the two guards below matter more than they did in a page, not
 * less: a runaway loop here is charged once for the company rather than once
 * for a screen somebody can turn off.
 * -------------------------------------------------------------------------- */

'use strict';

function create(cfg, store, log) {
  var c = cfg.vesselApi;
  var reader = {
    calls: 0,
    lastPollCalls: 0,
    lastAudit: null,
    timer: null,
    stopped: false
  };

  function url(mmsiList, token) {
    var base = String(c.endpoint).replace(/\/+$/, '');
    var q = ['filter.idType=mmsi',
             'filter.ids=' + encodeURIComponent(mmsiList.join(','))];
    if (c.pageSize) {
      q.push(encodeURIComponent(c.pageParam) + '=' + encodeURIComponent(c.pageSize));
    }
    if (token) {
      q.push(encodeURIComponent(c.cursorParam) + '=' + encodeURIComponent(token));
    }
    // The key travels in a header. A URL is logged by every proxy it passes,
    // and on Azure it would land in Application Insights as well.
    return base + '?' + q.join('&');
  }

  reader.url = url;

  /**
   * The records and the cursor, without knowing what they are called.
   *
   * Their list is `vesselPositions` today. Hard-coding that means reporting an
   * empty fleet the day it is renamed — which reads on the board as every yacht
   * going quiet at once rather than as a schema change.
   */
  function readPage(body) {
    var lists = [];
    (function walk(node, depth) {
      if (depth > 6 || node == null || typeof node !== 'object') return;
      if (Array.isArray(node)) {
        var objects = node.filter(function (r) {
          return r && typeof r === 'object' && !Array.isArray(r);
        });
        if (objects.length === node.length && objects.length) lists.push(node);
        return;
      }
      Object.keys(node).forEach(function (k) { walk(node[k], depth + 1); });
    })(body, 0);
    lists.sort(function (a, b) { return b.length - a.length; });
    var token = body && (body.nextToken || body.next_token || body.nextPageToken);
    return { rows: lists[0] || [], token: token || null };
  }

  reader.readPage = readPage;

  async function poll(mmsiList) {
    var mark = store.watermark();
    var budget = Math.max(1, mark ? c.pagesPerPoll : c.backfillPages);
    var token = null;
    var firstPageStamp = null;
    var pages = 0;
    var reports = 0;
    var applied = 0;
    var glitches = 0;
    var strangers = {};
    var oldest = null, newest = null;

    reader.lastPollCalls = 0;

    while (!reader.stopped && pages < budget) {
      reader.calls++;
      reader.lastPollCalls++;

      var res = await fetch(url(mmsiList, token), {
        headers: {
          'Authorization': 'Bearer ' + cfg.key,
          'Accept': 'application/json'
        }
      });
      if (!res.ok) {
        var detail = (await res.text()).slice(0, 400);
        throw new Error('HTTP ' + res.status + ' ' + res.statusText + ' — ' + detail);
      }
      var page = readPage(await res.json());
      pages++;
      reports += page.rows.length;

      var stamp = page.rows.length ? JSON.stringify(page.rows[0]) : null;
      if (pages === 1) {
        firstPageStamp = stamp;
      } else if (stamp && stamp === firstPageStamp) {
        /**
         * The cursor went back and was ignored: page two is page one. Left to
         * run this re-reads a single page until the allowance is gone, and
         * nothing on the board says so — the positions simply stop moving.
         */
        throw new Error('The cursor is not accepted as "' + c.cursorParam +
          '". Their documentation names it; set VESSELAPI_CURSOR_PARAM.');
      }

      var caughtUp = false;
      page.rows.forEach(function (row) {
        var mmsi = row.mmsi != null ? String(row.mmsi) : null;
        if (!mmsi) return;
        // Their own quality flag. A position they doubt is a yacht drawn in a
        // field; her last good fix ageing honestly is better.
        if (row.suspected_glitch) { glitches++; return; }
        var at = new Date(String(row.timestamp));
        if (!isFinite(at.getTime())) return;
        if (!oldest || at < oldest) oldest = at;
        if (!newest || at > newest) newest = at;
        if (mark && at <= mark) { caughtUp = true; return; }

        if (!store.byMmsi[mmsi]) { strangers[mmsi] = true; return; }

        if (store.applyFix(mmsi, {
          lat: num(row.latitude), lon: num(row.longitude),
          sog: num(row.sog), cog: num(row.cog), heading: num(row.heading),
          navStatus: num(row.nav_status),
          // They do not say whether a fix came from a shore receiver or a
          // satellite, so this stays null rather than claiming terrestrial.
          source: null,
          at: at
        })) applied++;

        if (row.vessel_name != null || row.imo != null) {
          store.applyIdentity(mmsi, {
            name: text(row.vessel_name), imo: num(row.imo) || null
          });
        }
      });

      if (caughtUp || !page.token || !page.rows.length) break;
      token = page.token;
    }

    store.lastPollAt = new Date();
    reader.lastAudit = {
      pages: pages, calls: reader.lastPollCalls,
      reports: reports, applied: applied, glitches: glitches,
      // Anything here means the MMSI filter is not being applied, and the whole
      // cost model rests on it being applied.
      strangers: Object.keys(strangers),
      windowMinutes: oldest && newest ? (newest - oldest) / 60000 : 0,
      // Not coverage. A window of four minutes holds whoever spoke in four
      // minutes; a yacht alongside broadcasts every three.
      caughtUpTo: newest ? newest.toISOString() : null
    };
    return reader.lastAudit;
  }

  reader.poll = poll;

  reader.start = function (mmsiList) {
    reader.stopped = false;
    var run = function () {
      if (reader.stopped) return;
      poll(mmsiList).then(function (a) {
        store.lastError = null;
        log('vesselapi: ' + a.applied + ' new fixes from ' + a.reports +
          ' reports in ' + a.calls + ' request(s)' +
          (a.strangers.length ? ', ' + a.strangers.length + ' not ours' : ''));
      }).catch(function (err) {
        store.lastError = (err && err.message) || String(err);
        log('vesselapi: ' + store.lastError);
      });
    };
    run();
    reader.timer = setInterval(run, Math.max(30, c.pollSeconds) * 1000);
    if (reader.timer.unref) reader.timer.unref();
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
