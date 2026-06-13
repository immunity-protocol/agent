# Immunity agent

The official **template agent** for the [Immunity](https://immunity-protocol.com) network — the
downloadable, SDK-based agent operators run to join the protocol. One container image, role-selected
by env. Pick a role, bring a funded Base Sepolia wallet, `docker run`.

It is built on the real [`@immunity-protocol/sdk`](../immunity-sdk) — so running the fleet doubles as
live coverage of the SDK.

## Roles

The role is selected by `AGENT_ROLE`. All three share one skeleton (SDK init → a check→decide→act
loop → heartbeat/activity reporting); the role is a swappable strategy module under `src/roles/`.

| Role | What it does |
| --- | --- |
| `publisher` | Classifies candidate threats from a feed and `publish()`es them as ADDRESS antibodies (staking the bond). Needs a registered + deposited wallet. |
| `hunter` | Watches recently-published advisory antibodies and `challenge()`s the ones it judges to be false positives — **only when confident** (accuracy is its edge: a lost challenge is slashed). |
| `corroborator` | `check()`s a sample action; when the check surfaces a hit it deems real, `corroborate()`s it to drive maturation. Needs a registered + deposited wallet. |

All roles also run a periodic `check()` against their own activity, so the fleet produces real
check/block telemetry the dashboard renders.

> Out of scope: the tier-2 demo actors (`trader`, `wolf-trader`). Those are internal scenario actors,
> not part of this public template.

## Quickstart

```sh
docker run \
  -e AGENT_ROLE=hunter \
  -e AGENT_WALLET_KEY=0xYOUR_FUNDED_BASE_SEPOLIA_KEY \
  -e AGENT_LABEL=my-hunter \
  -e IMMUNITY_API_URL=https://api.immunity-protocol.com \
  ghcr.io/immunity-protocol/agent
```

That's the download — a `docker run` one-liner. Source is here so you can read + fork it.

## Bring a funded wallet

The agent assumes a **funded Base Sepolia wallet**. Specifically:

- **All roles** need Base Sepolia ETH for gas.
- **publisher / corroborator** additionally need to be a **registered publisher** with a **USDC
  deposit** (the publish/corroborate bond is debited from the deposited balance). The agent does
  **not** auto-register or auto-deposit — that spends your funds, so it's an explicit operator step.
  Register + deposit once via the SDK:

  ```ts
  import { Immunity, BASE_SEPOLIA } from "@immunity-protocol/sdk";
  const im = new Immunity({ wallet: process.env.AGENT_WALLET_KEY, network: BASE_SEPOLIA });
  await im.start();
  await im.registerPublisher("my-publisher");   // locks the registration bond
  await im.deposit(10_000_000n);                // 10 USDC (6dp) into the operator balance
  ```

  If the wallet isn't registered/funded the agent still runs — it logs a clear remediation message
  and falls back to self-checks only (it never crashes).

> The demo's mass-funding of ~45 throwaway wallets (auto-mint USDC + deployer-funded gas) is a
> separate fleet-run concern, handled outside this template.

## Env reference

| Var | Required | Default | Notes |
| --- | --- | --- | --- |
| `AGENT_ROLE` | ✅ | — | `publisher` \| `hunter` \| `corroborator` |
| `AGENT_WALLET_KEY` | ✅ | — | Funded Base Sepolia private key (`0x` + 64 hex) |
| `AGENT_LABEL` | | `<role>-<keyprefix>` | Roster display name + publisher registration label |
| `AGENT_ID` | | `AGENT_LABEL` | Stable heartbeat upsert key |
| `BASE_SEPOLIA_RPC_URL` | | SDK preset (`sepolia.base.org`) | Your own RPC (the public default is rate-limited) |
| `IMMUNITY_API_URL` | | — | App API base for heartbeat/activity + the hunter's antibody feed. Unset = fully offline |
| `AGENT_TICK_MS` | | `30000` | Strategy tick cadence |
| `AGENT_HEARTBEAT_MS` | | `15000` | Heartbeat cadence |
| `AGENT_THREAT_FEED` | | built-in sample | (publisher/corroborator) absolute path to a JSON threat feed |
| `AGENT_HUNTER_CONFIDENCE_FLOOR` | | `40` | (hunter) only challenge advisories below this publisher-stated confidence |

A JSON threat feed is an array of:

```json
[{ "address": "0x…", "chainId": 84532, "verdict": "MALICIOUS", "confidence": 90, "severity": 80, "reason": "…", "family": "drainer" }]
```

## Heartbeat + activity contract

The agent reports liveness + activity over HTTP so the `/agents` page can show it online. The old
demo fleet wrote straight to Postgres; the template agent must not, so it POSTs JSON. **There is no
inbound receiver on the app yet** — the contract below is what the `/agents`-page work should
implement (a controller that upserts the heartbeat and appends the activity row, mirroring
`demo.agent_heartbeat` / `demo.agent_activity`). When `IMMUNITY_API_URL` is unset the agent reports
nothing (offline run). Reporting is fire-and-forget: a failed POST never breaks the loop.

**`POST {IMMUNITY_API_URL}/v1/agents/heartbeat`** — every `AGENT_HEARTBEAT_MS` (default 15s), upsert on `agentId`:

```json
{
  "agentId": "my-hunter",
  "role": "hunter",
  "displayName": "my-hunter",
  "wallet": "0x38d6…E8b6",
  "ens": null,
  "version": "0.1.0",
  "sentAt": "2026-06-13T20:52:52.796Z"
}
```

**`POST {IMMUNITY_API_URL}/v1/agents/activity`** — one row per observable action (mirrors the demo `ActivityRecord` shape so the dashboard renders it unchanged):

```json
{
  "agentId": "my-hunter",
  "role": "hunter",
  "displayName": "my-hunter",
  "actionType": "challenge",
  "actionSummary": "Challenged IMM-2026-0042 (low publisher confidence 30)",
  "status": "info",
  "antibodyImmId": "IMM-2026-0042",
  "txHash": "0x…",
  "target": null,
  "family": null,
  "occurredAt": "2026-06-13T20:52:54.203Z"
}
```

`status` is one of `allow | block | novel | error | info`.

The hunter also **reads** recent advisory antibodies from the app's public API:
`GET {IMMUNITY_API_URL}/v1/antibodies?status=probation&limit=30` (an existing endpoint).

## SDK methods used

`new Immunity({ wallet, network })`, `im.start()`, `im.check(tx, context)`, `im.publish(input)`,
`im.corroborate(input)`, `im.challenge(antibodyId)`, `im.isRegistered()`, `im.balanceOf()`,
`im.registerPublisher(label)`, `im.deposit(amount)`.

## Develop

```sh
npm install        # links the sibling immunity-sdk via a file: dependency
npm run build      # tsc → dist/ (clean)
npm test           # offline smoke tests (mocked SDK/network)
npm start          # run from dist with env set
```

> While the SDK is unpublished it's a `file:../immunity-sdk` dependency, so the two repos must be
> siblings. Once the SDK ships to npm, swap the dependency for the published version.

## Build the image

The Docker build context is the **parent** directory (so the sibling SDK is in scope):

```sh
docker build -f immunity-agent/Dockerfile -t ghcr.io/immunity-protocol/agent ..
```

## Run a fleet

`docker-compose.yml` launches one of each role; scale a role with `replicas`. Each agent needs its
**own** funded wallet — set `AGENT_WALLET_KEY_PUBLISHER` / `_HUNTER` / `_CORROBORATOR` (and
optionally `IMMUNITY_API_URL`, `BASE_SEPOLIA_RPC_URL`) in a `.env` next to the compose file:

```sh
docker compose up --build
```
