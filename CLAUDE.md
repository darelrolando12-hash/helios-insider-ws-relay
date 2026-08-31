# CLAUDE.md — Helios Insiders Engine

*Standing context for this repo. Read this before doing anything.*

---

## What this is

The **Helios Engine** — a Node/TypeScript server running on Railway that holds the market-data connection, runs every trading engine 24/7, and owns all database writes. Browsers and phones are **projectors**: they subscribe, render, and send user actions. They compute nothing.

This is real-money trading infrastructure. Correctness beats speed, always.

---

## THE NON-NEGOTIABLE RULES

### 1. Evidence, never assertion

Every claim about behaviour must be backed by something real: actual command output, actual query results, actual log lines. **"It should work" and "I verified it" are not evidence.**

This standard exists because a previous tool made **six** confident false claims in a single session — reporting a healthy production app as broken, claiming code was removed that wasn't, claiming a file was server-side when it was the browser's, and claiming a function handled reconnects when it was dead code never called.

### 2. `node --check` before every push

Non-negotiable. A copy-paste error once put chat prose inside `index.js` at line 375 and **Railway crash-looped 441 times**. Two seconds of checking prevents a production outage.

### 3. Run the full test suite, not a subset

Report per-file counts. A previous session reported "67/67 passing" while the real suite was 129 tests — five files had never run against the change.

### 4. Root cause, never symptom

Do not patch around a problem. Trace it to the mechanism, prove the mechanism, then fix the mechanism.

**Real example from this codebase:** disclosures appeared "stale." Three rounds of investigation blamed staleness, then category mapping. The actual cause was `ignoreDuplicates: true` (`ON CONFLICT DO NOTHING`) making 91% of rows permanently unrepairable — invisible to the read path since day one.

---

## THE DOMINANT BUG CLASS: SILENT ZEROS

**Seven bugs of the identical shape were found in one session.** Code checking for inputs that structurally cannot exist. Every one looked like normal, healthy behaviour:

| Bug | Looked like |
|---|---|
| `isHalted()` returned `null`, gate treated it as "halted" | "No signals today" |
| Relay routed `LULD.*` to `null` — dropped silently | "No halts today" |
| Scanner checked `sources` for tags the engine never emits | "Threshold not reached" |
| `materialEvent` checked categories the provider never produces | "No material events" |
| 91% of disclosures unreadable (`tickers = null`) | "No filings" |
| `fetchTradesSince` never called — CVD gap-fill dead | "CVD looks fine" |
| Watermark advanced past unfinished work after interruption | "Already up to date" |

**When you see a zero, prove it's a real zero.** Ask: can this code path produce a non-zero result *at all*? Has it *ever*?

**Every factor must distinguish "genuinely nothing" from "data unavailable."** Use the `dataQuality: 'real' | 'absent' | 'stale'` shape.

### Removing a redundancy can expose a fault the redundancy was hiding

