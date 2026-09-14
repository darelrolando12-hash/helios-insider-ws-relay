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

### 2. A real syntax check before every push

Non-negotiable. A copy-paste error once put chat prose inside `index.js` at line 375 and **Railway crash-looped 441 times**. Two seconds of checking prevents a production outage.

**`node --check` does not do this for `.ts` files.** Measured 2026-09-11 on Node v24.20.0: for a `.ts` file that begins with an `import`, `node --check` exits 0 no matter what follows — chat prose at line 3, a broken function signature and a non-erasable `enum` all "passed". (It parses as CommonJS, hits the import, retries as an ES module and reports nothing.) Every engine file starts with an import, so the check this rule relied on was empty for the whole engine. It still works for `.js`. Use:

```
node relay/scripts/checkSyntax.mjs <files…>
```

It strips types with Node's own stripper (which rejects enums and malformed code) and `--check`s the result as an ES module; it verifiably fails on all three cases above. Type errors are the type checker's job — see WORKFLOW.

**The same session found `tsc -p .` checks nothing** (the root `tsconfig.json` lists no files and only references others). The real checks are `npm run typecheck` (browser) and `npx tsc -p relay/tsconfig.typecheck.json` (engine).

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

### A citation can be accurate and stale at the same time

**Real example, 2026-08-31.** The PDT rule was verified by pulling a direct quote from FINRA Regulatory Notice 21-13: *"a customer who executes four or more day trades within five business days."* The quote is real, correctly transcribed, from a primary regulator source.

**The rule it describes had already been eliminated.** The SEC approved FINRA's amendment to Rule 4210 on 2026-04-14, effective 2026-06-04 — scrapping the pattern-day-trader designation and the $25,000 minimum entirely, replacing them with an intraday margin standard. The verification was three months out of date at the moment it was performed, and nothing about the act of verifying would have revealed that.

This is a **distinct failure mode** from an unverified fact. There, nobody checked. Here, someone checked, checked correctly, quoted accurately — and was still wrong, because the ground moved after the source was written and the source was never withdrawn.

Two habits that catch it:

- **Date the ground truth, not just the lookup.** Ask "when was this rule last amended?", not only "what does this document say?" A regulator notice from 2021 describes 2021.
- **Prefer a source that would have to change.** A vendor's live API response, a broker's current policy page, or an account's actual returned state reflects today. A rule notice reflects its publication date forever.

Corollary, from the same incident: **phase-in periods mean the regulation and the counterparty can disagree.** Firms have until 2027-10-20 to adopt the new framework, so "the rule changed" and "our broker changed" are separate facts needing separate evidence. Check the counterparty's own current behaviour — Webull's live `assets/balance` response returning `day_trades_left: "UNLIMITED"` on a sub-$25,000 margin account is stronger evidence than any documentation about what the rule is.

### Two ways a backtest lies about significance

**Measured 2026-09-11/12, both against claims this repo's own reports had already made.**

**Correlated observations inflate z.** Twenty entry minutes inside one session are not twenty independent samples: the entry-timing sweep read z −2.6 per minute and −1.50 clustered by session. Worse across tickers: the universe scan's gap-fade edge read z 3.24 (most-liquid quintile) and 3.55 ("the rest") treating each ticker-session as independent — clustered by DAY, because a market-wide move gaps and reverts every ticker together, it was −0.08 and +1.0 (z 0.60). **Cluster by the unit the shock arrives in**: the session for intraday entries, the day for cross-sectional tests.

**A trend across years can be pure sample size.** The same flow test on 200 out-of-sample sessions showed a monotone decay — 2023 +4.1, 2024 −1.0, 2025 −6.8, 2026 −18.5 points — and reporting it as a drift was premature. Extending to 1,208 sessions: the edge is +0.2 points and 2026 is **+5.9** (n 65 → 409). Before believing a time trend, ask what the smallest bucket's n is.

**A result its own structure forbids means the measurement broke, not the strategy.** Measured 2026-09-12: a defined-risk iron fly cannot lose more than its max risk, yet the backtest reported losses of 1,834% of max risk from option trade prints, and 28 of 171 below −100% from option NBBO. The cause is illiquid 0DTE wings — a stale last print, or a quote matched up to five minutes away, marks the four legs at different instants and the structure loses its bounds. The fix is not a filter that hides the impossible values (tightening to liquid names and plausible credits still left 5 of 59 out of bounds); it is to reject any mark outside the structure's own range before it reaches a mean. Until that exists, the seller's side is **untested, not refuted**.

