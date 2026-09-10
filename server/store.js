/* -----------------------------------------------------------------------------
 * store.js — the fleet, as the relay holds it.
 *
 * One position per yacht, the newest anyone has heard, plus a short run of
 * where she has been. Deliberately much smaller than the browser's store: the
 * board does its own derivation — status, ports, ages, courses — and a relay
 * that duplicated that would be a second place for the two to disagree.
 *
 * THE POINT OF IT BEING HERE AT ALL is that there is now one reader for the
 * whole company. Every screen used to hold its own AIS socket: five screens
 * meant five subscriptions and, unfiltered, some sixty gigabytes a day between
 * them. On a metered provider it is worse than untidy — five screens would be
 * five times the bill for the same sixty-one yachts. Now the feed is read once
 * and read from many times, and adding a screen costs nothing at all.
 * -------------------------------------------------------------------------- */

'use strict';

function create(fleet, opts) {
  var options = opts || {};
  var trackPoints = options.trackPoints || 240;

  var byMmsi = {};
  var vessels = fleet.map(function (y) {
    var v = {
      mmsi: String(y.mmsi), name: y.name, fix: null, ais: null,
      voyage: null, track: []
    };
    byMmsi[String(y.mmsi)] = v;
    return v;
  });

  var store = {
    byMmsi: byMmsi,
    // The AIS parser in js/ais.js walks this, and reusing that parser rather
    // than writing a second one is the only reason this relay can read a
    // WebSocket feed at all.
    vessels: vessels,
    provider: options.provider || null,
    startedAt: new Date(),
    lastFixAt: null,          // when we last heard ANY of them
    lastPollAt: null,         // when the reader last completed a pass
    messages: 0,
    lastError: null
  };

  /**
   * A position, from whichever provider is running.
   *
   * Refuses an MMSI that is not ours, an impossible coordinate, and a fix older
   * than the one already held — the last of which matters more on a stream than
   * it does on a socket, because a page of history can arrive in any order and
   * a yacht must never walk backwards on a wall board.
   */
  store.applyFix = function (mmsi, fix) {
    var v = byMmsi[String(mmsi)];
    if (!v) return false;
    if (!isFinite(fix.lat) || !isFinite(fix.lon)) return false;
    if (Math.abs(fix.lat) > 90 || Math.abs(fix.lon) > 180) return false;

    var at = fix.at instanceof Date ? fix.at : new Date(fix.at);
    if (!isFinite(at.getTime())) return false;
    if (v.fix && at <= new Date(v.fix.at)) return false;

    v.fix = {
      lat: fix.lat, lon: fix.lon,
      sog: pick(fix.sog, null),
      cog: pick(fix.cog, v.fix ? v.fix.cog : null),
      heading: pick(fix.heading, null),
      navStatus: pick(fix.navStatus, v.fix ? v.fix.navStatus : null),
      source: pick(fix.source, null),
      at: at.toISOString()
    };

    pushTrack(v, fix.lon, fix.lat, at);
    store.messages++;
    store.lastFixAt = new Date();
    return true;
  };

  store.applyVoyage = function (mmsi, data) {
    var v = byMmsi[String(mmsi)];
    if (!v) return false;
    v.voyage = v.voyage || {};
    Object.keys(data).forEach(function (k) {
      if (data[k] != null) v.voyage[k] = data[k];
    });
    return true;
  };

  store.applyIdentity = function (mmsi, data) {
    var v = byMmsi[String(mmsi)];
    if (!v) return false;
    v.ais = v.ais || {};
    Object.keys(data).forEach(function (k) {
      if (data[k] != null) v.ais[k] = data[k];
    });
    return true;
  };

  /**
   * A track point, only once she has actually moved.
   *
   * A yacht alongside broadcasts every three minutes for a fortnight. Recorded
   * unconditionally that is a quarter of a million identical points in the
   * snapshot, all of them at the same berth.
   */
  function pushTrack(v, lon, lat, at) {
    var last = v.track[v.track.length - 1];
    if (last && Math.abs(last[0] - lon) < 0.0005 &&
        Math.abs(last[1] - lat) < 0.0005) return;
    v.track.push([lon, lat, at.toISOString()]);
    if (v.track.length > trackPoints) v.track.splice(0, v.track.length - trackPoints);
  }

  function pick(v, fallback) {
    return v == null ? fallback : v;
  }

  /**
   * What the board is sent.
   *
   * Positions and identity only. Nothing here carries the key, the provider's
   * endpoint, or anything about how it was obtained — this response goes to
   * every screen, and one of them will eventually be somewhere it should not
   * be.
   *
   * Tracks are asked for rather than sent, because they are two orders of
   * magnitude larger than the positions and a board only needs them once. A
   * screen polling every thirty seconds would otherwise pull a third of a
   * megabyte each time to redraw lines it already has.
   */
  store.snapshot = function (withTracks) {
    var vessels = [];
    Object.keys(byMmsi).forEach(function (m) {
      var v = byMmsi[m];
      if (!v.fix) return;
      var row = {
        mmsi: v.mmsi,
        lat: v.fix.lat, lon: v.fix.lon,
        sog: v.fix.sog, cog: v.fix.cog, heading: v.fix.heading,
        navStatus: v.fix.navStatus, source: v.fix.source, at: v.fix.at
      };
      if (v.ais) row.ais = v.ais;
      if (v.voyage) row.voyage = v.voyage;
      if (withTracks && v.track.length > 1) row.track = v.track;
      vessels.push(row);
    });

    return {
      generatedAt: new Date().toISOString(),
      provider: store.provider,
      heard: vessels.length,
      of: fleet.length,
      lastFixAt: store.lastFixAt ? store.lastFixAt.toISOString() : null,
      lastPollAt: store.lastPollAt ? store.lastPollAt.toISOString() : null,
      vessels: vessels
    };
  };

  /**
   * Back from a snapshot after a restart.
   *
   * Azure restarts this app whenever it likes — a deployment, a platform patch,
   * a scale event — and without this the board blanks and fills back in over
   * the following hour as each yacht happens to speak. On a metered stream it
   * costs requests as well: an empty store has no watermark, so the next poll
   * backfills from nothing.
   */
  store.restore = function (snap) {
    if (!snap || !Array.isArray(snap.vessels)) return 0;
    var n = 0;
    snap.vessels.forEach(function (row) {
      var v = byMmsi[String(row.mmsi)];
      if (!v || !row.at) return;
      v.fix = {
        lat: row.lat, lon: row.lon, sog: row.sog, cog: row.cog,
        heading: row.heading, navStatus: row.navStatus,
        source: row.source, at: row.at
      };
      if (row.ais) v.ais = row.ais;
      if (row.voyage) v.voyage = row.voyage;
      if (Array.isArray(row.track)) v.track = row.track.slice(-trackPoints);
      n++;
    });
    // The newest fix restored is the watermark a stream reader starts from.
    store.lastFixAt = snap.lastFixAt ? new Date(snap.lastFixAt) : null;
    return n;
  };

  /**
   * The newest fix we hold, which is where a stream reader resumes.
   *
   * Taken from the fixes themselves rather than from when we last ran, because
   * those are different things: a relay restarted after an hour down has an
   * hour of stream to catch up on, and knowing that is what stops it either
   * re-reading a day or missing the gap.
   */
  store.watermark = function () {
    var newest = null;
    Object.keys(byMmsi).forEach(function (m) {
      var f = byMmsi[m].fix;
      if (!f) return;
      var at = new Date(f.at);
      if (!newest || at > newest) newest = at;
    });
    return newest;
  };

  return store;
}

module.exports = { create: create };
