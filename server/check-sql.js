/* -----------------------------------------------------------------------------
 * check-sql.js — does the history table actually work?
 *
 *   node server/check-sql.js
 *
 * Run this ONCE on the Web App (Development Tools → SSH) before trusting the
 * history at all, and again after any change to the database.
 *
 * IT EXISTS BECAUSE THE SQL IN THIS RELAY HAS NEVER MET A REAL SERVER. Nothing
 * in the development sandbox speaks TDS, so the statements in history.js and
 * the driver wiring in sql.js were written against documentation. That is
 * exactly the position the MarineTraffic adapter was in, and it was wrong in
 * three ways that only appeared the first time it met a real one.
 *
 * So this does the whole round trip against the real database — connect,
 * create, write, read, delete — and says which step failed and what to do about
 * it. It writes one row for a made-up MMSI and removes it again, so it can be
 * run on the live database without leaving anything behind.
 * -------------------------------------------------------------------------- */

'use strict';

const configFile = require('./config.js');
const sqlFile = require('./sql.js');
const historyFile = require('./history.js');

// Not a real ship station: MID 999 is unassigned, so this can never collide
// with a vessel anyone might actually add to the fleet.
const PROBE = '999000001';

function log(msg) { console.log(msg); }

async function main() {
  const cfg = configFile.read(process.env);
  const conf = sqlFile.settings(process.env);

  if (!conf) {
    log('No SQL settings found.');
    log('');
    log('Set SQL_SERVER and SQL_DATABASE, or SQL_CONNECTION_STRING, or link the');
    log('database to the Web App so Azure provides SQLAZURECONNSTR_<name>.');
    process.exit(2);
  }
  log('Settings      ' + conf.server + '/' + conf.database +
    (conf.password ? ' as ' + conf.user : ' using the Web App identity'));

  if (!sqlFile.loadDriver()) {
    log('Driver        MISSING — the tedious package is not installed.');
    log('              Run npm install on the Web App, or redeploy.');
    process.exit(1);
  }
  log('Driver        tedious ' + require('tedious/package.json').version);

  const db = sqlFile.create(cfg, function () {});
  const history = historyFile.create(cfg, db, function () {});
  const at = new Date();
  at.setMilliseconds(0);

  try {
    await step('Connect', function () { return db.exec('SELECT 1;', {}); },
      'Check the firewall rule for Azure services, and — if there is no ' +
      'password — that the Web App identity has a user in this database.');

    await step('Create table', function () { return history.ensureSchema(); },
      'The login needs db_ddladmin, or somebody with it should run the CREATE ' +
      'printed by: node -e "console.log(require(\'./server/history.js\').CREATE)"');
    if (!history.ready) throw new Error('the table was not created');

    const stmt = history.statement([{
      mmsi: PROBE, reported_at: at, lat: 43.5, lon: 7.1,
      sog: 8.2, cog: 214.5, heading: 210, nav_status: 0, source: null
    }]);
    await step('Write a row', function () { return db.exec(stmt.sql, stmt.params); },
      'The login needs db_datawriter.');

    /**
     * The same row again.
     *
     * This is the check worth having. The relay writes duplicates as a matter
     * of course — the provider carries them, and the last page of every poll
     * deliberately overlaps the previous one. Without IGNORE_DUP_KEY on the
     * primary key, this second write fails and takes a whole batch of good
     * positions with it, and it would only ever happen in production.
     */
    await step('Write it twice', function () { return db.exec(stmt.sql, stmt.params); },
      'The primary key is missing WITH (IGNORE_DUP_KEY = ON). Duplicate ' +
      'positions will fail whole batches. Drop the table and let this ' +
      'recreate it.');

    const read = await step('Read it back', function () {
      return history.read(PROBE, new Date(at.getTime() - 60000),
        new Date(at.getTime() + 60000), 10);
    }, 'The login needs db_datareader.');
    if (!read.rows.length) throw new Error('the row was written but not found');

    const row = read.rows[0];
    log('              ' + JSON.stringify(row));
    check('latitude survived the round trip', Math.abs(Number(row.lat) - 43.5) < 1e-6);
    check('speed kept its decimal', Math.abs(Number(row.sog) - 8.2) < 0.05);
    check('the time is the same instant',
      Math.abs(new Date(row.reported_at + (/[Zz]$/.test(String(row.reported_at)) ? '' : 'Z'))
        .getTime() - at.getTime()) < 1000 ||
      Math.abs(new Date(row.reported_at).getTime() - at.getTime()) < 1000);

    await step('Tidy up', function () {
      return db.exec('DELETE FROM ' + historyFile.TABLE + ' WHERE mmsi = @mmsi;',
        { mmsi: PROBE });
    }, 'The login needs db_datawriter.');

    log('');
    log('The history table works.');
    db.close();
    process.exit(0);
  } catch (err) {
    log('');
    log('Stopped: ' + ((err && err.message) || err));
    db.close();
    process.exit(1);
  }
}

async function step(name, fn, advice) {
  try {
    const out = await fn();
    log(pad(name) + 'ok');
    return out;
  } catch (err) {
    log(pad(name) + 'FAILED');
    log('              ' + ((err && err.message) || err));
    if (advice) log('              ' + advice);
    throw err;
  }
}

function check(what, ok) {
  log(pad('  ' + what) + (ok ? 'ok' : 'WRONG — the column type does not fit the value'));
}

function pad(s) { return (s + '              ').slice(0, 14); }

main();
