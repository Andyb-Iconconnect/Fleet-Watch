/* -----------------------------------------------------------------------------
 * passage.js — where she actually went, read back out of the record.
 *
 * The board holds the present: one position per yacht and the last day of
 * movement it has watched happen. This is the other question — where was she in
 * June, when did she last leave Antibes, how far did she run last season — and
 * it comes from the relay's history table rather than from the feed.
 *
 * NOTHING HERE TOUCHES THE STORE. A passage is a view of a record, not part of
 * the fleet's state: it must not end up in the cache of live fixes, must not
 * survive a reload, and must not make a yacht look as though she has been heard
 * from when she has not. It goes to the map to be drawn and nowhere else.
 *
 * IT IS ONLY EVER AVAILABLE BEHIND THE RELAY. A board opened from a single file
 * on a stick has no server to ask, and a relay without SQL has no table. Both
 * are ordinary states rather than faults, so the whole section is simply absent
 * rather than present and broken.
 * -------------------------------------------------------------------------- */

(function () {
  'use strict';

  var Passage = {
    // Unknown until asked. Not false: false would mean "asked, and there is
    // none", and the console would hide a panel it has not established is
    // unavailable.
    availability: null,
    lastError: null
  };

  /**
   * The windows worth having as a button.
   *
   * A season rather than a year: a superyacht year is two of them, and "this
   * summer" is the question people actually ask. Anything else is the two date
   * fields beside these.
   */
  Passage.RANGES = [
    { id: '7d', label: '7 days', days: 7 },
    { id: '30d', label: '30 days', days: 30 },
    { id: '90d', label: '3 months', days: 90 },
    { id: 'season', label: 'This season', season: true }
  ];

  /**
   * A window, from a preset.
   *
   * The Mediterranean season runs May to October and the Caribbean one from
   * November — so "this season" means the current half of the year rather than
   * a fixed set of months, and in November it means the winter that has just
   * started rather than the summer that has just finished.
   */
  Passage.rangeFor = function (id, now) {
    var end = now ? new Date(now) : new Date();
    var preset = null;
    for (var i = 0; i < Passage.RANGES.length; i++) {
      if (Passage.RANGES[i].id === id) preset = Passage.RANGES[i];
    }
    if (!preset) return null;

    if (preset.season) {
      var month = end.getUTCMonth();          // 0 = January
      var summer = month >= 4 && month <= 9;  // May to October
      var start = summer
        ? new Date(Date.UTC(end.getUTCFullYear(), 4, 1))
        : new Date(Date.UTC(month <= 3 ? end.getUTCFullYear() - 1 : end.getUTCFullYear(),
                            10, 1));
      return { from: start, to: end };
    }
    return { from: new Date(end.getTime() - preset.days * 86400000), to: end };
  };

  Passage.url = function (mmsi, from, to) {
    var base = (window.CONFIG.relay && window.CONFIG.relay.historyEndpoint) ||
      '/api/history';
    return base + '?mmsi=' + encodeURIComponent(String(mmsi)) +
      '&from=' + encodeURIComponent(from.toISOString()) +
      '&to=' + encodeURIComponent(to.toISOString());
  };

  /**
   * Is there a record to ask at all?
   *
   * Asked once, of the relay's own health, rather than by making a history
   * request and reading the failure — because a failed history request and an
   * unavailable one look the same from here and only one of them is worth
   * showing a person.
   */
  Passage.probe = function () {
    if (window.CONFIG.provider !== 'relay') {
      Passage.availability = { ok: false, reason: 'This board is not behind the relay.' };
      return Promise.resolve(Passage.availability);
    }
    return window.fetch('/api/health', { cache: 'no-store' })
      .then(function (res) {
        // Checked before parsing. A board served by anything that is not the
        // relay answers 404 with an empty body, and reading that as JSON throws
        // "Unexpected end of JSON input" — which is true, and tells nobody
        // anything. Seen when the console was opened from a plain file server.
        if (!res.ok) throw new Error('there is no relay at this address');
        return res.json();
      })
      .then(function (health) {
        var history = health && health.history;
        Passage.availability = history && history !== 'not configured' && history.ready
          ? { ok: true }
          : { ok: false, reason: history === 'not configured' || !history
              ? 'The relay is not keeping a record of where they have been.'
              : 'The record is not available: ' + (history.error || 'not ready') };
        return Passage.availability;
      })
      .catch(function (err) {
        Passage.availability = { ok: false,
          reason: 'The relay did not answer: ' + ((err && err.message) || err) };
        return Passage.availability;
      });
  };

  Passage.load = function (mmsi, from, to) {
    Passage.lastError = null;
    return window.fetch(Passage.url(mmsi, from, to), { cache: 'no-store' })
      .then(function (res) {
        return res.json().then(function (body) { return { res: res, body: body }; });
      })
      .then(function (got) {
        if (!got.res.ok) {
          throw new Error((got.body && got.body.error) || ('HTTP ' + got.res.status));
        }
        var points = Passage.points(got.body.positions || []);
        return {
          points: points,
          truncated: !!got.body.truncated,
          summary: Passage.summarise(points)
        };
      })
      .catch(function (err) {
        Passage.lastError = (err && err.message) || String(err);
        throw err;
      });
  };

  /**
   * Rows into points, and rows we cannot draw thrown away rather than drawn
   * wrongly. A row with no position is not a gap in a passage; it is not a
   * position at all.
   */
  Passage.points = function (rows) {
    var out = [];
    rows.forEach(function (row) {
      // Checked for absence BEFORE conversion: Number(null) is 0 and Number('')
      // is 0, so a row with no latitude survives as the equator and the passage
      // runs off to the Gulf of Guinea. Found by feeding one in.
      if (row.lat == null || row.lat === '' || row.lon == null || row.lon === '') return;
      var lat = Number(row.lat), lon = Number(row.lon);
      if (!isFinite(lat) || !isFinite(lon)) return;
      if (Math.abs(lat) > 90 || Math.abs(lon) > 180) return;
      var at = new Date(row.reported_at);
      if (!isFinite(at.getTime())) return;
      out.push({ lat: lat, lon: lon, at: at, sog: num(row.sog) });
    });
    out.sort(function (a, b) { return a.at - b.at; });
    return out;
  };

  /**
   * What the passage amounts to.
   *
   * `distanceNm` is the sum of the legs, which is the distance she actually
   * ran rather than the distance between where she started and where she
   * finished — a season spent going out and back would read as nought miles
   * measured end to end.
   *
   * `longestGapHours` is the honest part. The record has only what was heard,
   * and a yacht mid-Atlantic on a terrestrial feed is not heard for a week. A
   * line drawn straight across that gap is a guess, and this is how the person
   * looking at it knows one is there.
   */
  Passage.summarise = function (points) {
    if (!points.length) {
      return { positions: 0, distanceNm: 0, from: null, to: null,
               longestGapHours: 0, topSpeed: null };
    }
    var distance = 0;
    var gap = 0;
    var top = null;
    for (var i = 1; i < points.length; i++) {
      distance += window.Geo.distanceNm(points[i - 1].lon, points[i - 1].lat,
                                        points[i].lon, points[i].lat);
      gap = Math.max(gap, points[i].at - points[i - 1].at);
    }
    points.forEach(function (p) {
      if (p.sog != null && (top == null || p.sog > top)) top = p.sog;
    });
    return {
      positions: points.length,
      distanceNm: distance,
      from: points[0].at,
      to: points[points.length - 1].at,
      longestGapHours: gap / 3600000,
      topSpeed: top
    };
  };

  function num(v) {
    if (v == null || v === '') return null;
    var n = Number(v);
    return isFinite(n) ? n : null;
  }

  window.Passage = Passage;
})();
