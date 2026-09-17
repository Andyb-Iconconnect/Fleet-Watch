# VesselAPI Data Collection & Cost Analysis

Your 150 free calls are enough to understand your fleet's reporting patterns. Use them strategically.

## Step 1: Run on your local machine (not in this sandbox)

The Claude Code environment blocks external APIs. You need to run this on your laptop/desktop where you have unrestricted internet.

```bash
cd Test-apps
FEED_KEY=1e6fc8058ace527ed7af812520cd3050d6056229a87fd239a674f04027b176d7 node tools/measure-vesselapi.js
```

It will poll VesselAPI every 3 seconds and log to `vesselapi-measurements.jsonl`:

```
Poll #1 → 5/100 ours | 5/61 total | 🔴 56 missing | $0.01 | 245ms
Poll #2 → 8/102 ours | 13/61 total | 🔴 48 missing | $0.02 | 187ms
Poll #3 → 6/99 ours | 17/61 total | 🔴 44 missing | $0.03 | 201ms
```

**What's happening:** VesselAPI pages through reports, newest first. Each poll reaches a "cursor" where it stops; the next poll resumes from there. You'll see unique vessels accumulate until you catch all 61 (or determine some aren't in their system).

## Step 2: Let it run until you have enough data

**Goal 1: Coverage** — Do all 61 vessels appear in VesselAPI?
- Run for at least 2-4 hours to backfill the history
- Once vessels stop appearing, they're likely all there (or not in VesselAPI)

**Goal 2: Cost baseline** — How many calls do you actually need?
- After backfill (first hour), the cursor should stabilize
- Count average calls per cycle to estimate daily cost

**Goal 3: Report frequency** — How often does your fleet report?
- Vessels at anchor: every 3 minutes (broadcasts)
- Vessels underway: every 3-30 seconds (AIS reports)
- Offline vessels: never

This varies by vessel. You need 24+ hours to see the pattern.

## Step 3: Analyse the data

Once you stop the script (Ctrl+C):

```bash
node tools/analyze-vesselapi.js
```

It will show:
- How many vessels have reported
- Which vessels are missing (and why)
- Cost projections at different polling intervals
- Whether free or paid tier works for you

**Example output:**
```
Duration: 48.2 hours (580 polls)
Total API calls: 98
Cost so far: $0.98 (free tier)

COVERAGE AT END OF TEST:
Vessels seen: 61/61
✓ All 61 vessels have reported at least once

POLLING PATTERN:
Average calls per hour: 2.04
Average positions per call: 89

COST PROJECTIONS:
  ✓ 3 minutes (max detail): 481/day, 14,403/month ($144)
  ✓ 5 minutes: 288/day, 8,642/month ($86)
  ✗ 10 minutes: 144/day, 4,321/month ($43)
  ✓ 30 minutes: 48/day, 1,440/month ($14)

RECOMMENDATIONS:
• Free tier (150/month) supports polling every ~5760 seconds (96 min)
• Paid tier (1500/month) supports polling every ~576 seconds (10 min)
✓ Your current test rate (98/day) fits free tier!
```

## Key insights you'll learn

1. **Are all 61 vessels in VesselAPI?** → If not, you need a different provider
2. **How fast does the cursor move?** → Tells you if pagination is working
3. **What's the minimum safe poll interval?** → Trade-off between freshness and cost
4. **Should you use free or paid tier?** → Real budget decision

## Spend tracking

- 150 free calls gets you ~48 hours of polling every 3 seconds
- Each poll = 1 call
- Once caught up, re-polling costs much less (backfill is expensive)
- After you know the pattern, switch to cheaper polling interval

## Next step after analysis

When you have the data:
1. You'll know if all vessels are in VesselAPI ✓
2. You'll know the cost model (e.g., "30-minute poll = $14/month" ✓
3. **Then**: Deploy to Azure with confidence, knowing the exact budget impact

---

**Don't wait for perfect data.** 24-48 hours gives you enough to make a decision. If after 48h you haven't seen all 61 vessels, some are either offline or not in VesselAPI coverage—and that's important to know before production.
