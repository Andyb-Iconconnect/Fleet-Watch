/* -----------------------------------------------------------------------------
 * vesselapi.js — the third AIS provider, and the first one that is a stream.
 *
 * AISstream was measured for a fortnight and cannot do this job: thirty-five of
 * the sixty-one never appeared, and its busiest vessel out of twenty-six
 * thousand was heard nine times in four minutes when a ship underway broadcasts
 * every two to ten seconds. MarineTraffic has no tier that reaches sixty
 * vessels. Kpler is an enterprise contract. Datalastic is €569 a month.
 *
 * VesselAPI answers all sixty-one for one request, and everything in the first
 * real answer was ours — the MMSI filter works, which AISstream's did not.
 *
 * IT IS NOT A "WHERE IS EACH OF MY VESSELS NOW" ENDPOINT, AND THAT IS THE WHOLE
 * DESIGN OF THIS FILE. It answers with a stream of position REPORTS, newest
 * first, a page at a time, with a cursor. Twenty records covered four minutes
 * and held twelve distinct yachts, several of them twice.
 *
 * Two consequences, and both are load-bearing:
 *
 *   1. THE BILL FOLLOWS THE FLEET'S CHATTER, NOT OUR REFRESH RATE. Polling for
 *      positions costs a request every time you look. Reading a stream costs a
 *      request per page of reports however often you look — so this file keeps
 *      a watermark and reads only what is new. Looking every two minutes and
 *      looking every twenty cost very nearly the same.
 *
 *   2. A PAGE IS NOT A FLEET. Twelve vessels in a page does not mean twelve are
 *      carried; it means the rest have not spoken in four minutes. Nothing here
 *      may conclude a yacht is missing from a single page, and `audit()` says
 *      how far back the window actually reached.
 *
 * TWO THINGS ARE STILL GUESSES, deliberately visible in config rather than
 * buried here: the query parameter that sends the cursor back (`cursorParam`)
 * and the one that asks for a bigger page (`pageParam`). The answer tells us
 * the cursor's NAME in the body but not what to call it going out. Both are
 * checked at runtime — see the loop guard in `readPage`.
 *
 * Everything ends up in the same Store the AIS socket writes to, so the board
 * cannot tell which provider it is drawing.
 * -------------------------------------------------------------------------- */