**Real example, 2026-08-28.** Every LULD message carries `t` in **nanoseconds** (`1787924309993088500`, 207× JavaScript's maximum Date value). `toCentralTime` threw `RangeError: Invalid time value`, and because the call sat outside the try/catch that wrapped handler invocation, the throw escaped `onmessage` and aborted the whole frame — every message ordered after the LULD one was silently discarded.

That bug was present for days and invisible, because the **N² broadcast amplification was accidentally acting as a retry**. Each frame arrived N times. Delivery #1 threw at the LULD message and dropped the rest; delivery #2 saw that same message as a duplicate (the dedup map records a key *before* dispatch), skipped it, and processed everything after it. Fixing the amplification made delivery exactly-once — and the drop permanent.

**We did not cause the bug. We removed the accident that was hiding it.**

The general rule: **when you remove a redundancy, retry, or duplicate path, expect a latent fault to surface.** Before landing that kind of change, ask what the redundancy might have been silently absorbing. Deduplication, retries, N-times delivery, and fallbacks all mask upstream faults — and the masking is invisible precisely because it works.

Two corollaries from the same incident:

- **Guard the value, not the type.** `typeof t === 'number'` passes for both `NaN` and `1.7e18`.
- **Plausibility beats validity.** The first fix divided nanoseconds by `1e3` and got a *technically valid* `Date` in the year 58627. Its own test caught it. A silently wrong timestamp is worse than a rejected one — validate into a realistic range, not merely a parseable one.

### When docs and captured wire data disagree, the wire wins

Massive's LULD page documents `t` as **"The Timestamp in Unix MS"** — and the sample response *on that same page* is `1764086430905642800`, which is nanoseconds. The vendor's own example contradicts the vendor's own prose.

Had the fix been written from the documentation rather than from a captured frame, it would have been wrong. **Verify field units, field names, and field presence against real captured traffic before trusting a spec.** The same session proved the point twice: `luldStore` read `msg.sym` for the ticker, and no LULD message carries `sym` at all — the ticker is in `T`.

Docs are a hypothesis. A captured frame is evidence.

### A wall-clock deadline is only as correct as its source

**Real example, 2026-08-31.** The forced-close deadline for same-day-expiry options was specified as **15:45 CT**. Real NYSE/Nasdaq close is **15:00 CT** (4:00 PM ET — Eastern and Central share DST transitions, so the offset is a constant 1 hour, not a DST edge case). 15:45 CT is 45 minutes *after* the market shuts, not before it — at that moment there is no exchange left to submit an order to, which defeats the entire purpose of the rule: preventing an unfunded ~$65,000 assignment from a forgotten ITM position.

This was not a computation bug. `lib/time.ts`'s `America/Chicago` handling is correct and DST-aware, and it computed exactly the wrong number it was asked to compute. The 15:45 figure was simply never checked against the real close time — not by the person who specified it, not during code review, not by any of the tests written against it, not by the end-to-end simulation harness built specifically to catch integration bugs. All of those correctly verified that the system did exactly what was specified. **The specification was the bug, and nothing downstream of a spec can catch an error in the spec itself** — only re-deriving the number from its actual source can.

**Every safety-critical wall-clock constant must cite its source directly in the code** — not "3pm-ish," but *"NYSE regular session close, 4:00 PM ET = 3:00 PM CT, verified 2026-08-31"* — so the next person (or the next model) can check the citation instead of inheriting the number on trust. See `DEFAULT_FORCED_CLOSE` in `relay/engine/risk/forcedClose.ts` for the corrected form.

---

## HARD ENVIRONMENT CONSTRAINTS

### Massive (verified from their docs)
- **Ticker subscriptions: no limit** — consumption-bound only
- **WS connections: 1 per cluster per account.** The relay holds all three. Nothing else may open one.
- **Options quotes: 1,000 contracts per connection — hard cap.** Raising it means buying connections.
- **REST: unlimited, stay under 100 req/sec.** We run ~1/sec.
- **Slow consumers are actively disconnected.** Keep up or get dropped.
- Server-side cleanup after a close takes **10–30 seconds**. Reconnect backoff starts at 30s for this reason. Boot stagger is 0s/20s/30s because 5s lost the race at a real deploy.

### Railway
- **Must stay at 1 replica. Autoscaling off.** Two replicas = two engines = duplicate writes, invisible until the data is polluted.
- **Runs UTC.** See timezone below.
- Deploys send SIGTERM and restart the process — in-memory state is lost.
- Memory: 345MB of 8GB in use. Ample headroom.

### Timezone — a real bug class here
**Railway runs UTC. The market runs Central.** Any `new Date().getHours()` / `getDate()` / `getFullYear()` silently works in a browser and silently breaks on the server.

- `time.ts` is correct — explicit `Intl.DateTimeFormat` with `America/Chicago`, DST-safe. **Use it.**
- `toISOString()` is safe — always UTC.
- **Five ingestion files already had this bug** and were fixed to `getUTCDate()`/`getUTCFullYear()`.

### TypeScript
Node runs `.ts` natively via type stripping (requires **Node ≥ 22.18**). **No build step, no compiler.**
Constraint: **erasable syntax only** — no enums, namespaces, parameter properties, decorators. Use `as const` unions. Type-only imports need the `type` keyword.

---

## SHADOW MODE

`ENGINE_MODE=shadow` — compute everything, **log what would be written, write nothing.**

The browser still writes during migration. Running both live would guarantee duplicates. Diff server output against browser output on the same live data; **only flip to `live` when they match**, and disable browser writes in the same step.

---

## TWO COPIES OF ENGINE LOGIC — TEMPORARY, TRACKED

`relay/engine/` (engines, stores, ledger, state, lib) is **authoritative**. This is where engine logic runs server-side going forward.

`src/{engines,stores,ledger,state,lib}` is a **frozen snapshot** — last touched 2026-07-27, unlike the rest of the repo, which has had commits since (including the `relay/` files pushed 2026-08-27). The live frontend is hosted by Wegic at `helios-insiders.wegic.net` and is **not** built from this repo. **Verified from Railway boot logs**: startup output shows `> helios-insiders-relay@1.0.0 start` — that's `relay/package.json`'s `name` field, not the root's `wegic-vite-react` — confirming Railway's Root Directory is set to `relay/`, not repo root. `src/`'s copies have already drifted from current engine logic (confirmed: 17 of 22 overlapping files differ in content, not just formatting, as of 2026-08-27).

**Do not edit `src/{engines,stores,ledger,state,lib}` believing it's live.** It is scheduled for deletion at Shadow Mode cutover — the same step browser writes are disabled per the section above.

**`relay/engine/lib/massive/websocket.ts` was deleted (2026-08-27).** It was the browser bus — four outbound WebSockets to the relay, `document` access, and an import of a `config` module that does not exist server-side. It would have crashed on import. `engine/bus.ts` replaces it in-process. The original is preserved at `src/lib/massive/websocket.ts` and in git history.

---

## OPTIONS SUBSCRIPTION BUDGET — RELAY-OWNED, SETTLED

The engine does **not** enforce the 1,000-contract options Q cap and does not subscribe to option channels of its own. This is settled, not deferred:

- The cap is **per-connection**, and the relay owns the connection. A second budget in the engine would double-count contracts the browser already subscribed to over the same relay.
- **Layer 1 sources chain data over REST**, not the options WebSocket — the engine does not need its own option Q subscriptions to compute.
- The relay's subscription set is **shared**, so option messages the browser subscribed to reach the engine in-process regardless.

`engine/bus.ts` `subscribeOption()` therefore registers without consulting a budget, and `rolloverExpiredOptions()` is a no-op that says so in the logs. `lib/massive/budgetManager.ts` has had no importer since `websocket.ts` was deleted — it is reference material, not live code.

---

## KEY ARCHITECTURE FACTS

- The engine subscribes to the relay's `broadcast()` **in-process**. No WebSocket, no network hop.
- REST goes **direct to Massive** with `MASSIVE_API_KEY` from `process.env` — **not** through the relay's own `/rest/` proxy. That would be a loopback to itself.
- **One REST module only.** Do not scatter `fetch` calls across engines.
- **CVD is cumulative from session open.** A mid-session restart must rebuild from the open, not from the last tick.
- Watermark-based incremental sync must use an **overlap** (watermark − 7 days). Without it, any interruption permanently skips unfinished work.

---

## SCORING REFERENCE

**`confluenceEngine`** — CVD 25 · GEX 20 · EMA 20 · Catalyst 20 · DUMP/RIP 15
Thresholds: EXIT 55–64 · REVERSAL 65–74 · ENTER/BREAKOUT ≥75

GEX: within 0.5% of flip → 20 · negative regime → 15 · positive → 10 · neutral → 5
Catalyst: insiderBuy 12 + materialEvent 8 + earningsPending 5, capped at 20

**Swing / 0DTE** — 8 weighted criteria, 128/64/32/16/8/4/2/1 = 255 total

Brain self-excludes cleanly when a fingerprint has no history. **Known open issue:** the fingerprint has ~8,280 buckets and needs n≥30 — roughly 17 years to fill. A hierarchical fallback ladder is designed but not built.

---

## WORKFLOW

1. Branch. Never work directly on `main`.
2. Make the change.
3. `node --check` on anything touched.
4. Full test suite, per-file output.
5. Show the real diff.
6. Push. Railway auto-deploys.
7. **Verify in the Railway logs that it actually did what was intended.**

**Never deploy during market hours** unless the fix is more urgent than the interruption. Deploys drop the upstream connections and reset in-memory state.
