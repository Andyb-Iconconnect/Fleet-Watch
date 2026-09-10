# The relay

One Azure Web App that reads the AIS feed **once** and serves the board to
every screen from the same origin.

Before this, each screen was its own client of the provider. On AISstream that
meant an unfiltered subscription per screen — about **12 GB a day, each** —
because filtering by MMSI at their end only ever reached 31 of our 61. On a
metered provider it is worse than untidy: five walls would be five times the
bill for the same sixty-one yachts.

Now the feed is read once and read *from* many times. A screen costs about
**8 KB every 30 seconds**, and hanging another television on another wall costs
nothing at all.

It also puts the key where it belongs. There is no API key in a browser any
more, nothing typed at each screen, and nothing in `localStorage` on a machine
in a reception area.

---

## What to create

| | |
|---|---|
| **App Service plan** | Linux, **B1 or above** — see *Always On* below |
| **Web App** | Runtime stack **Node 22 LTS** |
| **Storage** | One container (e.g. `fleet-watch`) for the snapshot blob |

Deploy this repository. There are **no dependencies**, so there is nothing to
install and nothing to break at install time. `package.json` starts it:

```
npm start        →  node server/index.js
```

---

## Two Azure settings that decide whether this works at all

**1. Always On → On.** Configuration → General settings.

Without it, App Service unloads the app after about 20 minutes with no
requests. A wall board polls every 30 seconds so it would usually keep it
awake — but the moment the last screen is switched off for the night, the
relay stops reading the feed, and in the morning the board is a day stale.
Always On is not available on the Free or Shared tiers, which is why the plan
needs to be B1 or above.

**2. Scale out → 1 instance.** Scale out (App Service plan).

Every instance runs its own copy of this app, and every copy opens its own
feed. Three instances means **three times the requests** on a metered plan and
three times the AIS bandwidth — and the board looks identical on all of them,
so nothing would tell you it was happening except the invoice. There is no way
to detect the others from inside the app, so it does not try: keep it at one.

If you ever genuinely need more than one, set `ALLOW_MULTIPLE_READERS=true` so
the decision is recorded rather than accidental.

---

## Application settings

Configuration → Application settings. These are stored encrypted, never appear
in the repository, and never reach a browser.

**Required**

| Setting | Value |
|---|---|
| `FEED_PROVIDER` | `vesselapi` or `aisstream` |
| `FEED_KEY` | the provider's API key |

**Strongly recommended**

| Setting | Value |
|---|---|
| `SNAPSHOT_BLOB_SAS_URL` | SAS URL of a single blob, e.g. `https://<account>.blob.core.windows.net/fleet-watch/snapshot.json?sv=...` |

Azure restarts this app whenever it likes — a deployment, a platform patch, a
scale event — and an in-memory fleet goes with it. Without the snapshot the
board blanks and fills back in over the following hour as each yacht happens to
speak, which on a wall in reception looks exactly like the system being broken.

On a metered provider it costs money too. A restored fleet carries its
watermark, so the reader knows where it got to: **a restart then costs one
request instead of a full backfill.** That is measured, not assumed — a restart
in testing went from 12 requests to 1.

Generate the SAS in the portal (Storage → the container → Shared access
tokens) with **Read, Create and Write**, an expiry you will remember to renew,
and nothing else. Nothing here should be able to reach the rest of the storage
account, and with a blob-scoped SAS it cannot.

**Optional**

| Setting | Default | What it does |
|---|---|---|
| `VESSELAPI_POLL_SECONDS` | `180` | How often to read the stream. Cheap to lower — see below |
| `VESSELAPI_PAGE_SIZE` | unset | Ask for a larger page. **This divides the bill directly** |
| `VESSELAPI_PAGE_PARAM` | `limit` | The name of that parameter — currently a guess |
| `VESSELAPI_CURSOR_PARAM` | `nextToken` | The name of the cursor parameter — also a guess |
| `VESSELAPI_PAGES_PER_POLL` | `4` | Ceiling on a routine poll |
| `VESSELAPI_BACKFILL_PAGES` | `12` | Ceiling on the first poll, which has an empty board to fill |
| `SNAPSHOT_SECONDS` | `120` | How often to write the snapshot |
| `TRACK_POINTS` | `240` | Positions kept per yacht for the trail on the chart |
| `ALLOW_MULTIPLE_READERS` | unset | Permits more than one instance to read the feed |

VesselAPI answers with a *stream* of position reports rather than a snapshot of
where everyone is, so the reader keeps a watermark and reads only what is new.
That means **the bill follows how much the fleet talks, not how often we
look**: polling every three minutes costs very nearly what polling every thirty
would. Page size is the one real lever — at the rate the fleet was observed
talking, 20 reports a page is about 10,000 requests a month and 200 a page is
about 1,000.

---

## Lock it down

**Authentication → App Service authentication → Entra ID.**

This board shows sixty-one customers' yachts. It should not be on a public
hostname. App Service Authentication sits in front of the app, costs nothing,
needs no code, and can be restricted to the Icon Connect tenant.

If a wall screen cannot sign in interactively, the usual answer is to reach it
over the office network or a private endpoint rather than to make the board
public.

**Health check path → `/api/health`**, so Azure restarts an instance that has
stopped answering.

Incoming WebSockets do **not** need enabling. The relay opens an outbound
connection to AISstream; nothing connects to it that way.

---

## Checking it

`GET /api/health` answers plainly, and deliberately says more than "ok" —
the failure to catch is the quiet one, where the relay is up, the board is
being served, and no positions are arriving.

```json
{
  "status": "ok",
  "problems": [],
  "provider": "vesselapi",
  "heard": 48,
  "of": 61,
  "minutesSinceLastFix": 2,
  "feedError": null,
  "reader": { "calls": 1, "reports": 20, "applied": 6, "strangers": [] },
  "calls": 37
}
```

- **`problems`** — configuration mistakes in words you can act on. A relay with
  no key still starts and still serves the board, and says so here, because an
  app that refuses to boot tells you only that it is down.
- **`minutesSinceLastFix`** — the number to alert on. Anything past an hour
  means the feed has stopped, whatever else looks healthy.
- **`strangers`** — vessels that are not ours arriving in the answer. Should
  always be empty; the whole cost model rests on the provider's MMSI filter
  being applied.
- **`calls`** — requests made since this instance started. If it climbs when
  nothing is happening, something is looping.

Logs go to stdout, which is App Service **Log stream**, and it is the first
place to look when a board has stopped moving.

---

## What the board does with it

`config.js` ships with `provider: 'relay'`, so a board served by this app asks
it for positions on the same origin — no key, no CORS, no preflight.

The single-file build (`npm run build`) is the exception and handles itself: a
bundle on a USB stick has no relay behind it, so the builder switches it back
to talking to AISstream directly, with a key typed at the screen, and says so.

---

## Deploying it

Anything that gets the repository onto the Web App will do — zip deploy from
the portal, or a GitHub Action. There is no build step and nothing to install.

```yaml
# .github/workflows/deploy.yml
name: Deploy the relay
on:
  push:
    branches: [main]
jobs:
  deploy:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: '22'
      # The suite is browser-free and takes a few seconds. It is the only thing
      # standing between a bad afternoon and a wall of yachts in the wrong place.
      - run: npm test
      - uses: azure/webapps-deploy@v3
        with:
          app-name: <the Web App name>
          publish-profile: ${{ secrets.AZURE_WEBAPP_PUBLISH_PROFILE }}
```

Add the publish profile (Web App → Overview → Download publish profile) as the
repository secret `AZURE_WEBAPP_PUBLISH_PROFILE`.
