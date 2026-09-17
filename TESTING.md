# Local VesselAPI Testing Guide

## Start the relay
```bash
npm run dev
```

You should see:
```
2026-09-17T...  Loaded .env for local testing
2026-09-17T...  relay listening on 3000  instance local-test
2026-09-17T...  no snapshot to restore from — this is normal on a first deployment
2026-09-17T...  vesselapi: <N> new fixes from <M> reports in <K> request(s)
```

The relay is now reading VesselAPI every 180 seconds.

## Open the board
```
http://localhost:3000
```

You should see all 61 yachts. Try the filters (Sentinel, Underway) to verify filtering works.

## What to monitor during the test

### Every poll cycle (every 3 minutes):

Watch the relay output for:
- **`applied`** = how many position fixes were new. Should be 30-100 per poll.
- **`reports`** = total positions in the page. Usually 100-200.
- **`requests`** = number of calls made. **This is what costs money.**
- **`strangers`** = MMSIs in the data that aren't in your fleet. Should be empty `[]`.

### Example healthy output:
```
vesselapi: 45 new fixes from 98 reports in 2 request(s)
```

**This means:** 2 API calls got 98 positions, 45 were new, 53 were duplicates or older.

### Red flags:
```
vesselapi: 0 new fixes from 200 reports in 4 request(s)
```
= All reports are old; you're stuck at the same watermark. Cursor is broken.

```
vesselapi: 50 new fixes from 200 reports in 1 request(s), 30 not ours
```
= 30 positions are for MMSIs not in your fleet. Fix the MMSI filter in `fleet.js`.

---

## Cost calculation

**Every poll cycle costs `requests` × $0.01** on the paid tier.

If you see consistently 2 requests per poll:
- Every 180 seconds = 2 calls
- 480 calls per day
- 14,400 calls per month = **$144** on the paid tier

But this usually **drops dramatically** after the first 1-2 days when the watermark catches up.

Once caught up, subsequent polls only fetch new positions since the last cursor:
- After backfill, often just **1 call per poll**
- 1 call every 180s = ~480/day = **$4.80/month**

**Test goal:** Watch the `requests` column for 24+ hours. Log the numbers.

---

## Health check endpoint

```bash
curl http://localhost:3000/api/health | jq .
```

Should show:
```json
{
  "board": {
    "vessels": 61,
    "updated": "2026-09-17T14:23:00.000Z"
  },
  "reader": {
    "calls": 50,
    "lastAudit": {
      "pages": 2,
      "calls": 2,
      "reports": 98,
      "applied": 45,
      "strangers": [],
      "windowMinutes": 15,
      "caughtUpTo": "2026-09-17T14:23:00.000Z"
    }
  }
}
```

---

## Filtering test (verify it works end-to-end)

1. Open http://localhost:3000
2. Click the **Sentinel** chip
3. Count visible vessels (should be ~3-5)
4. Verify the **chart** and **overview list** show the same subset
5. Click the chip again to clear
6. All 61 should return

---

## Stop the relay
```
Ctrl+C
```

---

## What to capture for the cost model

After 24 hours, note:
- Total `calls` made
- Average `calls` per poll cycle
- Whether `strangers` ever appeared (if so, fix fleet.js)
- Any errors logged

Then we can calculate:
- Real daily cost on paid tier
- Polling interval you can afford (may be able to increase to 600s or lower pages)
- Whether the free tier (150 calls/month) is realistic after catch-up
