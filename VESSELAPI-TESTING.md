# VesselAPI Data Collection & Cost Analysis

Your 150 free calls are enough to understand your fleet's reporting patterns. Use them strategically.

## Step 1: Run on your local machine (not in this sandbox)

The Claude Code environment blocks external APIs. You need to run this on your laptop/desktop where you have unrestricted internet.

**First 30 minutes:** Polls every 30 seconds (backfill phase)
**Then 24+ hours:** Polls every 15 minutes (catch-up phase)

```bash
cd Test-apps
FEED_KEY=1e6fc8058ace527ed7af812520cd3050d6056229a87fd239a674f04027b176d7 node tools/measure-vesselapi.js
```

It will poll VesselAPI and log to `vesselapi-measurements.jsonl`:

```
Poll #1 → 5/100 ours | 5/61 total | 🔴 56 missing | $0.01 | 245ms
Poll #2 → 8/102 ours | 13/61 total | 🔴 48 missing | $0.02 | 187ms
Poll #3 → 6/99 ours | 17/61 total | 🔴 44 missing | $0.03 | 201ms
...
Poll #30 → 2/95 ours | 47/61 total | 🔴 14 missing | $0.30 | 198ms

>>> PHASE 1 COMPLETE <<<
>>> Switching to 15-minute intervals for remaining calls <<<

Poll #31 → 3/98 ours | 48/61 total | 🔴 13 missing | $0.31 | 212ms
[polls continue every 15 minutes over next 24+ hours]
```

**What's happening:** 

*Phase 1 (backfill):* VesselAPI pages through historical reports, newest first. Each poll reaches a "cursor" where it stops; the next poll resumes from there. You accumulate unique vessels quickly.

*Phase 2 (monitoring):* Cursor moves slowly (just new reports since last poll). You see how many vessels report within 15-minute windows. This reveals reporting frequency and helps you validate if all 61 are covered.

## Step 2: Two-phase strategy (spreads 150 calls across 24+ hours)

**PHASE 1: Fast backfill (30 calls in ~30 minutes)**
- Polls every 30 seconds
- Understands how fast VesselAPI's cursor moves
- Reveals which vessels backfill quickly vs. are sparse
- After 30 min, automatically switches to 15-minute intervals

**PHASE 2: Sustainable monitoring (120 calls over 30+ hours)**
- Polls every 15 minutes (sustainable long-term rate)
- Catches vessels that report infrequently
- Spreads calls so you don't burn through 150 in an hour

By the end:
- You'll know if all 61 vessels appear
- You'll understand backfill cost (expensive) vs. catch-up cost (cheap)
- You'll have a real data model for your fleet

Example timeline:
- Minute 0-30: Phase 1 backfill (30 calls)
- Minute 30-1470: Phase 2 monitoring (120 calls, 1 every 15 min)
- Total: ~24.5 hours, 150 calls, all questions answered

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

- 150 free calls strategy: 30 calls (30 min backfill) + 120 calls (24+ hours monitoring)
- Phase 1 burns calls fast but reveals the full history and cursor speed
- Phase 2 is sustainable long-term polling rate (15 min intervals)
- Cost: ~$1.50 to answer all your questions
- Each poll = 1 API call = $0.01

## Next step after analysis

When you have the data:
1. You'll know if all vessels are in VesselAPI ✓
2. You'll know the cost model (e.g., "30-minute poll = $14/month" ✓
3. **Then**: Deploy to Azure with confidence, knowing the exact budget impact

---

**Don't wait for perfect data.** 24-48 hours gives you enough to make a decision. If after 48h you haven't seen all 61 vessels, some are either offline or not in VesselAPI coverage—and that's important to know before production.
