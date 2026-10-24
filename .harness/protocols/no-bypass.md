---
type: protocol
status: draft
last_reviewed: 2026-04-23
related:
  - protocols/development-cycle.md
  - protocols/testing-protocol.md
  - protocols/tdd-and-scope.md
  - protocols/safety-protocol.md
  - protocols/commit-and-pr-protocol.md
  - references/env-variables.md
tags: [protocol, integrity, bypass, blockers]
---

# No-Bypass Protocol

**When to read:** whenever you are tempted to work around a blocker instead of solving or surfacing it.
**When to update:** when a new bypass pattern recurs enough to be worth naming (human sign-off).

> Status: **draft** — proposed protocol addition. Flip to `canonical` once approved.

## Summary

When a task is blocked, the correct response is to **surface the block**, not route around it. Routing around blocks is how we ship half-done work, silently red tests, and — in one real case — an entire parallel frontend that shouldn't have existed.

- Missing environment or config → **ask**, don't invent.
- Red test → **fix or surface**, don't silence.
- Real-browser step hard today → **say so**, don't substitute `curl` and claim UI parity.
- Task genuinely too big → **reduce scope and say so**, don't ship a TODO.

The rule: **Surface the block. Do not silently bypass.**

This is about work integrity, not just testing. Bypasses can live inside a green PR.

---

## The canonical cautionary tale

An agent was asked to extend the dashboard. Several environment variables weren't configured locally. Instead of asking what values should go there, the agent **built a parallel frontend** that didn't need them, and declared the task done. The PR looked complete. The actual product was untouched and the repo now carried dead code.

This is the shape of the failure: a bypass that passes the mechanical definition of "done" while corrupting the system. Once you've seen it, you'll see the smaller versions everywhere.

---

## Bypass patterns to name and refuse

| Pattern | What it looks like | The right move |
|---|---|---|
| **Silence the test** | Add `skip` / `xfail`, delete the assertion, comment out the file | Fix, or add a row to [`../references/known-broken-tests.md`](../references/known-broken-tests.md) with a linked issue |
| **Weaken the test** | Loosen an assertion until green | If the old assertion was wrong, explain why in the PR. Otherwise keep it strict. |
| **Replace browser with curl** | Use `curl` to stand in for real-browser validation because the browser is flaky or hard | Restart the browser. If genuinely blocked, surface it — don't claim UI parity you didn't verify. See [`../playbooks/browser-testing.md`](../playbooks/browser-testing.md). |
| **Invent missing config** | Fabricate env vars, secrets, file paths, service URLs | Ask. Map in [`../references/env-variables.md`](../references/env-variables.md). |
| **Parallel-universe fix** | Build a second implementation alongside the hard thing to avoid touching it | Stop. The existing thing is the thing. Touch it or ask. |
| **Ship-and-TODO** | Commit the half-done version with `TODO: fix later` and call it merged | Not done. Finish, or reduce scope and land a smaller thing honestly. |
| **Feature-flag parking** | Wire the code behind a flag that is never enabled | Shipping means on and observed |
| **Mock the integration surface** | Hand-write a stub that looks like the real agent / bridge / DB | Capture a real fixture. See [`testing-protocol.md`](testing-protocol.md). |
| **Hidden-branch work** | Implement the fix in a side branch; merge only the easy part | The PR must represent the actual change |

This list grows by incident. New entries arrive via the write-protocol, not this file's author.

---

## The positive frame — what to do when blocked

1. **Name the block in one sentence.**
   - "Missing `SUPABASE_SERVICE_ROLE_KEY` in `web/.env.local`."
   - "Browser subagent crashes opening the chat modal."
   - "Test assumes a real Postgres; we only have SQLite locally."
2. **State what would unblock you** — who should answer, what value / decision you need.
3. **Offer the minimum parallel work** you can do while waiting (plan, tests, docs).
4. **Ask.** A 30-second clarification is always cheaper than a 2-hour bypass.

If the user is unavailable and a reasonable deviation is needed, it's still allowed — but you document it openly: the workaround goes in the PR description *labelled as a workaround*, not disguised as the finished feature.

---

## The line between pragmatic and bypass

Judgment lives here. Rough guide — use it and then trust yourself:

| Situation | Likely not a bypass | Likely a bypass |
|---|---|---|
| Test depends on a service the environment can't run | Skip with a linked issue + `known-broken-tests.md` row, explained in PR | Silent `skip` on the one test that would catch your bug |
| Real-browser harness crashes | Restart; if it recurs, capture as a learning | Declare the task done because the browser "didn't work today" |
| Missing config | Ask; if answered, wire it; if not, pause and ship a plan | Invent plausible-looking values and proceed |
| Target system behaves unexpectedly | Investigate, write a regression test, capture a learning | Build a second target that behaves as expected |

Can't tell which side you're on? **Ask.** Same principle as [`tdd-and-scope.md`](tdd-and-scope.md).

---

## Self-check before you claim done

Walk this list before pushing:

- [ ] Every test I disabled is either fixed, linked to an issue, or listed in `known-broken-tests.md`.
- [ ] Every UI claim was verified in a real browser.
- [ ] Every env variable I relied on is either in `env-variables.md` or named in the PR description.
- [ ] My PR description labels any workaround I took and why.
- [ ] I did not create parallel code paths to avoid touching the hard thing.
- [ ] I did not ship a TODO in place of finishing.
- [ ] Nothing I marked "done" would surprise a reader who ran the code without reading the diff.

If any line is uncomfortable, close the loop before claiming done.

---

## See also

- [`development-cycle.md`](development-cycle.md) — phase 4 (Test) + phase 5 (Review) are where bypasses get born
- [`testing-protocol.md`](testing-protocol.md) — the testing bypasses
- [`tdd-and-scope.md`](tdd-and-scope.md) — the scope-discipline counterpart
- [`safety-protocol.md`](safety-protocol.md) — its cousin for secrets / destructive ops
- [`commit-and-pr-protocol.md`](commit-and-pr-protocol.md) — evidence rules that make bypasses visible
- [`../references/env-variables.md`](../references/env-variables.md) — the canonical map that ends "invent missing config"

## Referenced by

- `README.md`
- `protocols/development-cycle.md`
- `protocols/testing-protocol.md`
- `protocols/tdd-and-scope.md`
- `protocols/commit-and-pr-protocol.md`
