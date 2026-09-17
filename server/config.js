/* -----------------------------------------------------------------------------
 * config.js — what the relay is, read from App Settings.
 *
 * Every value here comes from the environment rather than from a file in the
 * repository, because one of them is a key. On Azure that means App Settings:
 * Configuration → Application settings on the Web App, where they are stored
 * encrypted and never appear in source control, in a deployment, or in a page.
 *
 * Nothing here has a default that costs money or leaks anything. A relay with
 * no key starts, serves the board, and says loudly that it has no feed —
 * which is a great deal easier to diagnose at eight in the morning than a
 * board full of yachts that have not moved since Tuesday.
 * -------------------------------------------------------------------------- */

'use strict';

function read(env) {
  var e = env || process.env;

  var cfg = {
    // Azure sets PORT. Nothing else may.
    port: Number(e.PORT) || 8080,

    provider: (e.FEED_PROVIDER || '').trim().toLowerCase() || null,
    key: (e.FEED_KEY || '').trim() || null,

    vesselApi: {
      endpoint: e.VESSELAPI_ENDPOINT ||
        'https://api.vesselapi.com/v1/vessels/positions',
      pollSeconds: Number(e.VESSELAPI_POLL_SECONDS) || 180,
      pagesPerPoll: Number(e.VESSELAPI_PAGES_PER_POLL) || 4,
      backfillPages: Number(e.VESSELAPI_BACKFILL_PAGES) || 12,
      pageSize: Number(e.VESSELAPI_PAGE_SIZE) || 0,
      pageParam: e.VESSELAPI_PAGE_PARAM || 'pagination.limit',
      cursorParam: e.VESSELAPI_CURSOR_PARAM || 'pagination.nextToken'
    },

    aisStream: {
      endpoint: e.AISSTREAM_ENDPOINT || 'wss://stream.aisstream.io/v0/stream'
    },

    myShipTracking: {
      endpoint: e.MYSHIPTRACKING_ENDPOINT ||
        'https://api.myshiptracking.com/api/v2/vessel/bulk',
      pollSeconds: Number(e.MYSHIPTRACKING_POLL_SECONDS) || 900
    },

    /**
     * Where the snapshot is kept so a restart does not blank the board.
     *
     * A container-hosted app is restarted whenever Azure feels like it —
     * a deployment, a platform patch, a scale event — and an in-memory fleet
     * goes with it. On a stream provider that is worse than it sounds: the
     * watermark goes too, so the next poll backfills, which costs requests.
     *
     * A blob SAS URL rather than the storage SDK, deliberately. It is one
     * setting, it needs no package, and it can be scoped in the portal to one
     * container with write access and an expiry. Nothing here should be able to
     * reach the rest of their storage account.
     */
    snapshotUrl: (e.SNAPSHOT_BLOB_SAS_URL || '').trim() || null,
    snapshotSeconds: Number(e.SNAPSHOT_SECONDS) || 120,

    // Longest run of positions kept per vessel, for a board that has just
    // opened and would otherwise draw no track at all until it has watched one
    // happen.
    trackPoints: Number(e.TRACK_POINTS) || 240,

    /**
     * More than one instance means more than one reader.
     *
     * Azure will happily run three copies of this app behind one hostname, and
     * each copy would open its own feed: three times the requests on a metered
     * plan, three times the AIS bandwidth, and a bill nobody can account for
     * because the board looks exactly the same. Scale-out is therefore refused
     * unless it is explicitly allowed, and the check is on the instance id
     * Azure itself sets.
     */
    instanceId: e.WEBSITE_INSTANCE_ID || null,
    allowMultipleReaders: /^(1|true|yes)$/i.test(e.ALLOW_MULTIPLE_READERS || ''),

    /**
     * Where the fleet has been, as opposed to where it is.
     *
     * The relay holds the present — one position each and a day's trail, which
     * is what a board draws. "Where was she in June" is a different question
     * and a query rather than a scan, so it lives in Azure SQL. All of this is
     * optional: with no SQL settings the relay behaves exactly as it did.
     *
     * `minNm` and `minMinutes` are what keep it from being useless. A yacht
     * alongside broadcasts every three minutes for a fortnight without moving,
     * and recorded literally that is six and a half thousand identical rows per
     * yacht per fortnight. A row when she has moved, or when half an hour has
     * passed, keeps a berth legible at two rows an hour instead of twenty.
     */
    history: {
      keepDays: Number(e.HISTORY_KEEP_DAYS) || 365,
      minMinutes: e.HISTORY_MIN_MINUTES == null ? 30 : Number(e.HISTORY_MIN_MINUTES),
      // The same threshold the board uses before it adds a point to a trail, so
      // the record and the chart agree about what counts as having moved.
      minNm: e.HISTORY_MIN_NM == null ? 0.05 : Number(e.HISTORY_MIN_NM),
      writeSeconds: Number(e.HISTORY_WRITE_SECONDS) || 120,
      maxRows: Number(e.HISTORY_MAX_ROWS) || 5000
    },

    // Kept so server/sql.js can find whichever of the several names Azure may
    // have given the connection string, without a second copy of the rules.
    env: e
  };

  return cfg;
}

/**
 * What is wrong with this configuration, in words a person can act on.
 *
 * Returned rather than thrown: the relay still starts and still serves the
 * board, and puts these on /api/health where whoever deployed it will look.
 * An app that refuses to boot on a missing setting tells you only that it is
 * down.
 */
function problems(cfg) {
  var out = [];
  if (!cfg.provider) {
    out.push('FEED_PROVIDER is not set. Set it to "vesselapi", "aisstream", or "myshiptracking".');
  } else if (['vesselapi', 'aisstream', 'myshiptracking'].indexOf(cfg.provider) === -1) {
    out.push('FEED_PROVIDER is "' + cfg.provider + '", which is not a provider ' +
      'this relay has. Set "vesselapi", "aisstream", or "myshiptracking".');
  }
  if (!cfg.key) {
    out.push('FEED_KEY is not set, so there is no feed. Add it as an App ' +
      'Setting — never in the repository.');
  }
  if (cfg.provider === 'aisstream' && typeof WebSocket !== 'function') {
    out.push('This Node has no WebSocket, which AISstream needs. Set the Web ' +
      'App to Node 22 LTS or later.');
  }
  return out;
}

module.exports = { read: read, problems: problems };
