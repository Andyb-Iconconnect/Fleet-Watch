/* -----------------------------------------------------------------------------
 * marinetraffic.js — the second AIS provider.
 *
 * AISstream was measured for a fortnight and cannot do this job: its busiest
 * vessel out of twenty-six thousand was heard nine times in four minutes, when
 * a ship underway broadcasts every two to ten seconds, and thirty-five of the
 * sixty-one were never carried at all. That is its receiver network, not our
 * subscription — we eliminated the key, the message-type filter, the MMSI
 * filter, the bounding box and the fleet data in turn.
 *
 * MarineTraffic is where the fleet was validated in the first place, so we
 * already know it has all sixty-one.
 *
 * IT IS A DIFFERENT SHAPE OF THING. AISstream is a socket that pushes; this is
 * an HTTP endpoint you ask. So this file polls, and how often it polls is what
 * it costs. A yacht at twelve knots moves twelve miles in an hour, which is
 * invisible at fleet zoom, so the board does not need minutes.
 *
 * TWO THINGS TO KNOW BEFORE TRUSTING THIS FILE
 *
 *   1. The field mapping below is taken from MarineTraffic's own published
 *      client library and its test fixtures — real field names, real units,
 *      a real sample response — but NOT from a response this code has seen.
 *      Nobody here has a key. `MarineTraffic.audit()` exists for that first
 *      live call: it reports what arrived against what was expected, so the
 *      mapping is checked rather than assumed.
 *
 *   2. This is a server-side API. A browser calling it directly will very
 *      likely be refused by CORS, because services.marinetraffic.com has no
 *      reason to allow a page it has never heard of. `endpoint` is therefore
 *      configurable: point it at the relay when there is one, and the relay
 *      holds the key as well, which is the arrangement we wanted anyway.
 *
 * Everything here ends up in the same Store the AIS socket writes to, so the
 * board cannot tell which provider it is drawing.
 * -------------------------------------------------------------------------- */

