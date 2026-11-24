# Tuning notes

Measurements behind the defaults in `packages/engine/src/config.ts` and `packages/runtime/src/config.ts`. Dates are 2026-09-27; model `claude-haiku-4-5-20251001`, backend `claude-code` unless noted.

## 1. Game rules (scripted bots)

`packages/cli/scripts/bot-tune.ts` plays `bots-none` (own vision only) against `bots-perfect` (union vision) on 30 seeds per setting. The bots are dumb on purpose; the question is only whether shared information pays.

| spread | growth every | civilian deadline | none | perfect |
|---|---|---|---|---|
| 0.08 | 4 | 12 | −22 | +14 |
| 0.05 | 6 | 16 | −3 | +36 |
| 0.035 | 6 | 16 | −3 | +38 |

Chosen: `base_spread 0.05`, `growth_every 5`, `civilian_deadline 15`, and the rescuer drives at 2 tiles/tick (at 1 tile/tick almost every civilian was lost even with perfect information). Fires still escalate if ignored, and information clearly matters.

## 2. LLM latency on the `claude-code` backend

| Change | Mean decision latency | Mean input tokens |
|---|---|---|
| First version, one `query()` per decision | 14–21 s (max 43 s) | 3k, but some calls ~85k |
| Pre-started ("warm") streaming sessions | ~4.7 s | 82k on every call (reverted) |
| Return on the tool result instead of waiting for the subprocess to exit | ~2 s saved per call | — |
| `thinking: { type: "disabled" }` | **~4 s** | 19–30k |
| `strictMcpConfig: true` (don't load the account's claude.ai connectors) | ~4 s | **~3k** |

Concurrency is not the bottleneck: 10 parallel trivial calls take ~3.4 s, 20 take 4–9 s. A 5 s tick fits.

## 3. Agent competence (prompt version 2)

First full match (seed 5, four teams): `none −52`, `perfect −54`, `band −54`, `subagents +7`. All the difference was two civilians the sub-agents happened to reach. The replays showed why the other teams failed:

- firefighters on `wait()` with fires in view,
- the rescuer retrying `move_to` behind debris after a bare `no_path`,
- many `move_to` orders onto water or houses (coordinate misreads), each costing a retry turn.

Fixes, identical for every team:

