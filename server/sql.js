/* -----------------------------------------------------------------------------
 * sql.js — the Azure SQL connection, and the only place that knows a driver.
 *
 * Everything above this file works in terms of `exec(sql, params)` and
 * `query(sql, params)`. That is what lets the history logic — what is worth
 * recording, how it is batched, how the record is pruned — be tested here
 * against a fake, when nothing in this sandbox speaks TDS.
 *
 * WHAT IS NOT TESTED HERE, AND SHOULD BE ON THE FIRST DEPLOYMENT: this file,
 * and the SQL text in history.js. Neither has met a real Azure SQL. That is the
 * same position the MarineTraffic adapter was in — written off published
 * documentation, and wrong in three ways that only appeared when it met a real
 * server. So `node server/check-sql.js` exists to meet one: it connects,
 * creates the table, writes a row, reads it back and deletes it, and says which
 * step failed. Run it once before trusting any of this.
 *
 * THE DRIVER IS OPTIONAL. The rest of the relay has no dependencies at all, and
 * a board on a wall must not stop because an npm install did. If `tedious` is
 * missing, history is simply off and /api/health says so.
 * -------------------------------------------------------------------------- */

'use strict';

function loadDriver() {
  try { return require('tedious'); }
  catch (e) { return null; }
}

/**
 * A connection string as Azure writes it.
 *
 * A Web App with a linked SQL database is given one in an App Setting called
 * SQLAZURECONNSTR_<name>, in ADO.NET form, and nobody types it out again as
 * four separate settings. Reading it means the relay works with what is already
 * there rather than asking IT to duplicate it.
 */
function fromConnectionString(str) {
  var out = {};
  String(str).split(';').forEach(function (part) {
    var at = part.indexOf('=');
    if (at === -1) return;
    var key = part.slice(0, at).trim().toLowerCase();
    var value = part.slice(at + 1).trim();
    if (key === 'server' || key === 'data source') {
      // "tcp:name.database.windows.net,1433"
      out.server = value.replace(/^tcp:/i, '').split(',')[0];
    } else if (key === 'initial catalog' || key === 'database') {
      out.database = value;
    } else if (key === 'user id' || key === 'uid' || key === 'user') {
      out.user = value;
    } else if (key === 'password' || key === 'pwd') {
      out.password = value;
    }
  });
  return out;
}

function settings(env) {
  var e = env || process.env;
  var found = {};

  if (e.SQL_CONNECTION_STRING) found = fromConnectionString(e.SQL_CONNECTION_STRING);
  else {
    // Whatever Azure called the linked database.
    var linked = Object.keys(e).filter(function (k) {
      return k.indexOf('SQLAZURECONNSTR_') === 0 || k.indexOf('SQLCONNSTR_') === 0;
    })[0];
    if (linked) found = fromConnectionString(e[linked]);
  }

  if (e.SQL_SERVER) found.server = e.SQL_SERVER;
  if (e.SQL_DATABASE) found.database = e.SQL_DATABASE;
  if (e.SQL_USER) found.user = e.SQL_USER;
  if (e.SQL_PASSWORD) found.password = e.SQL_PASSWORD;

  return found.server && found.database ? found : null;
}

/**
 * A value's type, from the value.
 *
 * Whole numbers must go as integers rather than floats: SELECT TOP (@limit)
 * refuses a float outright, and it is the sort of thing that works in every
 * test written against a fake and fails on the first real query.
 */
function typeFor(driver, v) {
  var T = driver.TYPES;
  if (v instanceof Date) return T.DateTime2;
  if (typeof v === 'boolean') return T.Bit;
  if (typeof v === 'number') return Number.isInteger(v) ? T.Int : T.Float;
  return T.NVarChar;
}

function create(cfg, log) {
  var conf = settings(cfg.env);
  if (!conf) return null;

  var driver = loadDriver();
  if (!driver) {
    log('history: the tedious package is not installed, so there is no SQL. ' +
      'Run npm install, or leave the SQL settings unset.');
    return null;
  }

  var db = { connected: false, lastError: null, connectAttempts: 0 };
  var connection = null;
  var connecting = null;

  function build() {
    var options = {
      database: conf.database,
      // Azure SQL requires it and refuses the connection without it.
      encrypt: true,
      trustServerCertificate: false,
      rowCollectionOnRequestCompletion: true,
      requestTimeout: 60000,
      connectTimeout: 30000
    };
    /**
     * A password if there is one, otherwise the Web App's own identity.
     *
     * Managed identity is the better arrangement and needs no secret anywhere:
     * turn on the Web App's system-assigned identity, then in the database
     * CREATE USER [<web app name>] FROM EXTERNAL PROVIDER and grant it
     * db_datareader, db_datawriter and db_ddladmin.
     */
    var authentication = conf.password
      ? { type: 'default', options: { userName: conf.user, password: conf.password } }
      : { type: 'azure-active-directory-msi-app-service', options: {} };

    return { server: conf.server, authentication: authentication, options: options };
  }

  function connect() {
    if (connecting) return connecting;
    connecting = new Promise(function (resolve, reject) {
      db.connectAttempts++;
      var c = new driver.Connection(build());
      c.on('connect', function (err) {
        connecting = null;
        if (err) {
          db.connected = false;
          db.lastError = (err && err.message) || String(err);
          return reject(err);
        }
        connection = c;
        db.connected = true;
        db.lastError = null;
        log('history: connected to ' + conf.database + ' on ' + conf.server +
          (conf.password ? '' : ' using the Web App identity'));
        resolve(c);
      });
      /**
       * A dropped connection is normal on a long-running relay — Azure SQL
       * moves databases between nodes, and a serverless tier pauses one that
       * has been idle. Dropped rather than reconnected here: the next write
       * opens a new one, so the relay does not sit in a reconnect loop
       * overnight while nothing is being written anyway.
       */
      c.on('error', function (err) {
        db.lastError = (err && err.message) || String(err);
        db.connected = false;
        connection = null;
      });
      c.on('end', function () { db.connected = false; connection = null; });
      c.connect();
    });
    return connecting;
  }

  function run(sql, params, wantRows) {
    return connect().then(function () {
      return new Promise(function (resolve, reject) {
        var rows = [];
        var request = new driver.Request(sql, function (err, rowCount) {
          if (err) return reject(err);
          resolve(wantRows ? rows : rowCount);
        });
        Object.keys(params || {}).forEach(function (name) {
          request.addParameter(name, typeFor(driver, params[name]), params[name]);
        });
        if (wantRows) {
          request.on('row', function (columns) {
            var row = {};
            columns.forEach(function (col) { row[col.metadata.colName] = col.value; });
            rows.push(row);
          });
        }
        connection.execSql(request);
      });
    });
  }

  db.exec = function (sql, params) { return run(sql, params, false); };
  db.query = function (sql, params) { return run(sql, params, true); };
  db.close = function () {
    if (connection) { try { connection.close(); } catch (e) { /* going anyway */ } }
    connection = null;
    db.connected = false;
  };
  db.describe = function () {
    return conf.server + '/' + conf.database +
      (conf.password ? ' as ' + conf.user : ' using the Web App identity');
  };

  return db;
}

module.exports = {
  create: create,
  settings: settings,
  fromConnectionString: fromConnectionString,
  typeFor: typeFor,
  loadDriver: loadDriver
};