(function () {
  'use strict';

  var MT = {
    timer: null,
    stopped: true,
    calls: 0,            // how many requests this run has made — what it costs
    lastError: null,
    lastAudit: null
  };

  /**
   * The PS02 "vessel positions of a fleet" export.
   *
   *   https://services.marinetraffic.com/api/exportvessels/{KEY}
   *     /v:8/protocol:jsono/msgtype:simple/timespan:{minutes}
   *
   * Path segments are `key:value`, not a query string — their own convention.
   * `jsono` is JSON with named keys; plain `json` returns bare arrays whose
   * meaning depends on column order, which is a silent disaster waiting for a
   * schema change.
   */
  function url(key, cfg) {
    var base = (cfg.endpoint || 'https://services.marinetraffic.com/api/exportvessels')
      .replace(/\/+$/, '');
    return base + '/' + encodeURIComponent(key) +
      '/v:8/protocol:jsono/msgtype:simple' +
      '/timespan:' + timespan(cfg);
  }

  /**
   * How far back the answer may reach, in minutes.
   *
   * Their own limits, from the PS02 query parameters: "Maximum value for
   * terrestrial coverage is 60. Maximum value for satellite coverage is 180."
   * Asking for more than the plan allows is not our call to make and not
   * something the board could recover from at three in the morning, so it is
   * clamped here — visibly, rather than by whatever the server decides to do
   * with an out-of-range request.
   *
   * The satellite ceiling only applies on a plan that has satellite. Asking
   * for 180 without it is asking for a refusal.
   */
  function timespan(cfg) {
    var ceiling = cfg.satellite ? 180 : 60;
    var want = Math.round(cfg.timespanMinutes || ceiling);
    return Math.max(1, Math.min(ceiling, want));
  }

  MT.timespan = timespan;

  MT.url = url;                        // so a test can read what would be sent

  MT.start = function (key, mmsiList) {
    MT.stop();
    MT.stopped = false;
    MT.calls = 0;
    MT.lastError = null;
    MT.mmsiList = (mmsiList || []).map(String);
    var cfg = window.CONFIG.marineTraffic || {};

    window.Store.setConnection('listening');
    poll(key, cfg);
    MT.timer = setInterval(function () { poll(key, cfg); },
      Math.max(1, cfg.pollMinutes || 15) * 60000);
  };

  MT.stop = function () {
    MT.stopped = true;
    clearInterval(MT.timer);
    MT.timer = null;
  };

  function poll(key, cfg) {
    if (MT.stopped) return;
    MT.calls++;
    window.fetch(url(key, cfg), { method: 'GET' })
      .then(function (res) {
        if (!res.ok) throw new Error('HTTP ' + res.status);
        return res.json();
      })
      .then(function (body) { receive(body); })
      .catch(function (err) {
        /**
         * A browser refusing the request on CORS grounds throws a TypeError
         * with a useless message, and looks identical to the network being
         * down. Said plainly here, because the two have completely different
         * fixes and guessing wrong costs an afternoon.
         */
        MT.lastError = err && err.message === 'Failed to fetch'
          ? 'The browser would not make the request. That is usually CORS — ' +
            'this API is meant to be called from a server, not a page. Point ' +
            'CONFIG.marineTraffic.endpoint at the relay.'
          : (err && err.message) || String(err);
        window.Store.setConnection('retrying');
      });
  }

  /**
   * What came back.
   *
   * Their errors arrive as `{ errors: [{ code, detail }] }` with a perfectly
   * ordinary 200, so a handler that only checks the HTTP status treats a
   * refusal as an empty fleet — which reads on the board as every yacht having
   * gone quiet at once.
   */
  function receive(body) {
    if (body && body.errors && body.errors.length) {
      MT.lastError = body.errors.map(function (e) {
        return (e.detail || 'error') + ' (code ' + e.code + ')';
      }).join('; ');
      window.Store.setConnection('rejected');
      return;
    }

    var rows = Array.isArray(body) ? body : [];
    MT.lastError = null;
    window.Store.setConnection('open');
    MT.lastAudit = audit(rows);

    rows.forEach(function (row) { apply(row); });

    /**
     * Saved BEFORE anyone is told, and the order is not cosmetic.
     *
     * recompute() notifies the console, which adopts any length or call sign
     * this batch filled in, which reloads the fleet, which re-inits the Store —
     * and Store.init restores from the cache. Persisting afterwards meant that
     * restore read a cache written before this batch existed, so a poll that
     * successfully fetched twelve vessels ended with none: every fix applied,
     * then thrown away by the reload it had itself provoked.
     *
     * Found by driving the console against a stand-in and finding the store
     * empty after a request that had plainly worked.
     */
    window.Store.persist();
    window.Store.recompute();
  }

  /**
   * One row into the store.
   *
   * Every value in a jsono response is a STRING, including the numbers, and
   * two of them are scaled: speed is knots x10 and draught is metres x10.
   * Taking SPEED at face value puts the fleet at seventy knots.
   */
  function apply(row) {
    var mmsi = row.MMSI != null ? String(row.MMSI) : null;
    if (!mmsi) return;
    // No check that she is ours: every Store.apply* already refuses an MMSI it
    // does not hold, and a second guard here was one no test could tell from
    // its absence. Their fleet may well be wider than ours — the audit says by
    // how much, which is the part worth having.

    var at = parseTime(row.TIMESTAMP);
    window.Store.applyFix(mmsi, {
      lat: num(row.LAT),
      lon: num(row.LON),
      sog: num(row.SPEED) == null ? null : num(row.SPEED) / 10,
      cog: num(row.COURSE),
      heading: num(row.HEADING),
      navStatus: num(row.STATUS),
      at: at,
      // TER or SAT. Worth keeping: it is the difference between a position
      // from a shore receiver and one from a satellite pass, and it is the
      // whole reason for changing provider.
      source: row.DSRC || null
    });

    window.Store.applyIdentity(mmsi, {
      name: text(row.SHIPNAME),
      callSign: text(row.CALLSIGN),
      imo: num(row.IMO) || null,
      shipType: num(row.SHIPTYPE),
      loa: num(row.LENGTH),
      beam: num(row.WIDTH)
    });

    if (row.DESTINATION || row.ETA) {
      window.Store.applyVoyage(mmsi, {
        destination: text(row.DESTINATION),
        eta: text(row.ETA),
        draught: num(row.DRAUGHT) == null ? null : num(row.DRAUGHT) / 10
      });
    }
  }

  /**
   * Their timestamps are UTC and say so nowhere: "2017-05-19T09:39:57", with
   * no offset and no Z.
   *
   * JavaScript reads a date-time in that form as LOCAL time. On the office
   * machine in summer that is an hour out; on a screen in Monaco, two. Every
   * fix would be stamped wrong, every age wrong, and "seen 40 minutes ago"
   * would be a lie told confidently. The Z goes on here.
   */
  function parseTime(raw) {
    if (!raw) return new Date();
    var s = String(raw).trim();
    if (!/[Zz]$|[+-]\d{2}:?\d{2}$/.test(s)) s += 'Z';
    var d = new Date(s.replace(' ', 'T'));
    return isFinite(d.getTime()) ? d : new Date();
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
   * What arrived, against what we asked for — and against what this file
   * expects to find in it.
   *
   * Two different jobs, and both matter on the first live call:
   *
   *   - PS02 returns the fleet defined in YOUR MarineTraffic account, not an
   *     MMSI list we send. If a yacht is missing from that fleet she will
   *     never appear here however long the board runs, and nothing else would
   *     ever say so.
   *   - The field mapping in this file was read off MarineTraffic's published
   *     client and its fixtures, not off a response we have seen. If a key is
   *     spelled differently the value silently becomes null. This names any
   *     field that was missing from every row, which is what that looks like.
   */
  function audit(rows) {
    var ours = {}, theirs = {}, extra = [];
    (MT.mmsiList || []).forEach(function (m) { ours[m] = true; });

    rows.forEach(function (r) {
      var m = r.MMSI != null ? String(r.MMSI) : null;
      if (!m) return;
      theirs[m] = true;
      if (!ours[m]) extra.push(m);
    });

    var missing = Object.keys(ours).filter(function (m) { return !theirs[m]; });

    var WANTED = ['MMSI', 'LAT', 'LON', 'SPEED', 'COURSE', 'HEADING', 'STATUS',
                  'TIMESTAMP', 'DSRC', 'SHIPNAME', 'SHIPTYPE', 'CALLSIGN',
                  'LENGTH', 'WIDTH', 'DESTINATION', 'ETA'];
    var absent = WANTED.filter(function (field) {
      return !rows.some(function (r) {
        return Object.prototype.hasOwnProperty.call(r, field);
      });
    });

    return {
      rows: rows.length,
      matched: rows.length - extra.length,
      missing: missing,
      extra: extra,
      absentFields: rows.length ? absent : null,
      // Terrestrial against satellite, which is the reason for being here.
      satellite: rows.filter(function (r) { return r.DSRC === 'SAT'; }).length
    };
  }

  MT._audit = audit;
  MT._apply = apply;
  MT._parseTime = parseTime;
  MT._receive = receive;

  window.MarineTraffic = MT;
})();
