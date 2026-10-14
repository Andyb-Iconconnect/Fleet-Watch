/* -----------------------------------------------------------------------------
 * vercel.js — the relay, as Vercel runs it.
 *
 * Vercel does not run a server. It calls an exported function once per
 * request, and between requests the whole process is frozen — or thrown away
 * and started again cold. server/index.js listens on a port and reads the
 * feeds on timers, neither of which means anything here, so this is the
 * entry vercel.json points at instead.
 *
 * The relay is assembled once per instance, at the first request, and kept
 * for as long as Vercel keeps the instance warm. A cold instance restores from
 * the snapshot before it answers, if there is one, so a screen is not handed
 * an empty fleet just because Vercel recycled something.
 *
 * WHAT DOES NOT CARRY OVER from a server that stays up:
 *   - nothing runs between requests, so anything that relies on a timer only
 *     happens while a request is being answered. Domotz copes with this by
 *     reading when a screen asks and a read is due (see domotz.js).
 *   - each instance holds its own fleet in memory. Vercel may run several at
 *     once, and a new one starts from the snapshot, not from its siblings.
 * -------------------------------------------------------------------------- */

'use strict';

const relay = require('./index.js');

// How long the first request on a cold instance may wait for the snapshot and
// the feed to come up before it is answered with whatever there is.
const BEGIN_WAIT_MS = 4000;

let ctx = null;
let begun = null;

function ready() {
  if (!ctx) {
    ctx = relay.create(process.env);
    // Positions are read when a screen asks, not on a timer — see app.js.
    ctx.onDemand = true;
    begun = relay.begin(ctx, ctx.fleet).catch(function (err) {
      relay.log('the feed did not start: ' + ((err && err.message) || err));
      ctx.store.lastError = (err && err.message) || String(err);
    });
  }
  let timer;
  const cap = new Promise(function (resolve) { timer = setTimeout(resolve, BEGIN_WAIT_MS); });
  return Promise.race([begun, cap]).then(function () {
    clearTimeout(timer);
    return ctx;
  });
}

module.exports = function handler(req, res) {
  return ready().then(function (c) {
    return c.app.handle(req, res);
  });
};
