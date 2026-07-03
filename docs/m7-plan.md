# M7 — Expansion II: preview WebSocket upgrade + Discord UI parity (implementation plan)

Design of record for M7. Lands the two M6 deferrals that are ready now: the
preview proxy learns to carry WebSocket upgrades (live dev servers — Vite HMR,
Next.js fast refresh — finally work through a preview URL), and the Discord
surface reaches UI parity with Slack (in-chat secret entry, the bare-command
repo picker, and a session list) over the same thin transport seam M6 drew.

> Prereqs already landed: the M6 preview proxy (host-side capability-token
> ingress, `forwardPort`, route-dies-with-env), the M6 `DiscordTransport` seam
> (all adapter logic tested over a fake; discord.js glue is the
> documented-untested boundary), the M6 Slack modals whose semantics Discord
> now mirrors (`secret.submitted` events, m6-plan Decisions 8/9), and the
> orchestrator's `listSessions` read already served over `GET /sessions`.

## Scope

In (per roadmap M7+ and the M6 deferral list):

- **Preview-proxy WebSocket upgrade** (deferred M6 → here): `Upgrade:`
  requests through `/t/<token>/…` complete the handshake against the
  container and become a raw spliced duplex. Unknown tokens still 404 before
  any upstream dial; revoking an env now also severs its LIVE upgraded
  connections (a preview URL must not outlive its env even mid-session).
- **Discord modal parity (M4→M6 deferral closes)**: the `set-secrets` button
  opens a real Discord modal (same three optional fields, same
  `secret.submitted` events, contract whitelist unchanged); bare `/devspace`
  opens a repo-picker modal (dismissal creates nothing — Decision 9 held).
- **Discord session list**: a `/sessions` slash command answers with the
  user's sessions from the SAME `listSessions` read that feeds Slack's App
  Home (Discord has no Home tab; an on-demand ephemeral reply is the
  platform-native equivalent — chat-platform-ui-parity.md).

Out (seeded to M8+, with rationale — unchanged from the roadmap's own
caveats):

- **Multi-host scheduling.** Still meaningless before a second sandbox host
  exists; placement/capacity/drain deserve their own milestone, and the
  load-bearing exec stream is deliberately in-process today (exposing it over
  the network is top-risk #1 and must anchor that milestone, not ride along).
- **NATS bus.** Pays for itself only alongside multi-host; `EventBus` remains
  the seam.
- **mTLS / per-service identity on the internal API.** A deployment layer
  replacing the shared token — not app code (m6-plan Decision 3).
- **Discord Forum-channel session dashboard.** `/sessions` covers the list
  surface; Forum-post-per-session is a presentation upgrade, not a gap.

## Decisions

1. **The upgrade path stays as dumb as the request path.** Match the token,
   strip the prefix, dial the container, replay the handshake, and — on the
   upstream's `101` — splice the two sockets byte-for-byte. No frame parsing,
   no subprotocol negotiation, no ping management: WebSocket semantics belong
   to the endpoints. A non-101 upstream answer (handshake rejected) is
   serialized back to the client verbatim and the connection closed — the
   proxy never invents a response.
2. **Live upgraded sockets die with their env.** The request path's routes
   were already revoked on teardown, but an established WS is a long-lived
   TCP pair that would otherwise survive route removal. The proxy tracks
   upgraded sockets per env and `revokeEnv` destroys them. (Plain in-flight
   HTTP requests stay untracked: they are bounded by the container's own
   death, which teardown performs anyway.)
3. **Discord modals ride an interaction handle, not a new transport model.**
   Discord's `showModal` must BE the interaction response (Slack's
   `trigger_id` equivalent, same 3s budget). The seam change is minimal:
   slash/button events carry an opaque `interactionId`, the transport gains
   `openModal(interactionId, modal)` + `replyEphemeral(interactionId, body)`,
   and a `modalSubmit` inbound handler. The glue keeps a short-lived
   id→interaction map; the adapter stays fully testable over the fake.
4. **The glue defers buttons — except modal openers.** discord.js cannot
   `deferUpdate` and then `showModal` on the same interaction, and the
   adapter's non-modal button paths may legitimately exceed the 3s ack budget
   (create-pr). So the glue acks by exclusion: customIds in the exported
   `MODAL_BUTTON_IDS` set are left un-acked for the adapter's `openModal`;
   everything else defers immediately, exactly as M6 did. A shared constant,
   not logic, keeps the boundary thin.
5. **Modal context rides `custom_id`, the platform's private_metadata.**
   Discord modals have no metadata field; the 100-char `custom_id` carries
   `devspace-secrets:<channel>:<thread>` / `devspace-repo-picker:<channel>`
   (two snowflakes ≈ 40 chars — comfortable headroom). Same encode/decode
   codec the binding already uses; malformed ids are dropped, never thrown.
6. **Secret semantics are byte-for-byte the Slack modal's.** One
   `secret.submitted` per filled field, the contract's name whitelist
   unchanged, values never echoed (the orchestrator's register-before-store
   invariant already covers Discord because the event path is shared). The
   only platform difference is text-input-only fields — Discord modals have
   no select menus, which the repo picker doesn't need anyway.
7. **`/sessions` is gateway UI, not a new orchestrator surface.** The adapter
   formats `listSessions` results (injected exactly like Slack's App Home
   source — split mode rides `GET /sessions`, demo mode the in-process read)
   into one ephemeral-style reply. No new contract, no new endpoint.

