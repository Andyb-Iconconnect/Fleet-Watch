/* -----------------------------------------------------------------------------
 * feed.js — where positions come from, decided in one place.
 *
 * There are five: a simulator, a WebSocket that pushes (AISstream), an HTTP
 * endpoint that is polled (MarineTraffic), a paged stream read forward from a
 * watermark (VesselAPI), and our own relay — which is any of those read once
 * on a server and served to every screen. The board and the console should not
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
    var named = window.CONFIG.provider;
    /**
     * The relay is the exception, and it is the whole point of it: there is no
     * key at this end. It lives as an App Setting on the Web App that serves
     * this page, so a board with no key at all is not a board with no feed —
     * and falling back to the simulator here would put invented yachts on a
     * wall in front of customers.
     */
    if (named === 'relay') return 'relay';
    if (!key) return 'demo';
    if (named === 'marinetraffic' || named === 'aisstream' ||
        named === 'vesselapi') return named;
    return 'aisstream';
  };

  /**
   * Simulated or real, decided in one place.
   *
   * Both pages set Store.mode before init, because restoring the cache depends
   * on it — a cache of real fixes must not be loaded into a simulation, nor a
   * simulation's into a live board. They each did it by asking whether there is
   * a key, which was right until the relay, where a board with no key is the
   * most live it has ever been. Asked wrongly it does not fail; it silently
   * throws away the cache and puts invented yachts on a wall.
   */
  Feed.mode = function () {
    return Feed.providerFor(window.Settings.aisKey()) === 'demo' ? 'demo' : 'live';
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
    var mode = Feed.mode();
    if (window.Store.mode !== mode) {
      window.Store.mode = mode;
      window.Store.init(window.FLEET);
    }
    window.Store.mode = mode;

    if (provider === 'relay') {
      window.Relay.start();
    } else if (provider === 'marinetraffic') {
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
    if (window.Relay) window.Relay.stop();
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
