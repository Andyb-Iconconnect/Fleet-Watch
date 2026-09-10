/* -----------------------------------------------------------------------------
 * index.js — the relay, started.
 *
 *   node server/index.js
 *
 * Reads the feed once for the whole company and serves the board from the same
 * origin. Configuration is entirely in App Settings; see server/README.md for
 * what to set and, more importantly, for the two Azure settings that decide
 * whether this works at all — Always On, and one instance.
 * -------------------------------------------------------------------------- */

'use strict';

const path = require('path');
const configFile = require('./config.js');
const storeFile = require('./store.js');
const blobFile = require('./blob.js');

function log(msg) {
  // Plain stdout: App Service Log Stream shows it live, and it is the first
  // place anyone looks when a board has stopped moving.
  console.log(new Date().toISOString() + '  ' + msg);
}

function loadFleet() {
  // fleet.js is a browser file that assigns window.FLEET. The same file the
  // board uses, so the relay can never be reading a different fleet from the
  // screens it serves.
  global.window = global.window || {};
  require(path.join(__dirname, '..', 'fleet.js'));
  return global.window.FLEET;
}

function start(env) {
  const cfg = configFile.read(env);
  const fleet = loadFleet();
  const store = storeFile.create(fleet, {
    trackPoints: cfg.trackPoints, provider: cfg.provider
  });
  const blob = blobFile.create(cfg.snapshotUrl, log);

  const ctx = {
    config: cfg, store: store, blob: blob, reader: null,
    problems: function () { return configFile.problems(cfg); }
  };

  const app = require('./app.js').create(ctx);

  app.server.listen(cfg.port, function () {
    log('relay listening on ' + cfg.port +
      (cfg.instanceId ? '  instance ' + cfg.instanceId.slice(0, 8) : ''));
    ctx.problems().forEach(function (p) { log('CONFIGURATION: ' + p); });
  });

  begin(ctx, fleet).catch(function (err) {
    log('the feed did not start: ' + ((err && err.message) || err));
    store.lastError = (err && err.message) || String(err);
  });

  return ctx;
}

/**
 * Fill the board from the last snapshot, then open the feed.
 *
 * In that order, and it matters. A relay restarted at four in the morning that
 * opened the feed first would serve an empty fleet for however long it took the
 * yachts to speak — three minutes for one alongside, days for one mid-ocean.
 * Restoring first means the board comes back with the fleet it had, ageing
 * honestly, and the feed corrects it as the positions arrive.
 */
async function begin(ctx, fleet) {
  const cfg = ctx.config;

  if (ctx.blob.enabled()) {
    const snap = await ctx.blob.load();
    const n = ctx.store.restore(snap);
    log(n ? 'restored ' + n + ' vessels from the last snapshot'
          : 'no snapshot to restore from — this is normal on a first deployment');
  } else {
    log('no SNAPSHOT_BLOB_SAS_URL, so a restart will blank the board until ' +
      'the fleet reports again');
  }

  if (ctx.problems().length) {
    log('not starting a feed: the configuration is incomplete. See /api/health.');
    return;
  }

  /**
   * One reader, and Azure has to be told.
   *
   * Scale this Web App to three instances and three copies of it open three
   * feeds: three times the requests on a metered plan, three times the AIS
   * bandwidth, and a bill nobody can account for — because the board looks
   * exactly the same on all of them. There is no way to detect the others from
   * inside, so this refuses to guess: keep the plan at one instance, or set
   * ALLOW_MULTIPLE_READERS and know what it costs.
   */
  if (cfg.instanceId && !cfg.allowMultipleReaders) {
    log('reading the feed as the single instance. If this Web App is scaled ' +
      'out, EVERY instance will read it and the bill multiplies — keep the ' +
      'plan at one instance.');
  }

  const mmsis = fleet.map(function (y) { return String(y.mmsi); });
  const provider = cfg.provider === 'aisstream'
    ? require('./providers/aisstream.js')
    : require('./providers/vesselapi.js');

  ctx.reader = provider.create(cfg, ctx.store, log);
  ctx.reader.start(mmsis);

  if (ctx.blob.enabled()) {
    const save = setInterval(function () {
      // With tracks: the point of the snapshot is that a restarted board looks
      // like the one that was there before, and a board with no tracks does
      // not.
      ctx.blob.save(ctx.store.snapshot(true));
    }, Math.max(30, cfg.snapshotSeconds) * 1000);
    if (save.unref) save.unref();

    /**
     * And once on the way out.
     *
     * App Service sends SIGTERM before it recycles a container, which is the
     * one moment the in-memory fleet is both complete and about to be lost.
     */
    ['SIGTERM', 'SIGINT'].forEach(function (sig) {
      process.on(sig, function () {
        log('shutting down on ' + sig + ' — saving the snapshot');
        ctx.blob.save(ctx.store.snapshot(true)).then(function () {
          process.exit(0);
        }, function () { process.exit(0); });
      });
    });
  }
}

module.exports = { start: start };

if (require.main === module) start(process.env);