## Workstreams

### A. Preview-proxy WebSocket upgrade

- `preview-proxy.ts`: `server.on('upgrade')` → parse/match (404-and-destroy
  before any dial on a miss), `http.request` upstream with the original
  headers (Host rewritten, `connection: upgrade` preserved); on upstream
  `upgrade` reconstruct the 101 head from `rawHeaders`, flush both `head`
  buffers, pipe both directions, destroy both on either error/close; on
  upstream `response` serialize status/headers/body back and end.
- Socket accounting: `socketsByEnv` map; `revokeEnv` destroys live upgraded
  sockets after dropping routes; `stop()` destroys any survivors so the
  server can close.
- Tests (loopback, CI-safe, same discipline as the M6 suite): a real upstream
  `http` server with an `upgrade` handler that completes the handshake and
  echoes frames — assert bidirectional bytes through the proxy; unknown token
  → 404 with zero upstream dials; upstream handshake rejection (non-101)
  forwarded verbatim; `revokeEnv` severs an ESTABLISHED upgraded connection;
  plain HTTP requests still route unchanged.

### B. Discord modal parity

- `discord/modals.ts` (pure, the blocks.ts parallel): Discord modal JSON
  builders `secretsModal(ref)` / `repoPickerModal(channelId)` (action rows of
  type-4 text inputs, the same three optional secret fields / repo+ref
  fields), custom_id codec (`encodeModalId`/`decodeModalId`), and total
  submission parsers `parseSecretsSubmission` / `parseRepoPickerSubmission`
  over the flat `fields` record.
- Transport seam: `DiscordSlashEvent`/`DiscordButtonEvent` gain
  `interactionId`; new `DiscordModalSubmitEvent { customId, userId, fields }`
  - `modalSubmit` handler; transport gains `openModal(interactionId, modal)`.
- Adapter: `set-secrets` button → `openModal(secretsModal)` (replacing the
  M6 "Slack-only" hint); bare `/devspace` → `openModal(repoPickerModal)`;
  `modalSubmit` routes by custom_id prefix — secrets → binding lookup + one
  `secret.submitted` per filled field; repo-picker → root a session thread
  exactly like the arg path.
- Glue (`discord/transport.ts`): pending-interaction map (entries dropped
  after use or 3 minutes); `ModalSubmit` interactions ack ephemerally and
  surface `{ customId, fields }`; button defer honors Decision 4.
- Tests: fake-transport coverage of both modal opens (including
  bare-vs-arg `/devspace`), both submissions (filled/empty/malformed-id
  cases), and that dismissal-shaped flows create nothing.

### C. Discord session list

- `discord/messages.ts`: pure `sessionListBody(sessions)` (2000-char cap,
  state/repo/PR per line, empty-state hint) over the shared `HomeSession`
  shape.
- Seam: `DiscordSlashEvent` gains `command: 'devspace' | 'sessions'`;
  transport gains `replyEphemeral(interactionId, body)`; glue registers the
  second slash command.
- Adapter option `listSessions` (same injected read as Slack); the handler
  formats and replies ephemerally — nothing is posted to the channel.
- chat-gateway-svc: `buildAdapter` passes `listSessions` to BOTH adapters
  (it already builds the source for both modes; only Slack consumed it).
- Tests: `/sessions` renders the injected sessions ephemerally; empty state;
  the source is not consulted for `/devspace`.

### D. Docs closeout

- roadmap: M7 section landed; M8+ seeded (multi-host scheduling, NATS bus,
  mTLS — the roadmap caveats that kept them out of M7 restated).
- chat-platform-ui-parity.md: Discord column ✓ for modals + session list;
  구현 현황 updated to M7.
- README status paragraph; preview-proxy header comment loses its "WS out of
  scope" caveat.

## Testing strategy

- **Unit (no Docker/DB/network, `pnpm -r test` + CI):** modal builders +
  custom_id codec + submission parsers, session-list body, adapter modal /
  sessions flows over the fake transport, upgrade-path parse cases.
- **Loopback integration (in `test`, CI-safe):** the WS upgrade itself — a
  real upstream server, a raw-socket client through the started proxy,
  bidirectional bytes, rejection forwarding, revoke-severs-live-socket. Same
  pattern the M5 egress and M6 preview suites proved out.
- **Live-Docker itest:** unchanged M6 preview itest keeps covering the
  container path; WS adds no container-specific behavior (the upstream is
  reached identically), so no new live matrix.
- **Not tested live:** discord.js against Discord (the transport seam is the
  boundary — m6-plan Decision 7; the modal/ephemeral glue joins the same
  documented-untested list).

## Risks / notes

- **Spliced sockets are unbudgeted long-lived connections.** A WS preview
  holds a TCP pair per client until either end closes or the env dies.
  Acceptable at current scale (previews are owner-only capability URLs);
  per-env connection caps belong to the multi-host/capacity milestone where
  resource accounting lives.
- **The 3s interaction budget is real.** Modal opens happen before any
  orchestrator round-trip (pure UI, Decision 3), so the only latency is
  Discord's own. Non-modal buttons keep the M6 defer-first ack.
- **`custom_id` length**: two Discord snowflakes + prefix ≈ 60 chars against
  the 100-char cap. The codec asserts the bound so a future id-shape change
  fails loudly in tests, not silently in production.
- **Half-open splices**: either side's `close`/`error` destroys both sockets
  — no dangling upstream connections into a torn-down container's network.