- `move_to` onto an impossible tile is redirected to the nearest reachable tile (SPEC §4.3).
- Blocked orders explain themselves: `no_path: debris at (17,6) blocks the way; the engineer can clear it`.
- Role playbooks in the system prompt (target orders walk there by themselves; don't wait when there is work; pair up on intensity-3 fires; debris the rescuer needs comes first).
- The map header shows two-digit column numbers.

After the fixes, seed 5 over 30 ticks: `none −60`, `perfect +3`. The reference gap exists.

## 4. Batch 1: seeds 11–13, prompt v2

| Seed | none | perfect | band | subagents |
|---|---|---|---|---|
| 11 | −80 | 17 | 12 | −50 |
| 12 | −1 | 49 | −34 | −9 |
| 13 | −52 | 7 | −47 | −50 |
| **mean** | **−44** | **+24** | **−23** | **−36** |

- The reference gap holds on every seed (perfect − none ≈ 68 points on average), so the game rewards information. That was the M5 gate.
- Band averaged ahead of sub-agents but far below perfect. Its metrics showed why: 2–3× more idle agent-ticks than perfect, and **about 30% of Band decisions sent a message without giving an order** (73 of 239 on seed 11). The agents talked instead of acting. Band never used `create_room`.
- Sub-agents: the orchestrator's queue is short, but bodies sit idle between spawns (idle agent-ticks 126–156, the highest of all teams). The forecast almost never reached a non-scout (0–1 tick lead).

Fix (prompt v3, shared rules text, so it applies to every team with communication tools): *"a message never replaces an order. In the same turn, send what teammates need to know AND give your own order."*

## 5. Batch 2: seeds 11–13, prompt v3

The first attempt hit the Claude subscription's usage limit at tick 1; the runner aborted it (`aborted: usage_limit`) and `report` skips it. Rerun after the limit reset:

| Seed | none | perfect | band | subagents |
|---|---|---|---|---|
| 11 | 10 | 14 | **43** | −20 |
| 12 | −41 | −5 | **−4** | −5 |
| 13 | 5 | −24 | **40** | −60 |
| **mean** | **−9** | **−5** | **+26** | **−28** |

- Band scored highest on 2 seeds and tied on the third. Its message-only decisions dropped, and it sent more messages (100–111 per match vs 59–75), sharing more while still acting.
- **The reference gap did not hold in this batch**: perfect ≈ none on average and below it on seed 13. The same seeds varied a lot between batches (none on seed 13: −52 then +5), so LLM variance per match is large compared to the effects.
- Likely reasons the "perfect" team is not a real ceiling with LLM agents: its prompts carry everyone's view and orders, and agents tend to herd onto the same visible fire. It remains the right *information* ceiling; it is not a *play-quality* ceiling.
- The report now computes relative score from the team means (per-seed ratios exploded, e.g. 825% on seed 11).

## 6. Before a public demo

1. Run 10–20 seeds per configuration. With per-match swings of ±50 points, 3 seeds cannot separate the teams reliably. Use the `api` backend or spread batches across usage windows (~2,000 decisions per 3 four-team matches).
2. Try one batch with a stronger model (open question §14.7): weak play adds noise that hides communication effects.
3. Look at why `perfect` underperforms (herding, prompt size), e.g. give each agent its own view plus a compact list of teammates' orders instead of the full union.
4. Keep the showcase honest: pick replays that show the mechanism (idle sub-agent bodies, forecasts that never arrive), not just the biggest score gap.

## 7. Band control teams (measured on the seven curated recordings)

Measured before building `band-replica` and `chat-broadcast` (SPEC §7.7), from the Band worlds in `recordings/20260927-*.sqlite`:

- **Delivery delay** (send to delivery, 1,448 deliveries): min 365 ms, p50 409 ms, p90 561 ms, p95 724 ms, max 1,044 ms. `bandLatencySampler` samples these 5% quantiles. A delivered message then waits a median of about 2.2 s for the recipient's next decision (prompt v3 batch), so the platform delay is a small part of the total.
- **Delivered text:** in all 582 messages found in recorded prompts, Band put the mentions in front of the text, last mention first (`@ff2 @ff1 <text>`). The replica copies this.
- **Rooms:** the agents never called `create_room`. Every match has only the setup room.
- **Addressing:** in the prompt v3 batch, 168 of 389 Band messages (43%) went to 4 or more teammates, so close to broadcast.

No control-team matches have run yet. Plan at least 10 seeds of `none, band, band-replica, chat-broadcast`: with swings of about ±50 points per match, a 20-point difference needs about 30 matches.

**Band's delay depends on the runner's connection (2026-11-20 to 2026-11-24).** The dry run (seed 99, `runs/20261120-191605-s99-jv5q.sqlite`) found Band's delay about twice the old table's. Probes with no model then sent messages between the five agents (1 to 4 recipients each, one every 2.4 s). Both the REST call of `send_message` and the WebSocket delivery go over the runner's own connection, so all of these numbers measure Band plus that connection:

| Band send-to-delivery delay | n | min | p50 | p90 | p95 | max (ms) | REST p50 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 2026-09-27, curated matches (first table) | 1,448 | 365 | 409 | 561 | 724 | 1,044 | |
| 2026-11-20, poor connection, dry run seed 99, in match | 96 | 625 | 918 | 1,741 | 2,116 | 2,672 | |
| 2026-11-21, poor connection, probe, no match | 730 | 587 | 656 | 933 | 1,201 | 2,665 | 339 |
| 2026-11-21, poor connection, dry run seed 98, in match | 68 | 657 | 4,238 | 10,459 | 21,338 | 24,875 | |
| 2026-11-24, stable connection, probe, no match | 762 | 214 | 245 | 283 | 303 | 5,243 | 150 |

- On 2026-11-21 this looked like Band getting slower. The 2026-11-24 probe on a stable connection shows it was the connection: Band was faster than in September, and the REST send took 150 ms instead of 339 ms.
- On a poor connection, delays get much longer during a match than with no match running, because 20 model processes share the connection.
- The replica's own timers ran on time in the same process (p50 416 ms against a target of 409 in the seed 99 dry run), so the extra delay is not our event loop.
- Why it matters: ticks run on the clock (5 s), so a later delivery can push the recipient's order past a tick boundary. An extra 500 ms does this for about 10% of message-driven decisions, always against the slower team.

**Change:** a fixed table goes out of date, and it cannot know the runner's connection, so the control teams now follow Band live (`replica.latency_ms: band-live`, SPEC §7.7). Each delivery samples one of the last 200 delays of the `band` world in the same match. Until that world has 20 deliveries, or with no `band` team, it samples the fixed table, which now holds the 2026-11-24 stable-connection probe at every percentile. A table in 5% steps let the one 5,243 ms outlier fill 5% of draws (table mean 373 ms against 271 ms measured); with 1% steps the mean is 281 ms.

**Bad connection (2026-11-21).** The seed 98 dry run (`runs/20261121-170926-s98-lct3.sqlite`, commit `17158ff`) ran on a poor home connection, with one `fetch failed` send error. Probes with no match running, just before and just after it, gave p50 656 and 666 ms, so the slowdown came from the connection under load, not from Band. The replica followed Band live (p50 4,031 ms), which shows `band-live` works. But a bad connection still hurts only `band`, in two ways the replica cannot copy: Band's `send_message` waits for its REST response before the agent's decision continues, and network errors happen only to Band. Batches therefore run on a stable connection, with the rule for network-degraded matches in §7.1.

### 7.1 Batch plan (written 2026-11-20, amended 2026-11-21 and 2026-11-24, before any full control-team match)

Fixed before the batch runs, so the seeds and the analysis cannot be chosen after seeing results. Amended twice before the batch. On 2026-11-21 the replica delay changed to follow Band live (see above), and the delay check changed to match. On 2026-11-24 network-degraded matches were added to the rules for matches that are run again.

- **Teams:** `none, band, band-replica, chat-broadcast`, all four in every match.
- **Settings:** the defaults at the commit that adds `band-live`: engine 0.2.0, prompt v3, `claude-code` backend, `claude-haiku-4-5-20251001`, 60 ticks × 5,000 ms, `replica.latency_ms: band-live`. No change to code, prompts or config during the batch.
- **Seeds:** 100 to 129 (30 matches). Seeds 5 and 11 to 13 were used to tune the prompts and are not used. Seed 99 is a dry run and is not part of the results.
- **Band agents:** five external agents in the runner's own Band account (not the agents of the curated recordings). The agents only carry messages; the LLM loop is ours.
- **Main metric:** final score. For each seed, take the paired difference between two teams on the same seed:

  | Comparison | Question |
  | --- | --- |
  | `band` − `band-replica` | Does Band's platform add anything? |
  | `band-replica` − `chat-broadcast` | Does mention-only delivery add anything? |
  | `chat-broadcast` − `none` | Does any communication add anything? |

  Report the mean paired difference with a 95% confidence interval (t distribution, 29 degrees of freedom), and the number of seeds where it is positive. A comparison shows a difference only if the interval excludes 0. All three comparisons are reported, whatever the result.
- **Secondary metrics** (described, no test): message count, message latency, idle agent-ticks, stale actions, missed joint tasks, cost.
- **Aborted matches** (`usage_limit`, interrupted, budget) are not scored. Their seed is run again from the start.
- **Network-degraded matches** are not scored either, because a slow connection hurts only `band` (see "Bad connection" above). A match is network-degraded if the `band` world's send-to-delivery p50 is above 1,500 ms, or it has any `transport_error` or `rate_limited` event. Both are read from the recording, so anyone can check them. The batch pauses until the connection is fixed, and the seed is run again from the start. Degraded matches are listed with their scores in an appendix.
- Every other completed match is kept: no match is dropped for its score or model latency. Band `transport_error` and `rate_limited` counts are reported per match.
- **Delay check:** for each match, report the send-to-delivery delays (p50, p90) of `band`, `band-replica` and `chat-broadcast`. If a control team's median differs from Band's by more than 100 ms in a match, say so with the results, because the comparison then also includes that delay difference.

