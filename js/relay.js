/* -----------------------------------------------------------------------------
 * relay.js — positions from our own server instead of from a provider.
 *
 * The board stops being a client of the AIS feed and becomes a client of us.
 * Everything that made the direct providers awkward goes away at once:
 *
 *   - THE KEY IS NOT HERE. It is an App Setting on the Web App, and a browser
 *     never learns the provider exists. No more typing it at each screen, no
 *     more of it sitting in localStorage on a machine in a reception area.
 *   - NO CORS, because the board is served by the same app that answers this.
 *     A server-side API refuses a page outright, and a key in an Authorization
 *     header makes the browser ask permission first with a request that API has
 *     no reason to answer. Same origin, and neither happens.
 *   - THE FEED IS READ ONCE FOR THE COMPANY. Every screen used to hold its own
 *     unfiltered AIS subscription — some twelve gigabytes a day each. This is
 *     about eight kilobytes a poll, and a metered provider is billed once
 *     however many walls we hang a television on.
 *
 * WHAT IT COSTS US is that the board is now as fresh as the relay, not as fresh
 * as the sea. Nothing here hides that: every fix carries the time it was
 * actually taken, so a yacht heard forty minutes ago reads as forty minutes
 * old, whether the relay heard her late or we polled late.
 * -------------------------------------------------------------------------- */

(function () {
  'use strict';

  var Relay = {
    timer: null,
    stopped: true,
    polls: 0,
    lastError: null,
    lastSnapshot: null,
    // Tracks come once. They are two orders of magnitude larger than the
    // positions and a board only needs them when it opens; after that it draws
    // its own from what arrives.
    wantTracks: true
  };

  function cfg() {
    return window.CONFIG.relay || {};
  }

  Relay.url = function (withTracks) {
    var base = (cfg().endpoint || '/api/fleet').replace(/\/+$/, '');
    return base + (withTracks ? '?tracks=1' : '');
  };

  Relay.start = function () {
    Relay.stop();
    Relay.stopped = false;
    Relay.wantTracks = true;
    window.Store.setConnection('listening');
    poll();
    Relay.timer = setInterval(poll, Math.max(5, cfg().pollSeconds || 30) * 1000);
  };

  Relay.stop = function () {
    Relay.stopped = true;
    clearInterval(Relay.timer);
    Relay.timer = null;
  };

  function poll() {
    if (Relay.stopped) return;
    Relay.polls++;

    window.fetch(Relay.url(Relay.wantTracks), {
      // The board is a screensaver that runs for weeks. Without this a proxy
      // between it and the Web App can serve the same fleet all afternoon and
      // nothing on the screen would say so.
      cache: 'no-store'
    }).then(function (res) {
      if (!res.ok) throw new Error('HTTP ' + res.status);
      return res.json();
    }).then(function (snap) {
      receive(snap);
    }).catch(function (err) {
      /**
       * The relay being unreachable is the one failure this board could not
       * have before, and it must not look like a quiet sea. The connection goes
       * to retrying, which the console reports, and every fix on screen carries
       * on ageing from the time it was taken.
       */
      Relay.lastError = (err && err.message) || String(err);
      window.Store.setConnection('retrying');
    });
  }

  function receive(snap) {
    if (!snap || !Array.isArray(snap.vessels)) {
      Relay.lastError = 'The relay answered with something that is not a fleet.';
      window.Store.setConnection('retrying');
      return;
    }

    Relay.lastError = null;
    Relay.lastSnapshot = snap;
    window.Store.setConnection('open');

    snap.vessels.forEach(function (row) {
      var mmsi = String(row.mmsi);
      var v = window.Store.byMmsi[mmsi];
      if (!v) return;      // theirs, not ours — the relay filters, but say so

      // Seeded before the fix, so the first fix does not become the only point
      // on a track we were handed in full.
      if (row.track && row.track.length && !v.track.length) {
        v.track = row.track.map(function (p) {
          return { lon: p[0], lat: p[1], at: new Date(p[2]) };
        });
      }

      window.Store.applyFix(mmsi, {
        lat: row.lat, lon: row.lon,
        sog: row.sog, cog: row.cog, heading: row.heading,
        navStatus: row.navStatus, source: row.source,
        at: new Date(row.at)
      });

      if (row.ais) window.Store.applyIdentity(mmsi, row.ais);
      if (row.voyage) window.Store.applyVoyage(mmsi, row.voyage);
    });

    /**
     * Asked for once — and cleared here, after a good answer, rather than when
     * the request went out. A board that opened during a deployment would
     * otherwise mark them done on a poll that failed and draw no trail at all
     * until somebody reloaded it.
     */
    Relay.wantTracks = false;

    /**
     * Saved BEFORE anyone is told. recompute() notifies the console, which
     * adopts anything this batch filled in, which reloads the fleet, which
     * re-inits the Store — and Store.init restores from the cache. Persisting
     * afterwards meant restore read a cache written before this batch existed,
     * so a poll that plainly worked ended with an empty store. Found on the
     * MarineTraffic adapter and it would have happened here identically.
     */
    window.Store.persist();
    window.Store.recompute();
  }

  Relay._receive = receive;

  window.Relay = Relay;
})();
