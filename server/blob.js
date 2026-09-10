/* -----------------------------------------------------------------------------
 * blob.js — the snapshot, so a restart does not blank the board.
 *
 * Azure restarts this app whenever it likes: a deployment, a platform patch, a
 * scale event, an idle timeout on a plan without Always On. An in-memory fleet
 * goes with it, and the board then fills back in over the following hour as
 * each yacht happens to speak — which on a wall in reception looks exactly like
 * the system being broken.
 *
 * On a metered stream it costs money as well. An empty store has no watermark,
 * so the reader backfills from nothing on the next poll.
 *
 * A SAS URL AND PLAIN HTTP, NOT THE STORAGE SDK. It is one App Setting, it
 * needs no package installed, and it can be scoped in the portal to a single
 * container with write access and an expiry date. Nothing here should be able
 * to reach the rest of their storage account, and with a SAS it cannot.
 * -------------------------------------------------------------------------- */

'use strict';

function create(sasUrl, log) {
  var blob = { url: sasUrl || null, lastError: null, lastSavedAt: null };

  blob.enabled = function () { return !!blob.url; };

  blob.load = async function () {
    if (!blob.url) return null;
    try {
      var res = await fetch(blob.url, { method: 'GET' });
      // Nothing saved yet is the ordinary state on a first deployment, not a
      // fault. Azure answers 404 with a BlobNotFound body.
      if (res.status === 404) return null;
      if (!res.ok) throw new Error('HTTP ' + res.status + ' ' + res.statusText);
      return JSON.parse(await res.text());
    } catch (err) {
      blob.lastError = 'reading the snapshot: ' + ((err && err.message) || err);
      log(blob.lastError);
      return null;
    }
  };

  blob.save = async function (snapshot) {
    if (!blob.url) return false;
    try {
      var body = JSON.stringify(snapshot);
      var res = await fetch(blob.url, {
        method: 'PUT',
        headers: {
          // Required on every block blob PUT; the request is rejected without
          // it, and the rejection is a 400 that says nothing obvious.
          'x-ms-blob-type': 'BlockBlob',
          'Content-Type': 'application/json'
        },
        body: body
      });
      if (!res.ok) throw new Error('HTTP ' + res.status + ' ' + res.statusText);
      blob.lastError = null;
      blob.lastSavedAt = new Date();
      return true;
    } catch (err) {
      /**
       * A failed snapshot must never take the relay down with it. The feed is
       * the job; this is only insurance against a restart, and a board running
       * on a live feed with no snapshot is in far better shape than one that
       * fell over because storage was briefly unreachable.
       */
      blob.lastError = 'saving the snapshot: ' + ((err && err.message) || err);
      log(blob.lastError);
      return false;
    }
  };

  return blob;
}

module.exports = { create: create };
