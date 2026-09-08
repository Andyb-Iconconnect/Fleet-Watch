/* -----------------------------------------------------------------------------
 * store.js — one place that knows where every yacht is.
 *
 * Feeds (live AIS or the demo simulator) push fixes in; views pull derived state
 * out. Last known positions are cached to localStorage so that a reload, a power
 * cut, or a browser restart brings the board back with content rather than eight
 * empty cards.
 * -------------------------------------------------------------------------- */

(function () {
  'use strict';

  var CACHE_KEY = 'fleetwatch.positions.v1';
  var MAX_TRACK_POINTS = 400;

  var Store = {
    mode: 'demo',              // 'demo' | 'live'
    feedStartedAt: null,       // when the live feed FIRST began listening
    // Counted against feedStartedAt, so the two belong to the same stretch of
    // time. The socket's own counters reset on every reconnect, which put "4
    // messages received" in the same sentence as "21 hours" and read as a feed
    // that had almost stopped. It had reconnected a minute earlier.
    heard: 0, matched: 0, unreadable: 0,
    // Bytes off the wire over that same stretch. The board takes the whole
    // world's AIS and picks its own vessels out of it, which is the only way
    // that has been shown to hear all of them — but it runs on somebody's
    // office connection, so what it costs is measured and shown.
    bytes: 0,
    connection: 'starting',    // starting | connecting | open | retrying | closed | demo
    vessels: [],               // in fleet.js order
    byMmsi: {},
    lastMessageAt: null,
    messageCount: 0,
    listeners: []
  };

  /* --- Setup ------------------------------------------------------------- */

  Store.init = function (fleet) {
    Store.vessels = fleet.map(function (yacht, i) {
      return {
        yacht: yacht,
        // Position in the fleet, fixed at boot. Anonymous mode numbers vessels
        // by it, and a number that changed with what happened to be on screen
        // would be no use to anyone trying to refer to one.
        index: i,
        fix: null,             // { lon, lat, cog, heading, sog, navStatus, at }
        voyage: {},            // { destination, eta, draught } from AIS static messages
        ais: null,             // who the transponder says she is — see applyIdentity
        track: [],             // [{ lon, lat, at }] newest last
        weather: null,
        derived: {}
      };
    });
    Store.byMmsi = {};
    Store.vessels.forEach(function (v) { Store.byMmsi[String(v.yacht.mmsi)] = v; });
    restore();
    Store.recompute();
  };

  /* --- Ingest ------------------------------------------------------------ */

  // A position fix from any source. `at` is a Date; everything else may be null.
  Store.applyFix = function (mmsi, fix) {
    var v = Store.byMmsi[String(mmsi)];
    if (!v) return false;      // not one of ours — ignore
    if (!isFinite(fix.lon) || !isFinite(fix.lat)) return false;
    if (Math.abs(fix.lat) > 90 || Math.abs(fix.lon) > 180) return false;

    var at = fix.at || new Date();
    // Ignore a fix older than the one we already hold, so an out-of-order
    // message can't drag a yacht backwards.
    if (v.fix && v.fix.at && at < v.fix.at) return false;

    if (!v.firstHeardAt) v.firstHeardAt = at;
    v.fix = {
      lon: fix.lon, lat: fix.lat,
      cog: fix.cog != null ? fix.cog : (v.fix ? v.fix.cog : null),
      heading: fix.heading != null ? fix.heading : null,
      sog: fix.sog != null ? fix.sog : null,
      navStatus: fix.navStatus != null ? fix.navStatus : (v.fix ? v.fix.navStatus : null),
      accurate: fix.accurate != null ? fix.accurate : null,
      raim: fix.raim != null ? fix.raim : null,
      turning: fix.turning != null ? fix.turning : null,
      // Where the position came from: 'TER' from a shore receiver, 'SAT' from
      // a satellite pass. AIS itself does not carry this — it is the provider
      // saying how it heard her — so it is null on a feed that does not say.
      // Worth keeping: a satellite fix is why a yacht mid-ocean appears at all,
      // and on a metered plan it is also the expensive kind.
      source: fix.source != null ? fix.source : null,
      at: at
    };

    pushTrack(v, fix.lon, fix.lat, at);
    Store.lastMessageAt = new Date();
    Store.messageCount++;
    return true;
  };

  Store.applyVoyage = function (mmsi, data) {
    var v = Store.byMmsi[String(mmsi)];
    if (!v) return false;
    if (data.destination != null) v.voyage.destination = data.destination;
    if (data.eta != null) v.voyage.eta = data.eta;
    if (data.draught != null) v.voyage.draught = data.draught;
    if (data.callSign != null) v.voyage.callSign = data.callSign;
    Store.lastMessageAt = new Date();
    return true;
  };

  // Identity as the transponder broadcasts it: name, IMO, call sign, ship type
  // and the dimensions she measures herself by. Merged rather than replaced,
  // because the two messages that carry it do not carry all of it.
  Store.applyIdentity = function (mmsi, data) {
    var v = Store.byMmsi[String(mmsi)];
    if (!v) return false;
    // A static message is being heard from even when it carries no position.
    if (!v.firstHeardAt) v.firstHeardAt = new Date();
    v.ais = v.ais || {};
    Object.keys(data).forEach(function (k) {
      if (data[k] != null) v.ais[k] = data[k];
    });
    v.ais.at = new Date();
    Store.lastMessageAt = new Date();
    return true;
  };

  Store.applyWeather = function (mmsi, weather) {
    var v = Store.byMmsi[String(mmsi)];
    if (!v) return;
    v.weather = weather;
  };

  // Only record a track point once the yacht has actually moved, otherwise a
  // vessel alongside accumulates thousands of identical points.
  function pushTrack(v, lon, lat, at) {
    var last = v.track[v.track.length - 1];
    if (last) {
      if (window.Geo.distanceNm(last.lon, last.lat, lon, lat) < 0.05 &&
          at - last.at < 600000) return;
    }
    v.track.push({ lon: lon, lat: lat, at: at });
    trimTrack(v);
  }

  function trimTrack(v) {
    var cutoff = Date.now() - window.CONFIG.display.trackHours * 3600000;
    while (v.track.length && v.track[0].at < cutoff) v.track.shift();
    while (v.track.length > MAX_TRACK_POINTS) v.track.shift();
  }

  /* --- Derived state ----------------------------------------------------- */

  Store.recompute = function () {
    var now = new Date();
    var cfg = window.CONFIG;
    Store.vessels.forEach(function (v) {
      trimTrack(v);
      var d = v.derived;
      d.ageMs = v.fix ? now - v.fix.at : null;
      d.ageMinutes = d.ageMs == null ? null : d.ageMs / 60000;
      d.stale = d.ageMinutes != null && d.ageMinutes > cfg.ais.stalePositionMinutes;
      d.dark = d.ageMinutes == null || d.ageMinutes > cfg.ais.darkPositionHours * 60;
      d.status = deriveStatus(v, d, now);
      d.discreet = !!v.yacht.discreet || !!cfg.discreetMode;

      if (v.fix) {
        // What the rest of the app should draw. In discreet mode this is a
        // deliberately coarse position and everything downstream uses it, so an
        // exact fix can never leak into the map, the labels, or the spotlight.
        var shown = d.discreet
          ? window.Geo.blur(v.fix.lon, v.fix.lat, cfg.discreetRoundingNm)
          : [v.fix.lon, v.fix.lat];
        d.lon = shown[0];
        d.lat = shown[1];
        d.port = window.Geo.nearestPort(d.lon, d.lat, window.PORTS);
        d.sun = window.Geo.sunTimes(now, d.lon, d.lat);
        d.solarAltitude = window.Geo.solarAltitude(now, d.lon, d.lat);
        d.isDaylight = d.solarAltitude > -0.833;
        // Prefer the real shore zone when the weather lookup has given us one;
        // fall back to ship's time (longitude/15) out where no shore zone applies.
        d.localTime = (v.weather && v.weather.utcOffsetSeconds != null)
          ? window.Fmt.timeAtOffset(now, v.weather.utcOffsetSeconds, false)
          : window.Fmt.nauticalTime(now, d.lon);
        d.fromOffice = window.Geo.distanceNm(cfg.office.lon, cfg.office.lat, d.lon, d.lat);
      } else {
        d.lon = d.lat = null;
        d.port = null;
        d.sun = null;
        d.fromOffice = null;
      }

      d.distance24h = trackDistance(v.track, now - 24 * 3600000);
      d.distance7d = trackDistance(v.track, now - 7 * 24 * 3600000);
      d.mismatches = identityMismatches(v);
      d.setAndDrift = setAndDrift(v, d);
    });
    notify();
  };

  // Where the transponder disagrees with the record. Almost always the record
  // is wrong — specifically, the MMSI is somebody else's, which subscribes the
  // board to the wrong yacht and is otherwise completely silent.
  //
  // Names are compared loosely: AIS is upper case, often abbreviated, and the
  // prefix may or may not be in there. Length is compared with a wide tolerance
  // because AIS dimensions are integer metres from the antenna, not a
  // registry LOA. Neither is worth a false alarm.
  var NAME_NOISE = /[^A-Z0-9]/g;

  function identityMismatches(v) {
    var a = v.ais;
    if (!a) return [];
    var y = v.yacht;
    var out = [];

    if (a.name && y.name) {
      var reported = a.name.toUpperCase().replace(NAME_NOISE, '');
      var expected = String(y.name).toUpperCase().replace(NAME_NOISE, '');
      if (reported.indexOf(expected) === -1 && expected.indexOf(reported) === -1) {
        out.push({ field: 'Name', reported: a.name, expected: y.name });
      }
    }
    if (a.imo && y.imo && Number(a.imo) !== Number(y.imo)) {
      out.push({ field: 'IMO', reported: String(a.imo), expected: String(y.imo) });
    }
    if (a.callSign && y.callSign &&
        a.callSign.toUpperCase().replace(NAME_NOISE, '') !==
        String(y.callSign).toUpperCase().replace(NAME_NOISE, '')) {
      out.push({ field: 'Call sign', reported: a.callSign, expected: y.callSign });
    }
    if (a.loa && y.loa && Math.abs(a.loa - y.loa) > Math.max(4, y.loa * 0.1)) {
      out.push({
        field: 'Length', reported: a.loa + ' m', expected: window.Fmt.metres(y.loa)
      });
    }
    return out;
  }

  // The angle between where she is pointing and where she is actually going.
  // Wind and current, in one number — and only meaningful with way on and both
  // figures present, so it is null the rest of the time rather than noise.
  function setAndDrift(v, d) {
    if (!v.fix || d.discreet) return null;
    if (v.fix.heading == null || v.fix.cog == null) return null;
    if (v.fix.sog == null || v.fix.sog < 1) return null;
    var diff = ((v.fix.cog - v.fix.heading + 540) % 360) - 180;
    if (Math.abs(diff) < 4) return null;
    return { degrees: Math.round(Math.abs(diff)), side: diff > 0 ? 'starboard' : 'port' };
  }

  function deriveStatus(v, d, now) {
    if (!v.fix) return 'unknown';
    if (d.dark) return 'dark';

    // AIS navigational status, where the crew have set it correctly.
    if (v.fix.navStatus === 1) return 'anchored';
    if (v.fix.navStatus === 5) return 'moored';

    var sog = v.fix.sog;
    if (sog == null) return 'unknown';
    if (sog >= 0.8) return 'underway';
    // Stationary: alongside if effectively on top of a port, else at anchor.
    if (d.port && d.port.distanceNm < 1.2) return 'moored';
    return 'anchored';
  }

  function trackDistance(track, sinceMs) {
    var total = 0;
    for (var i = 1; i < track.length; i++) {
      if (track[i].at < sinceMs) continue;
      total += window.Geo.distanceNm(track[i - 1].lon, track[i - 1].lat, track[i].lon, track[i].lat);
    }
    return total;
  }

  /* --- Fleet-level rollups ----------------------------------------------- */

  /**
   * How the feed is doing, as opposed to where the fleet is.
   *
   * "Five of sixty-one" means one thing four minutes in and quite another after
   * an hour, and nothing on the board distinguished them. A yacht alongside
   * broadcasts her position every three minutes, so a fleet takes minutes to
   * assemble rather than seconds — and what has not arrived after ten is not
   * late, it is out of range or switched off.
   */
  Store.reception = function () {
    var heard = 0, waiting = 0;
    Store.vessels.forEach(function (v) {
      if (v.firstHeardAt) heard++; else waiting++;
    });
    var seconds = Store.feedStartedAt
      ? Math.max(1, (new Date() - Store.feedStartedAt) / 1000) : 0;
    return {
      heard: heard,
      waiting: waiting,
      total: Store.vessels.length,
      since: Store.feedStartedAt,
      bytes: Store.bytes,
      // Per hour, because that is the unit a monthly allowance is judged in.
      bytesPerHour: seconds ? Store.bytes / seconds * 3600 : 0,
      // Whether the fleet is still assembling, in the sense that a vessel
      // alongside has not yet had time to say anything.
      settling: Store.feedStartedAt
        ? (new Date() - Store.feedStartedAt) < SETTLE_MS : false
    };
  };

  // Three position reports at the slowest ordinary interval. After this, silence
  // is a fact about the vessel rather than about how long you have waited.
  var SETTLE_MS = 10 * 60 * 1000;

  Store.summary = function () {
    var counts = { underway: 0, anchored: 0, moored: 0, dark: 0, unknown: 0 };
    var tracked = 0, distance7d = 0;
    Store.vessels.forEach(function (v) {
      counts[v.derived.status] = (counts[v.derived.status] || 0) + 1;
      if (v.fix && !v.derived.dark) tracked++;
      distance7d += v.derived.distance7d || 0;
    });
    return {
      counts: counts,
      total: Store.vessels.length,
      tracked: tracked,
      distance7d: distance7d
    };
  };

  /* --- Persistence ------------------------------------------------------- */

  // Wrapped because storage throws outright in some privacy configurations,
  // and a wall display must never die over a cache write.
  /**
   * Cache the last known positions, so a reload or a power cut brings the board
   * back with content rather than sixty-one empty cards.
   *
   * DEMO POSITIONS ARE NEVER CACHED. They used to be: this ran every thirty
   * seconds whatever the mode, wrote invented positions into the same store as
   * real ones, and recorded nothing about which was which. So a board that had
   * run in demo mode before the key went in restored those invented positions on
   * its next load and drew them exactly like fixes — and for a vessel the live
   * feed never delivers, an invented position would sit on the chart
   * indefinitely, indistinguishable from a real one and wrong by hundreds of
   * miles.
   *
   * A missing yacht is a fact. A yacht in the wrong place is a lie, and this
   * board is read by people who act on it.
   */
  Store.persist = function () {
    if (Store.mode !== 'live') return;
    try {
      var payload = { savedAt: Date.now(), mode: 'live', vessels: {} };
      Store.vessels.forEach(function (v) {
        if (!v.fix) return;
        payload.vessels[v.yacht.mmsi] = {
          fix: { lon: v.fix.lon, lat: v.fix.lat, cog: v.fix.cog, heading: v.fix.heading,
                 sog: v.fix.sog, navStatus: v.fix.navStatus, accurate: v.fix.accurate,
                 raim: v.fix.raim, turning: v.fix.turning, source: v.fix.source || null,
                 at: v.fix.at.getTime() },
          voyage: v.voyage,
          ais: v.ais || null,
          track: v.track.slice(-120).map(function (p) { return [p.lon, p.lat, p.at.getTime()]; })
        };
      });
      localStorage.setItem(CACHE_KEY, JSON.stringify(payload));
    } catch (e) { /* no cache available; the board still works */ }
  };

  // A cached fix is a vessel we have heard from, even if it was yesterday.
  function restore() {
    var raw;
    try { raw = localStorage.getItem(CACHE_KEY); } catch (e) { return; }
    if (!raw) return;
    var payload;
    try { payload = JSON.parse(raw); } catch (e) { return; }
    if (!payload || !payload.vessels) return;

    // Only a cache that says plainly it holds real fixes. One written before
    // this distinction existed cannot say, so it is discarded: losing a real
    // position costs a reload, and keeping an invented one puts a yacht on the
    // wall in a place she has never been.
    if (payload.mode !== 'live') {
      Store.clearCache();
      return;
    }
    // And never into a demo session, where it would sit under simulated vessels
    // as though the simulation had produced it.
    if (Store.mode !== 'live') return;

    Object.keys(payload.vessels).forEach(function (mmsi) {
      var v = Store.byMmsi[mmsi];
      if (!v) return;                       // fleet.js changed since the cache was written
      var saved = payload.vessels[mmsi];
      if (saved.fix) {
        v.fix = {
          lon: saved.fix.lon, lat: saved.fix.lat, cog: saved.fix.cog,
          heading: saved.fix.heading, sog: saved.fix.sog,
          navStatus: saved.fix.navStatus, accurate: saved.fix.accurate,
          raim: saved.fix.raim, turning: saved.fix.turning,
          source: saved.fix.source || null,
          at: new Date(saved.fix.at)
        };
        // Heard before, even if it was yesterday. Without this a reload reads as
        // a fleet that has gone quiet rather than one already found.
        v.firstHeardAt = new Date(saved.fix.at);
      }
      v.voyage = saved.voyage || {};
      if (saved.ais) {
        v.ais = saved.ais;
        if (v.ais.at) v.ais.at = new Date(v.ais.at);
      }
      v.track = (saved.track || []).map(function (p) {
        return { lon: p[0], lat: p[1], at: new Date(p[2]) };
      });
    });
  }

  Store.clearCache = function () {
    try { localStorage.removeItem(CACHE_KEY); } catch (e) {}
  };

  /* --- Change notification ----------------------------------------------- */

  Store.subscribe = function (fn) { Store.listeners.push(fn); };

  function notify() {
    for (var i = 0; i < Store.listeners.length; i++) {
      try { Store.listeners[i](Store); } catch (e) { console.error('listener failed', e); }
    }
  }

  Store.setConnection = function (state) {
    // The clock a fleet assembles against starts when we begin listening, not
    // when the page loaded — a reconnection does not reset what we already know,
    // but a first connection is where "how long has it had" begins.
    if (state === 'listening' && !Store.feedStartedAt) Store.feedStartedAt = new Date();
    if (Store.connection === state) return;
    Store.connection = state;
    notify();
  };

  window.Store = Store;
})();
