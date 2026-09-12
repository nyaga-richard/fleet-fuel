# UI/UX Audit & Fixes

Full audit of the Web + Mobile interfaces, the problems found, and what was
changed. Business logic (APIs, RBAC, workflows, offline queue, ledger) was
**not** modified — the UI consumes exactly the same endpoints and payloads.

## Audit findings → fixes

### Web
| # | Finding | Fix |
|---|---------|-----|
| W1 | `useAuth` was a per-component hook: every page re-read localStorage and rendered with `user = null` on first paint → `Cannot read properties of null (reading 'role')` on requests / issue / inventory / vehicles | Rewrote as a single shared `AuthProvider` context (root layout). Pages render only inside the shell gate. Defensive `user?.` everywhere |
| W2 | "System page causes logout": a dead/rotated token 401'd on the first real API call and cleared the session — *correct behaviour*, but the crash on other pages made it feel random, and sign-in gave no explanation | Login page now shows *"Your session has expired — please sign in again."* via `?expired=1`; auth provider detects corrupt/stale cached profiles and signs out cleanly |
| W3 | Sidebar fixed-width, no collapse, stacked vertically on mobile | Collapsible sidebar (persisted), icon rail when collapsed, drawer + top bar under 940 px |
| W4 | No search anywhere except vehicles | Header **global search** (vehicles server-side via `?q=`, requests/transactions grouped results, debounced 300 ms); per-table search on requests, transactions, deliveries, ledger |
| W5 | No filtering on ledger/transactions despite server support | Ledger: fuel type + entry type + date range (**server-side** params), CSV export. Transactions: date range + vehicle (server-side) |
| W6 | Tables unusable on phones | `DataTable`: sticky header + pagination on desktop; card list on <768 px; all request/txn/delivery/tank/reading lists have mobile cards |
| W7 | Raw status text, color-only | `StatusPill`/badge = dot + capitalized text (never color-only) |
| W8 | "Loading…"/blank states, no error recovery | `Skeleton` loaders, `EmptyState` (with guidance + action), `ErrorState` with retry, friendly network/401 messages |
| W9 | Fuel decision buttons buried in tiny table rows | Tap a row (or card) → **details drawer**: full request info, then Approve / Reject / Cancel / Issue-fuel actions with confirm dialogs — audited decisions from one place |
| W10 | Excess issuing silent | Issue form shows `Authorized: X L`, warns inline on excess before submit (server still enforces the excess-approval workflow) |
| W11 | Double submissions possible | All mutating buttons disable + show progress ("Issuing…", "Saving…") |
| W12 | Locale inconsistencies | KES currency, DD/MM/YYYY, 24 h, Africa/Nairobi via shared formatters; tabular numerals |
| W13 | Dashboard static | KPI cards (stock with low-level tones, issued today, pending), 14-day usage SVG chart from live data |

### Mobile
| # | Finding | Fix |
|---|---------|-----|
| M1 | `mobile/src/auth.js` missing from repo (imported by 3 screens) | Recreated: SQLite-backed session, human-readable login errors, offline-aware messaging |
| M2 | Tab bar fixed height 58/paddingBottom 6 → covered by Android gesture bar / home indicator | Height = 58 + `useSafeAreaInsets().bottom`; hides while keyboard open; **no absolute positioning** |
| M3 | `softwareKeyboardLayoutMode: "pan"` fought every form | Changed to `"resize"`; forms use `KeyboardAvoidingView` (iOS) + `ScrollView` + `keyboardShouldPersistTaps` |
| M4 | Modals had no keyboard handling — inputs hidden behind keyboard | All forms are keyboard-safe bottom sheets (`Sheet`) with scroll + visible actions |
| M5 | Issue fuel from a tiny button in a list (spec violation §14) | New flow: Requests/Fueling list → tap card → **Request Details** screen (`app/request/[id]`) → `ISSUE FUEL` → 8-step fueling form (`app/issue/[id]`) → confirmation panel (SYNCED / PENDING SYNC) |
| M6 | No search on lists | Debounced `SearchBar` on Requests and Fueling; filter chips by status |
| M7 | Offline/sync state invisible | `OfflineBanner` (offline + last sync), Home header queue badge, Sync tab with Pending/Failed/last-sync counters, failed items never auto-deleted + RETRY |
| M8 | Tiny touch targets | All buttons/chips/rows ≥ 44 pt (`TAP`) |
| M9 | Wrong keyboards | odometer `number-pad`, quantities/meters `decimal-pad`, email/password proper textContentType, search `returnKeyType="search"` |
| M10 | Empty states as one grey line | `EmptyState` with icon/title/guidance/action (e.g. "No vehicles cached — sync first") |
| M11 | Double-submit risk | COMPLETE FUELING disables + shows "Completing…" while queueing; op queued once with idempotent `op_id` |
| M12 | `crypto` crash (fixed earlier) | UUID v4 generator, no `crypto` global |

## Unchanged (deliberately)
- All backend endpoints, RBAC, ledger semantics, excess-approval workflow.
- Mobile sync engine + SQLite schema + **exact** op payload shapes
  (`fuel_request`, `fuel_transaction`) — server idempotency untouched.
- Attendants still cannot authorize; approvals stay manager/admin (server + UI).