(function () {
  'use strict';

  var VA = {
    timer: null,
    stopped: true,
    calls: 0,            // requests this run has made — what it costs
    callsLastPoll: 0,
    lastError: null,
    lastAudit: null,
    // The newest fix we have applied. Everything at or before it has been seen,
    // so paging stops there. Null until the first answer, which is what makes
    // the first poll a backfill rather than a peek.
    since: null
  };

  function cfg() {
    return window.CONFIG.vesselApi || {};
  }

  /**
   * One URL, all sixty-one.
   *
   * Their filter takes a comma-separated list and costs a single request, which
   * is the only reason this provider is affordable at all.
   */
  function url(key, mmsiList, token) {
    var c = cfg();
    var base = (c.endpoint || 'https://api.vesselapi.com/v1/vessels/positions')
      .replace(/\/+$/, '');
    var q = ['filter.idType=mmsi',
             'filter.ids=' + encodeURIComponent(mmsiList.join(','))];
    if (c.pageSize) q.push(encodeURIComponent(c.pageParam || 'limit') +
      '=' + encodeURIComponent(c.pageSize));
    if (token) q.push(encodeURIComponent(c.cursorParam || 'nextToken') +
      '=' + encodeURIComponent(token));
    // The key travels in a header, never here: a URL is logged by every proxy
    // it passes and printed by every diagnostic that touches it.
    return base + '?' + q.join('&');
  }

  VA.url = url;                        // so a test can read what would be sent

  VA.start = function (key, mmsiList) {
    VA.stop();
    VA.stopped = false;
    VA.calls = 0;
    VA.lastError = null;
    VA.since = null;
    VA.key = key;
    VA.mmsiList = (mmsiList || []).map(String);

    window.Store.setConnection('listening');
    poll();
    VA.timer = setInterval(poll, Math.max(1, cfg().pollMinutes || 3) * 60000);
  };

  VA.stop = function () {
    VA.stopped = true;
    clearInterval(VA.timer);
    VA.timer = null;
  };

  /**
   * One pass down the stream.
   *
   * Pages until it reaches a report it has already seen, runs out of cursor, or
   * spends its budget. The budget is the difference between a provider that
   * costs eleven pounds a month and one that empties the allowance in an
   * afternoon because something upstream started repeating itself.
   */
  function poll() {
    if (VA.stopped) return;
    var c = cfg();
    var budget = Math.max(1, VA.since == null
      ? (c.backfillPages || 12)     // the first look has to fill an empty board
      : (c.pagesPerPoll || 4));

    var rows = [];
    var token = null;
    var firstPageStamp = null;
    var pages = 0;
    VA.callsLastPoll = 0;

    var step = function () {
      if (VA.stopped) return null;
      VA.calls++;
      VA.callsLastPoll++;
      return window.fetch(url(VA.key, VA.mmsiList, token), {
        method: 'GET',
        headers: { 'Authorization': 'Bearer ' + VA.key, 'Accept': 'application/json' }
      }).then(function (res) {
        if (!res.ok) throw new Error('HTTP ' + res.status);
        return res.json();
      }).then(function (body) {
        var page = readPage(body);
        pages++;

        var stamp = page.rows.length ? String(page.rows[0][stampKey(page.rows[0])]) : null;
        if (pages === 1) {
          firstPageStamp = stamp;
        } else if (stamp && stamp === firstPageStamp) {
          /**
           * The cursor went back and was ignored: page two is page one. Paging
           * on would spend the allowance re-reading a single page for ever,
           * which is a loop with an invoice attached and no symptom on the
           * board — the positions would simply stop moving.
           */
          VA.lastError = 'The cursor is not accepted as "' +
            (cfg().cursorParam || 'nextToken') + '". Their documentation names ' +
            'it; set CONFIG.vesselApi.cursorParam.';
          return done(rows, pages, true);
        }

        rows = rows.concat(page.rows);

        // Caught up: this page reaches back to something already applied.
        var caughtUp = VA.since != null && page.rows.some(function (r) {
          var at = parseTime(r.timestamp);
          return at && at <= VA.since;
        });

        if (caughtUp || !page.token || !page.rows.length || pages >= budget) {
          return done(rows, pages, false);
        }
        token = page.token;
        return step();
      });
    };

    /**
     * One catch for the whole chain.
     *
     * `step` recurses by returning the next page's promise, so a rejection
     * anywhere down the chain surfaces here. Attaching a catch inside `step`
     * would swallow the failure of the page after it and leave the board
     * showing positions that had quietly stopped arriving.
     */
    step().catch(function (err) {
      /**
       * A browser refusing the request on CORS grounds throws a TypeError with
       * a useless message and looks exactly like being offline. Said plainly,
       * because the two have completely different fixes: one is a relay, the
       * other is a cable.
       */
      VA.lastError = err && err.message === 'Failed to fetch'
        ? 'The browser would not make the request. That is CORS — this API is ' +
          'meant to be called from a server, and a key in an Authorization ' +
          'header makes the browser ask permission first. Point ' +
          'CONFIG.vesselApi.endpoint at the relay.'
        : (err && err.message) || String(err);
      window.Store.setConnection('retrying');
    });
  }

  function stampKey(row) {
    return row && row.timestamp != null ? 'timestamp' : 'processed_timestamp';
  }

  /**
   * The records and the cursor, without knowing what they are called.
   *
   * Their list is `vesselPositions` today. Hard-coding that means reporting an
   * empty fleet the day it is renamed — which reads on the board as every yacht
   * going quiet at once, not as a schema change.
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

  /**
   * The newest report per vessel, applied once.
   *
   * The stream carries the same broadcast more than once — the first real
   * answer had RADIANT at 22:32:42.238727Z and again at 22:32:42Z, same
   * position, different processing times, plainly one transmission heard twice.
   * Applied as they come, each duplicate counts as another message received and
   * the reception figures on the console overstate the feed.
   */
  function done(rows, pages, stop) {
    var newest = {};
    var glitches = 0;
    var seen = 0;
    var mark = VA.since;
    var newestAt = VA.since;

    rows.forEach(function (row) {
      var mmsi = row.mmsi != null ? String(row.mmsi) : null;
      if (!mmsi) return;
      // Their own quality flag. A position they doubt is a yacht drawn in a
      // field, and we would rather show her last good fix ageing.
      if (row.suspected_glitch) { glitches++; return; }
      var at = parseTime(row.timestamp);
      if (!at) return;
      /**
       * Already applied on an earlier poll.
       *
       * Every poll's last page necessarily overlaps the previous one — that
       * overlap is HOW it knows it has caught up. Without this the same reports
       * are applied again on every poll, and the console's message count, which
       * exists to measure the feed, measures the reader instead.
       */
      if (mark && at <= mark) { seen++; return; }
      if (!newest[mmsi] || at > newest[mmsi].at) newest[mmsi] = { at: at, row: row };
      if (!newestAt || at > newestAt) newestAt = at;
    });

    Object.keys(newest).forEach(function (mmsi) {
      apply(mmsi, newest[mmsi].row, newest[mmsi].at);
    });

    VA.since = newestAt;
    VA.lastAudit = audit(rows, newest, pages, glitches, seen);
    if (!stop) VA.lastError = null;
    window.Store.setConnection(stop ? 'retrying' : 'open');

    /**
     * Saved BEFORE anyone is told, and the order is not cosmetic. recompute()
     * notifies the console, which adopts anything this batch filled in, which
     * reloads the fleet, which re-inits the Store — and Store.init restores
     * from the cache. Persisting afterwards meant restore read a cache written
     * before this batch existed, so a poll that plainly worked ended with an
     * empty store.
     */
    window.Store.persist();
    window.Store.recompute();
    return VA.lastAudit;
  }

  /**
   * One report into the store.
   *
   * Units, from a real response rather than from documentation: `sog` is plain
   * knots (Mary Jean II at 16.4, not 164), `cog` and `heading` are degrees,
   * `nav_status` is the ordinary AIS code. No knots-times-ten trap here, unlike
   * MarineTraffic — but it is checked rather than assumed, because that one has
   * already cost this project a day.
   */
  function apply(mmsi, row, at) {
    window.Store.applyFix(mmsi, {
      lat: num(row.latitude),
      lon: num(row.longitude),
      sog: num(row.sog),
      cog: num(row.cog),
      heading: num(row.heading),
      navStatus: num(row.nav_status),
      at: at,
      // They do not say whether a fix came from a shore receiver or a
      // satellite, so this stays null rather than claiming terrestrial.
      source: null
    });

    if (row.vessel_name != null || row.imo != null) {
      window.Store.applyIdentity(mmsi, {
        name: text(row.vessel_name),
        imo: num(row.imo) || null
      });
    }
  }

  /**
   * Their timestamps are ISO 8601 and carry a Z, which is the difference
   * between this provider and MarineTraffic — theirs are UTC and say so
   * nowhere, so JavaScript reads them as local time and every age on the board
   * is an hour out all summer. Nothing is appended here, on purpose: appending
   * a Z to a stamp that already has an offset would corrupt it.
   */
  function parseTime(raw) {
    if (!raw) return null;
    var d = new Date(String(raw));
    return isFinite(d.getTime()) ? d : null;
  }

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

  /**
   * What arrived, and what it cost.
   *
   * `heard` is NOT coverage and must never be reported as it. A window of four
   * minutes holds whoever spoke in four minutes; a yacht alongside broadcasts
   * every three, and her static data every six. `windowMinutes` is what makes
   * the number readable — twelve vessels in four minutes and twelve in forty
   * are completely different findings.
   */
  function audit(rows, newest, pages, glitches, seen) {
    var ours = {}, strangers = [];
    (VA.mmsiList || []).forEach(function (m) { ours[m] = true; });
    Object.keys(newest).forEach(function (m) {
      if (!ours[m]) strangers.push(m);
    });

    var times = rows.map(function (r) { return parseTime(r.timestamp); })
      .filter(Boolean).map(function (d) { return d.getTime(); }).sort();

    return {
      reports: rows.length,
      pages: pages,
      calls: VA.callsLastPoll,
      heard: Object.keys(newest).length - strangers.length,
      // Anything here means the MMSI filter is not being applied, which is the
      // failure that cost a fortnight on AISstream.
      strangers: strangers,
      glitches: glitches,
      // Reports that arrived again because the last page of a poll overlaps the
      // previous one. Not waste — it is the overlap that proves nothing was
      // missed — but it should be small, and a large figure means the poll is
      // reaching further back than it needs to.
      alreadySeen: seen || 0,
      windowMinutes: times.length > 1
        ? (times[times.length - 1] - times[0]) / 60000 : 0
    };
  }

  VA._readPage = readPage;
  VA._apply = apply;
  VA._done = done;
  VA._audit = audit;
  VA._parseTime = parseTime;

  window.VesselApi = VA;
})();
