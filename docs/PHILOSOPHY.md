# jep: Philosophy

The design principles that keep this project safe to iterate on. Separation of
concerns is the core: every module has one job, one seam, and one way to test
it.

## 1. Hexagonal core (the adapter seam)

`src/core/ports.ts` defines the one surface every harness normalizes to:
`HarnessAdapter` (id, endpoint, health, session CRUD, prompt, messages, abort,
approvals, events, optional `models()`, close). `src/harnesses/opencode.ts` is
currently the only real adapter, but the bot (`bot.ts`) only ever sees the
port type, never `opencode serve` specifics.

- The **Telegram front end does not know about opencode**. It knows `model =
  "provider/model"` string, `ModelRef {providerID, modelID}`.
- The **backend does not know about Telegram**. It emits `DomainEvent`s;
  `bot.ts` decides how to present them.
- `assertAdapterImplements` (`core/compliance.ts`) compiles a behavior suite
  so a future harness (goosed, dsh) must prove the same contract before the
  bot will talk to it.

Rule: **no cross-layer imports.** If you touch the wire format, change
`api.ts`. If you touch rendering, change `html.ts`/`rich.ts`. Both change →
`bot.ts` stays as orchestration glue.

## 2. The Telegram side is layered, not tangled

```
api.ts    transport    JSON round-trips, parse_mode, fallback/retry. No UX.
html.ts   pure render  markdown → Telegram HTML + box tables. No I/O, no state.
rich.ts   pure render  markdown → Rich Message blocks.      No I/O, no state.
store.ts  persistence  titles + model picks, JSON file.     No UX, no wire.
pair.ts   ownership    pairing codes, owner lock.
bot.ts    orchestrate  chat state, commands, callbacks, streaming, pickers.
```

Each file can be read, tested, and replaced on its own. The renderers are the
only place that knows markdown syntax; `api.ts` is the only place that knows
how the Telegram fallbacks behave; `bot.ts` never composes a Telegram request
by hand (it always goes through the `#tg` interface).

## 3. One choke point for all output

`#recording` wraps the `TelegramApi` handed to `bot.ts`, so **every outbound
`sendMessage`/`editMessageText` is markdown→HTML + `parseMode:"HTML"`**.
Consequences:

- No call site can forget to render. New messages are correct by construction.
- Menu text, help, errors, and streamed updates share one formatting policy.
- `sendRichMessage` deliberately bypasses the conversion (already structured).

This is the difference between "a feature works" and "every feature works the
same way".

## 4. Fallback-first: degrade, never fail the user

Every feature assumes the fancy path can break, and ranks a downgrade:

- Rich block → HTML boxes → plain text (`finalize()`).
- Parse-entity 400 → retry without `parse_mode` (`callWithFallback`).
- `"message is not modified"` → treated as success.
- Registry CLI missing/times-out → config models only, default still present.
- `auth.json` absent → models still listed, may not run (logged comment).

User-facing errors are the last resort, not the default. A broken renderer
should look slightly worse, not crash the bot.

## 5. Escape-first, streaming-safe

`html.ts` escapes **before** markup and keeps inline tags within single lines.
Reasons:

- Malformed/agentic markdown degrades to plain text instead of a 400.
- The streaming placeholder is sliced mid-turn; if tags could span line
  boundaries, a slice could blow up the whole wire call. They can't.

Mutate-then-escape would be a latent bug factory. The contract is explicit in
the code comment and must not be relaxed.

## 6. Isolated state, shared credentials

The bot's opencode serve runs with its **own** `XDG_DATA_HOME`
(`JEP_DATA_HOME`) so the user's CLI store and session list are never touched.
But that isolation would hide the user's auth, making the picker list models
that can never run, so `syncOpenCodeAuth` **mirrors** `auth.json` into the
isolated store at boot.

The line is deliberate: **session state is isolated, credentials are shared.**
If a new harness needs other secrets, follow the same pattern (mirror, don't
switch the whole data home over).

## 7. Deterministic renderers

`mdToHtml` and `mdToRich` are pure: string in, blocks out, no I/O, no clock,
no network. They are the testable core. The messy stuff (timing, off-by-one
message ids, API backoff) lives in `bot.ts`/`api.ts`. Keep new rendering logic
pure with the parsers in this style, and they stay verifiable via the mock
dump.

## 8. Mock-first verification

- Deterministic fixtures (`fixture/telegram-mock*.jsonl`) drive the bot
  through a scripted session; the `CALL ...` dump is the assertion. A fix
  should show its new behavior in the dump before it ever touches live.
- Only after the mock confirms does the feature ship via live restart, and
  only then does the user's real client decide it "splendid".
- Fixtures encode intent (e.g. `mode=HTML` on every outbound message), so a
  regression in the render pipeline fails the mock before the user sees it.

## 9. Defaults are free, choices are explicit

- The default model is the free local proxy `localfree-models-proxy/auto`;
  nothing burns money unless a chat explicitly picks (and persists) a model.
- Registry models (free zen `opencode/*`, paid `opencode-go/*`) are **listed**
  in the picker but never selected implicitly. Presence in the picker ≠ use.
- Restarts keep ownership and history; deleting a conversation (the 🗑 next
  to it in `/ls`, with a confirm step) is explicit and destructive on
  purpose: nothing is ever cleared implicitly.

## 10. Small, coherent verbs; a command does exactly one thing

`/settings` reports state, deleting a conversation touches that conversation
and nothing else, `/abort` stops the turn. Destructive actions stay narrowly
scoped to what they name; nothing a user does should ever reach further into
persistent state than it promises. Clearing a chat's visible history
is Telegram's own job now (its native "Clear History"); jep doesn't
duplicate platform features it doesn't need to own.
State lives in one place (`ChatState` + `store.json`); pickers keep a snapshot
so navigating never mutates the thing being chosen.

## 11. Shipping rule

Per change: syntax check → mock proof → live restart → user confirms → done.
No commit unless asked. No "great, done" silently; the bot that runs on the
user's phone is source of truth, and the live log is the heartbeat.