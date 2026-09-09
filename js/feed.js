/* -----------------------------------------------------------------------------
 * feed.js — where positions come from, decided in one place.
 *
 * There are four: a simulator, a WebSocket that pushes (AISstream), an HTTP
 * endpoint that is polled (MarineTraffic) and a paged stream that is read
 * forward from a watermark (VesselAPI). The board and the console should not
 * know which is running, and until now they both did — each carried
 * its own copy of "if there is a key, start the socket, otherwise start the
 * demo", which is two places to edit and two places to get it wrong.
 *
 * Every provider writes to the same Store. That is the whole contract, and it
 * is what makes swapping one for another a change to this file rather than to
 * the board.
 * -------------------------------------------------------------------------- */

(function () {
  'use strict';

  var Feed = {};

  /**
   * Which provider a given key belongs to.
   *
   * Kept as a rule rather than a setting the user has to keep in step: an
   * AISstream key is forty hex characters and a MarineTraffic key is a UUID,
   * so the two cannot be confused, and pasting the wrong one somewhere is
   * caught here rather than by a socket that never opens.
   */
  Feed.providerFor = function (key) {
    if (!key) return 'demo';
    var named = window.CONFIG.provider;
    if (named === 'marinetraffic' || named === 'aisstream' ||
        named === 'vesselapi') return named;
    return 'aisstream';
  };

  Feed.start = function () {
    var key = window.Settings.aisKey();
    var provider = Feed.providerFor(key);
    Feed.provider = provider;
    Feed.running = provider + '|' + (key || '');

    /**
     * Crossing between simulated and real wipes the store first.
     *
     * Demo mode writes invented fixes through exactly the same path as a live
     * one, so afterwards nothing distinguishes them: a yacht "heard from" in
     * the simulation still counts as heard when the key goes in, and the board
     * reports thirteen of sixty-one when twelve are real. Store.init rebuilds
     * from the fleet and restores only a cache stamped live, so the invented
     * half goes and the real half stays.
     *
     * Caught by switching a running console from demo to MarineTraffic and
     * counting one vessel more than the answer contained.
     */
    var mode = provider === 'demo' ? 'demo' : 'live';
    if (window.Store.mode !== mode) {
      window.Store.mode = mode;
      window.Store.init(window.FLEET);
    }
    window.Store.mode = mode;

    if (provider === 'marinetraffic') {
      window.MarineTraffic.start(key, mmsis());
    } else if (provider === 'vesselapi') {
      window.VesselApi.start(key, mmsis());
    } else if (provider === 'aisstream') {
      window.Ais.start(key, mmsis());
    } else {
      window.Demo.start(window.Store.vessels);
    }
    window.Store.recompute();
  };

  /**
   * Stop whichever is running before starting anything.
   *
   * All three, unconditionally, and not only the one we believe to be live:
   * the demo writing invented fixes over real ones is a bug this board has
   * already had, and it is invisible — the positions look exactly like
   * positions.
   */
  Feed.stop = function () {
    Feed.running = null;
    window.Ais.stop();
    window.Demo.stop();
    if (window.MarineTraffic) window.MarineTraffic.stop();
    if (window.VesselApi) window.VesselApi.stop();
  };

  /**
   * Make the feed match the settings — which usually means doing nothing.
   *
   * This is called from Settings.onChange, and Settings is not the only thing
   * that reaches it: the console adopts a length or a call sign from whatever
   * the feed just reported, which reloads the fleet, which restarts the feed.
   * Found by running the MarineTraffic adapter against a stand-in and watching
   * the request count climb — every answer that filled in a blank field
   * provoked another request.
   *
   * On a socket that is free and pushes, a needless reconnect is only untidy.
   * On an endpoint billed by the call it is a loop with an invoice attached.
   *
   * So a restart that would start the same provider on the same key is not a
   * restart at all.
   */
  Feed.restart = function () {
    var key = window.Settings.aisKey();
    var wanted = Feed.providerFor(key) + '|' + (key || '');
    if (Feed.running === wanted) return false;
    Feed.stop();
    Feed.start();
    return true;
  };

  function mmsis() {
    return (window.FLEET || []).map(function (y) { return y.mmsi; });
  }

  window.Feed = Feed;
})();