### A GRANT cannot narrow a schema-wide default — REVOKE first, or the extra privilege stays

**Real example, 2026-09-13.** The DDL for `gex_regime_log` and `engine_shadow_signals` wrote `grant select, insert … to anon;` and, for the first table, `grant update (fwd_30m_pct, fwd_60m_pct) … to anon;` — exactly the three operations the engine performs. Wegic ran it and reported back precisely, unprompted: `information_schema.role_table_grants` showed anon holding DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE and UPDATE on **every column**, not just what was written.

The narrower GRANTs were not wrong — they simply could not undo a schema-level default (Supabase's own project bootstrap runs `ALTER DEFAULT PRIVILEGES … GRANT ALL ON TABLES TO anon` on `public`) that applies automatically to every new table before any migration-specific GRANT ever executes. Postgres privileges are additive: a GRANT can only add, never restrict. The fix is an explicit `REVOKE ALL … FROM anon` before the intended GRANTs, not a narrower GRANT.

**Calibrated, not alarmed, once checked:** PostgREST's OpenAPI confirms `patch` (UPDATE) and `delete` are exposed as HTTP verbs for anon on `signals`, `signal_outcomes`, and both new tables alike, but `truncate` is not a PostgREST verb at all — so the TRUNCATE grant, while unintended, is not reachable through the normal Supabase JS client. DELETE matches the already-documented shape (`backups/cleanup-duplicate-signals.sql`): with no DELETE policy under RLS, it affects 0 rows regardless of the grant. **The one that was real:** the UPDATE policy on `gex_regime_log` was unconditioned (`using (true)`), and the grant covered every column — so an ordinary REST client could have overwritten `flip_level`, `spot`, `gex_regime` or `observed_at` on any historical row, the exact data this table exists to make un-overwritable.

Fixed by adding the REVOKE to both DDL files; `observationTables.schema.test.ts` now fails if a table's GRANT block has no `REVOKE ALL … FROM anon` before it. **Not yet checked:** whether `signals`/`signal_outcomes` have the same unconditioned-UPDATE exposure on real trading data (not just the already-known harmless DELETE). That needs a `pg_policies` read on those two tables specifically — worth doing, independent of anything in this handoff.

**Corollary — a positive mean on both sides is a pricing error, not an edge.** Fading the gap returned +13.7% and following it +9.2% on the same days; a plain call +12.3% and a plain put +10.5%. They cannot all be edges. Only the mirror comparison (the identical entry taken the other way) is pricing-neutral, which is why every directional claim here carries one.

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
Catalyst: insiderBuy 12 + materialEvent 8 + earningsPending 5 + newsSentiment (±5, decayed, `newsSentimentGate.ts`), capped at 20 (floored at 0)

**Swing / 0DTE** — 8 weighted criteria, 128/64/32/16/8/4/2/1 = 255 total

Brain self-excludes cleanly when a fingerprint has no history. **Known open issue:** the fingerprint has ~8,280 buckets and needs n≥30 — roughly 17 years to fill. A hierarchical fallback ladder is designed but not built.

---

## CONFIRMED ANTI-SIGNALS — blockers, not fades

**red-to-green** (`engine/setups/antiSignals.ts`). Pre-registered (commit 76ab65e) before the holdout was analysed, then run on 53 tickers that played no part in finding it: the signal's direction lost to the identical trade taken the other way by **3.6 points out of sample (z −3.22, 11,851 signals, 502 days)** and 4.3 in sample (z −4.46). Result committed unedited (bd18d5e). It held its size on new data (−4.5 in discovery → −3.6), where K5 halved.

- **A block, not a trade.** 3.6 points is under the ~8-point floor the pre-registration set for tradeability — the round trip is paid in both directions (K5: following −8.2%, fading only +4.0% on real prices). The real-price check of the fade was deliberately skipped: it could only confirm that an edge already deemed untradeable is untradeable.
- **Scope.** Confirmed on less-liquid names (ranks ~49–101), including leveraged and crypto-linked products. Found — same sign both halves — but not independently confirmed on the 48 most liquid, SPY/QQQ/AAPL among them. Untested everywhere else. `antiSignalBlock()` applies to every ticker and returns that scope so a consumer can say "confirmed" or "extrapolated".
- **Not wired to anything live.** No engine or cockpit acts on `setups.ts` detections today. Any path that turns a setup into a displayed entry must call `antiSignalBlock()` first.

**ENTER is gated, not retired.** The cockpits stopped saying ENTER NOW / TRADE (commit b1f76f6) because the confluence logic under that label measured as losing at full alignment (−8.2% mean on real 0DTE prices, both halves). An entry label comes back for any setup that beats its mirror out of sample, clears the pre-registered bar, and holds on real option prices. None has yet.

---

## KNOWN GAPS — tracked, not silent

Real gaps that are understood and deliberately not yet fixed. A gap recorded only in a code comment is invisible; this is the visible list. None are urgent, all are real.

**Market holidays are not handled anywhere.** Every schedule in the system is time-of-day only — `forcedClose.ts`, `cvdRebuild.ts`'s session open, and `lib/time.ts`'s busy window all assume any weekday is a trading day. Grepped 2026-08-31: there is no holiday calendar, and no day-of-week check outside `isFeedScheduleActive`, which documents its own weekend omission as UX-scoped. The system will assume the market is open on Thanksgiving, July 4th, and Christmas. Related: `DEFAULT_FORCED_CLOSE` is the *regular*-session schedule and does not know about early closes (1:00 PM ET, e.g. the day after Thanksgiving).

**`timeOfDayBucket`'s `open` bucket has no lower bound.** Anything before 10:30 CT buckets as `'open'`, including a pre-market timestamp. Unreachable for live signals (confluenceEngine gates on real market status) but reachable via `replayTodaySession`, which reads `barsStore` un-gated. **A naive `>= 8:30 CT` bound would be wrong:** 3,426 of 29,294 real `signals` rows carry `entry_tct = 08:29 CT` because that column holds the BAR START timestamp and the opening bar is labelled 08:29. Those are legitimate opening signals. Any fix must handle that convention and reconcile against stored Brain data.

**`entry_tct` is misnamed.** It holds a real UTC epoch (barsStore's `asOf` = bar `tUtc`), not a CT value — verified against live rows, where `entry_tct` and `entry_utc` differ by 0.0 hours. Consumers happen to be correct because `toCentralTime()` expects UTC, but the name invites a future bug.

**Cash-account settlement is not modelled.** `positionSizing.ts` and `checkExposure` treat equity as uniformly available. Under T+1 (standard since 2024-05-28), a *cash* account's proceeds are not buying power until settlement, and spending them is freeriding under Reg T — a 90-day account freeze. Irrelevant on margin; a real constraint if a cash account is ever used for execution. This is why paper validation uses **Individual Margin**, not Individual Cash.

**Webull's OCC exercise threshold is assumed, not confirmed.** `$0.01` is OCC's verified baseline, but a member firm may set its own. See `forcedClose.ts`.

**`insiderSell` is a dead field.** Computed in `catalystGate.computeTags()`, carries a comment claiming it's "used by resolveSignalType" — but `resolveSignalType`'s real signature (`confluenceEngine.ts`) only takes `score, cvd, ctx, currentPrice`; it never reads catalyst data at all. Found 2026-09-02 while designing news-sentiment wiring, by checking the comment against the actual downstream signature rather than trusting it. Not fixed — flagged so it isn't rediscovered from scratch.

**`SwingCockpit.tsx`'s insider criterion never checks transaction direction.** `_lastDiscretionaryBuy()` filters only `!is10b51` — it never checks `transactionType === 'buy'`. A discretionary *sell* passes identically and renders as `"Last discretionary buy Nd ago"`. Found 2026-09-02 during the W4 insider-transactions audit. Dead code (`src/cockpits/`, not live) — recorded so it isn't rediscovered if that cockpit ever comes back.

**`BestContractsCockpit.tsx`'s insider check has zero filtering.** `insiderBuy: fundData.insiderTransactions.length > 0` — no buy/sell check, no 10b5-1 exclusion, despite a comment claiming "only discretionary buys stored" (also stale — see `fundamentalsStore.ts`'s real, current contract: it stores everything unfiltered). Found 2026-09-02, same audit. Dead code, same disposition as above.

*Added 2026-09-11 (funnel Step 1 audit). Each verified against code or data; none fixed yet.*

**0DTE active-trade conviction compounds its multiplier every candle.** `ZeroDteCockpit.tsx` `computeConviction` starts from `monitor.currentConviction` and returns `score × convictionMultiplier(tradeType)`, and the monitor loop feeds that back in on every new bar — so a continuation trade (×1.05) drifts toward 100 and a counter-session trade decays, whatever the market does. It also returns the prior value unchanged (× multiplier) when CVD or GEX data is missing.

**The Indexes "% change" is against the previous 1-minute bar, not the prior close.** `IndexesCockpit.tsx` `_buildTile`: `changePct = (last.close − prev.close) / prev.close` where `prev` is the bar before the last one. Labelled and read as a day change; it is a one-minute change.

**barsStore's cold start asks for a date that has no bars between ~01:30 and 03:00 CT.** `fetchRecentBars` builds `from = now − 390 min` and `_fetchBarRange` sends only the UTC *date*. From ~01:30 CT (06:30Z) until the feed opens, that date is the new UTC day with no bars yet, so a reload in that window starts with an empty buffer (seen 2026-09-11 02:09 CT). The chart now fetches the latest session itself; barsStore consumers (direction state, cockpits) still start empty.

**`dailyHighLowIngestion` runs in every browser, over thousands of tickers.** The browser console shows it walking the whole universe (ACTG, ACTU, ACU, ACVA, …), one REST gap-fill per ticker, in every open tab — on top of the relay engine running the same job. Same request-load class as Track B and as the per-browser full-chain fetch that was moved server-side (see `/engine/gex`). Ingestion belongs to the engine alone; browsers should not run it.

**GEX walls are the largest single (expiry, strike) row, not the strike's total across expiries.** `gexEngine.computeGex` sorts `strikeGex` rows as the chain delivers them — one per expiry per strike — so a strike whose exposure is split over several expiries loses to one large single-expiry row. Walls matched the published SPY walls on 2026-09-10 (765/755), so the effect may be small near-term; it has not been measured.

**The paper-execution ladder path passes `side: 'buy'` where its type (and the direct path) uses `'BUY'`.** `paperExecution.ts:224` and `:323` — two of the four errors in the relay type-check baseline. Whether Webull accepts or mis-reads the lowercase side has not been checked. Paper mode only, but it is the path that will go live.

**Swing's earnings criterion passes when earnings data is absent.** `SwingCockpit.tsx`: `earningsPass = nearestEarnings === null` — "no earnings found" and "earnings data never loaded" both pass.

**No IV history exists, so "IV rank" cannot be computed anywhere.** The 0DTE criterion is now honestly blocked; `bestContractPicker.estimateIvRank` is a documented shape-based estimate from a single IV, not a rank.

**`/engine/gex` and `/engine/delta` are live on the relay; the browser code that reads them is not on Wegic yet.** Verified 2026-09-12: `GET /engine/gex` returns 200 and `GET /engine/delta?ticker=SPY` returns 390 minute bars with coverage complete. The readers — `src/lib/serverGex.ts` (flip) and `src/lib/serverDelta.ts` (the chart's CVD panels) — exist only in this repo; Wegic's production build still computes the flip in the browser and draws the old CVD panels until the comprehensive UI handoff ships.

**Fixed 2026-09-11 — CVD totals ran from process boot, and the rebuild was partial.** Recorded here because the fix exposed faults the failure had hidden (see "Removing a redundancy…"). `cvdStore` totals were set once per ticker and only ever added to, so the 25-point factor scored days of stale flow on every non-deploy day; CVD is now the regular session only (8:30–15:00 CT), reset by the first trade of a new session, and reads `loading` — not yesterday — before it. The boot rebuild was rejected (HTTP 400) on every boot; fixing the request exposed a 25,000-trade cap (SPY's 2026-09-11 session was 470,114 trades), a timestamp cursor that skips ties (32,723 of those trades share their nanosecond with the one before), and a double count (it fetched to "now" through the live write path while live trades arrived over the relay's shared subscriptions). It now pages through Massive's `next_url` cursor, subscribes live first, and drops replayed trades at or after the first live one. Real run, SPY full session: 470,114 fetched, 10 pages, 40 s, 390 minutes. The browser copy (`src/stores/cvdStore.ts`) got the same session scope.

**Fixed 2026-09-12 — SPX and NDX were silently unscoreable.** An index prints no trades, so its CVD is structurally absent, and `confluenceEngine.ts` returns before scoring whenever CVD is not ready — two of the 23 feed tickers were permanently silent in a way that looked like a quiet day. They are now excluded from scoring explicitly (`SCORED_TICKERS` / `NO_TRADE_FEED_TICKERS` in `state/directionState.ts`) while keeping bars, chain and GEX; the boot log says `NOT scored: SPX, NDX — … deliberate, not a quiet market`, and the rebuild reports them `none-needed` rather than `absent` (production, main 74043e3: 21 real, 0 partial, 0 absent, 2 none-needed). Scoring them for real would need flow from something that trades — the index ETF or the index options.

**`stock_float` does not exist in Supabase, so free float has no persistence.** Railway logs on both the 2026-09-10 and 2026-09-11 deployments: `free float hydrate failed — relation "public.stock_float" does not exist`. **Correction to what this note first claimed (2026-09-11):** the W8 free-float fix is NOT dead in production. `_runFloatForTicker` calls `fundamentalsStore.upsertFreeFloat()` with the real Massive value whether or not the DB write lands, and `runFloatBackfill` runs 9 s after boot and weekly (`engine/index.ts`), so `squeezeEngine`'s derived short float is real for the life of the process. What actually fails is durability and the boot hydrate — a ~9-second window at each restart, and nothing to fall back on if Massive's float endpoint is down. The table's DDL is in `shortInterestIngestion.ts`'s header and `backups/stock-float-table.sql`; the engine has no service-role key and cannot run DDL itself. The same is true of any other table that was specified but never created — check before assuming a write path works.

**Browser CVD starts at page load.** The browser has no rebuild, so a tab opened at 11:00 CT scores (and, while browsers still write, signals on) CVD from 11:00. Same class as the boot bug above; ends when browser writes are switched off at Shadow Mode cutover.

**The rebuild's uptick classification is not a small approximation — measured 2026-09-11.** SPY, 08:30–08:40 CT, 25,745 real trades classified both ways: the uptick rule and the real quote test (the one live CVD uses) **agree on only 72.5%** of trades, **36.1% of trades print inside the spread** where the uptick rule is guessing, and the 10-minute cumulative delta comes out **1,259k versus 411k — 3× apart**, biased toward "buy" in a rising tape. Per-minute signs still agreed 9 times in 10, so the shape survives; the scale does not. Consequences: the rebuilt part of a session's CVD is not on the same scale as the live part, so anything scoring a raw cumulative delta across both is comparing two different measurements — prefer imbalance ratios, or the live-classified portion (`liveFromUtc` marks the boundary). Historical quotes ARE available (`/v3/quotes`, confirmed live), but a full-session quote rebuild is ~8M quotes per ticker (160 pages) against ~470k trades (10 pages), so it is not affordable at boot for 21 tickers.

**Rebuilt CVD differs from live CVD in three measured ways.** Replayed trades classify by the uptick rule (no quotes in `/v3/trades`); fractional-share prints (`size: 0`, `decimal_size` carries the real amount — 10% of SPY's trades, 0.026% of its shares) are skipped by both paths; trades sharing the first live trade's millisecond but printed before it are in neither set. A relay upstream reconnect mid-session still loses the trades in the gap — the rebuild runs only at boot.

**A whole minute can be missing from the browser's live bars.** Seen 2026-09-11 13:48Z on all 11 checked tickers after a reload during market hours: no provisional bar and no AM for that minute, ever — 13:47 and 13:49 present. The reload-time ingestion storm had the tab saturated (chain polls hitting their 40s hard timeout), so the most likely mechanism is a relay heartbeat termination and a reconnect without a gap-fill, but the console buffer had rotated before that could be confirmed. Mechanism unproven.

---

## WORKFLOW

1. Branch. Never work directly on `main`.
2. Make the change. **Scripted edits must prove they matched.** This checkout has `core.autocrlf=true`, so any file git has touched comes back CRLF — and a scripted `s.replace('…\n…', …)` then matches nothing, returns the string unchanged, and the script reports success. On 2026-09-12 that silently dropped `fwd_30m_pct`/`fwd_60m_pct` from the DDL meant for Wegic while the deployed engine wrote both columns; `observationTables.schema.test.ts` now fails on that drift. Assert the anchor exists (throw if `!s.includes(anchor)`), or use an editor that normalises line endings.
3. `node relay/scripts/checkSyntax.mjs` on anything touched (NOT `node --check` for `.ts` — see rule 2), plus both type checks: `npm run typecheck` and `npx tsc -p relay/tsconfig.typecheck.json` (baseline: 4 pre-existing errors in contractDiscovery/paperExecution).
4. Full test suite, per-file output.
5. Show the real diff.
6. Push. Railway auto-deploys **from `main` only** (verified 2026-09-11 from `railway deployment list --json`: every deployment's `meta.branch` is `main`) — a branch push deploys nothing; fast-forward `main` to ship.
7. **Verify in the Railway logs that it actually did what was intended.** `railway logs` returns only the last 500 lines, and ingestion logging fills that in minutes — use `railway logs --deployment --filter "<text>" --lines 200` to find boot-time lines.

**Never deploy during market hours** unless the fix is more urgent than the interruption. Deploys drop the upstream connections and reset in-memory state.
