# `@forevermoney/sdk`

Typed, non-custodial transaction preparation for the ForeverMoney bridge and
vault contracts.

The SDK owns the canonical production deployment: chain IDs, CCIP selectors,
contract addresses, ABIs, and protocol-specific amount conversion. An
integrator supplies only RPC transports and user input. The SDK never accepts a
private key, signs a transaction, or broadcasts a transaction. Network fees are
charged separately. Subtensor-to-EVM requests accept an explicit minimum output
to account for native staking rounding; exact output remains the default.
SDK 0.5.2 also provides opt-in stake rounding preparation (see below).

Bridge plans use the current gateways in `contracts.gateway`. Retired gateways
remain under `contracts.legacyGateways` only so receipts and deliveries of
bridges sent through them can still be tracked. A spoke gateway's Subtensor
hub pointer is immutable, so after a hub-only redeploy EVM-to-Subtensor
deliveries still arrive through the previous hub; the SDK watches every known
hub, so tracking and recovery detection are unaffected. Plans call the zero-fee V5
entrypoints unless a `partnerFee` is passed (see "Charge a partner fee").

## Install

```bash
npm install @forevermoney/sdk
```

Node.js 22 or newer is required. Both ESM and CommonJS builds are published.

The SDK uses viem for EVM reads, ABI encoding, and receipt decoding, and
PAPI's `@polkadot-api/substrate-bindings` for SS58 and EVM mirror addresses.
It does not require ethers or the legacy `@polkadot/*` packages. The full PAPI
RPC client is unnecessary because the bridge executes on Subtensor EVM;
this SDK does not sign native Substrate extrinsics.

## Create a client

```ts
import { createForeverMoneyClient, http } from '@forevermoney/sdk'

const foreverMoney = createForeverMoneyClient({
    transports: {
        base: http(process.env.BASE_RPC_URL),
        robinhood: http(process.env.ROBINHOOD_RPC_URL),
        subtensor: http(process.env.SUBTENSOR_RPC_URL),
    },
})

await foreverMoney.verifyConnections()
```

`verifyConnections()` checks that the transports report Base (`8453`),
Robinhood (`4663`) when configured, and Subtensor EVM (`964`). A mismatched RPC
fails with `CHAIN_MISMATCH`; the SDK does not try another endpoint or silently
change networks.

Independent chain-scoped EIP-1193 transports can also be supplied directly. A
single injected wallet provider usually follows the wallet's currently selected
chain, so use it for signing rather than pretending it is two simultaneous RPC
connections:

```ts
const foreverMoney = createForeverMoneyClient({
    transports: {
        base: baseReadTransport,
        subtensor: subtensorReadTransport,
    },
})
```

Existing viem public clients can supply their `.transport` directly. See
[`examples/viem.ts`](./examples/viem.ts) for transport reuse and execution with a
viem wallet client, or [`examples/talisman.ts`](./examples/talisman.ts) for
raw EIP-1193 account and transaction handling.

## Prepare a bridge

Amounts use `bigint` base units. `parseTaoAmount()` accepts at most nine decimal
places because the Subtensor protocol operates in whole RAO.

```ts
import { parseTaoAmount } from '@forevermoney/sdk'

const prepared = await foreverMoney.bridge.prepareEvmToSubtensor({
    evmChain: 'base',
    sender: '0x...',
    amountWei: parseTaoAmount('1.25'),
    destination: '5...',
    delivery: 'liquid',
})
```

Use `evmChain: 'robinhood'` with a configured Robinhood transport for the
canonical Robinhood lane. `prepareBaseToSubtensor` remains available as the
Base-specific convenience method.

The result contains the exact quoted CCIP fee, the buffered transaction value,
and an ordered transaction plan. The plan includes an exact-amount ERC-20 or
staking-precompile approval only when the current allowance is insufficient.
Liquid Base-to-Subtensor delivery requires at least `0.01 TAO` because the
destination vault must unstake the bridged position. The SDK rejects smaller
liquid deliveries with `AMOUNT_BELOW_MINIMUM` before quoting or planning them;
staked delivery does not use this liquid-unstaking minimum.
EVM-to-Subtensor plans quote and encode an explicit 3,500,000 destination gas
limit so the variable-cost Subtensor exit path can auto-execute through CCIP.
The policy is exported as `EVM_TO_SUBTENSOR_DESTINATION_GAS_LIMIT`. Pass a
positive bigint as `destinationGasLimit` to override it for one preparation or
plan; the SDK uses that value for both the fee quote and transaction calldata.
The network-fee buffer is 2% and the estimated-gas buffer is 50%; both policies
are exported as bigint basis-point constants and covered by property tests.

For Subtensor to Base:

```ts
const prepared = await foreverMoney.bridge.prepareSubtensorToEvm({
    evmChain: 'base',
    sender: '0x...',
    recipient: '0x...',
    amountWei: parseTaoAmount('1.25'),
    source: 'liquid',
})
```

`prepareSubtensorToBase` remains available as the Base-specific convenience
method.

For a staked source, pass the stake `netuid`. The SDK reads the staking
precompile allowance and expresses the approval in RAO.
For a liquid Subtensor source, the SDK requires at least 0.002 TAO because the
gateway stakes it before bridging. This minimum does not apply to an existing
staked source.

The bridge does not deduct its fee from the destination amount. For both
directions, the SDK encodes the bridge amount itself as the contract's minimum
output; callers cannot weaken that invariant.

## Bridge SN80 on Base

Pass `asset: 'sn80'` to bridge Base SN80 to a Finney subnet-80 staked position,
or bridge existing subnet-80 stake back to Base SN80. The default asset is `tao`,
so existing TAO integrations keep their behavior. SN80 is supported on the Base
lane with staked input/delivery; liquid TAO conversion and the Robinhood SN80
lane are not supported by these methods.

```ts
const toFinney = await foreverMoney.bridge.prepareBaseToSubtensor({
    asset: 'sn80',
    sender: '0x...',
    amountWei: 100n * 10n ** 18n, // 100 SN80
    destination: '5...',
    delivery: 'staked',
})

const toBase = await foreverMoney.bridge.prepareSubtensorToBase({
    asset: 'sn80',
    sender: '0x...',
    recipient: '0x...',
    amountWei: 100n * 10n ** 18n, // 100 staked SN80
    source: 'staked',
})
```

SN80 uses 18-decimal token units, restricted to whole alpha RAO (multiples of
`10^9` token wei). The Finney approval uses the staking precompile and netuid
`80` automatically; an explicitly different `netuid` is rejected. Base approves
the SN80 ERC-20 to the V5 gateway. Both directions bridge the full SN80 amount
with a 0% partner fee and charge network fees separately. The liquid TAO
minimums do not apply to SN80 stake. SN80 delivery is always staked
(`wantLiquid: false`), so the gateway never converts the stake into TAO.

Bridging staked SN80 from Finney pulls the caller's alpha from the vault's own
validator hotkey on netuid 80 (`AlphaVault.positionOf(SN80)`). Stake held with
any other SN80 validator cannot be bridged until it is moved to that hotkey.

Canonical SN80 token addresses are exported as `contracts.wrappedSn80`:

- Base: `0x6F63d869011f95274498023b4ABFC00b30c34378`
- Finney: `0xfD628dE75EF96f0A5C59659159C6cA81E0DC2222`

The Base address `0x2292233d308188fcb3775f63a20f31dff6db02d9` is the SN80/TAO
liquidity pool; bridge calls use the token addresses above.

## Bridge stake held with several validators

Staked alpha on Finney is keyed by validator hotkey, and a bridge can only pull
from the positions you name. Pass `stakePulls` to draw from more than one
validator; the gateway re-delegates each pull to the token's canonical
validator and deposits the total, so stake with any validator can be bridged.

```ts
const prepared = await foreverMoney.bridge.prepareSubtensorToBase({
    sender: '0x...',
    recipient: '0x...',
    amountWei: 140n * 10n ** 18n,
    source: 'staked',
    netuid: 0n,
    stakePulls: [
        { hotkey: '0x…validatorA', amountRao: 100_000_000_000n },
        { hotkey: '0x…validatorB', amountRao: 40_000_000_000n },
    ],
})
```

Rules the SDK checks before building a plan: 1 to `MAX_STAKE_PULLS` (16)
entries, unique non-zero hotkeys, positive amounts, and a sum equal to the
bridged amount in RAO. One staking approval on the netuid covers every pull.
Nothing on-chain enforces the runtime's minimum stake on what you leave behind
(`minStakeRequired()`, 0.02 TAO-equivalent), so size each pull to either drain
the position or leave at least that much. With a partner fee the cut is charged
on top and spread across the pulls in proportion to their amounts, so each
position needs headroom for its share.

## Charge a partner fee

Integrators can take a fee on each bridge by passing `partnerFee` to any bridge
builder or preparation method. The fee is charged **on top** of `amountWei` and
paid to `recipient` on the source chain in the same transaction; the full
`amountWei` always crosses, and `minTaoOut` / `minTokenOut` still bound it.

```ts
const prepared = await foreverMoney.bridge.prepareBaseToSubtensor({
    sender: '0x...',
    amountWei: 100n * 10n ** 18n,
    destination: '5...',
    delivery: 'staked',
    partnerFee: { recipient: '0xYourTreasury', bps: 100 }, // 1%
})
prepared.partnerFeeWei // 1 TAO: what the sender pays on top
```

What the sender supplies extra, per direction:

| Direction                    | Extra input                                       | Plan effect                                             |
| ---------------------------- | ------------------------------------------------- | ------------------------------------------------------- |
| Base / Robinhood → Subtensor | `amount × bps / 10 000` of the token              | approval covers `amount + cut`; `bridgeToFinneyWithFee` |
| Subtensor → EVM, liquid      | `partnerFeeTaoTopUp(amount, bps)` TAO (whole RAO) | added to the transaction value; `bridgeOutWithFee`      |
| Subtensor → EVM, staked      | `alphaRao × bps / 10 000` of the caller's alpha   | staking approval covers it; `bridgeOutWithFee`          |

`bps` must be an integer from 0 to 10 000; `0` or omitting `partnerFee` uses the
original zero-fee entrypoints, so existing plans are unchanged. Each gateway caps
the fee at `maxIntegratorFeeBps` (1% at deployment, governance can raise it to
10%); `prepare*` reads the cap and throws `INVALID_PARTNER_FEE` when `bps`
exceeds it. The recipient must not be the zero address or the gateway.

## Track bridge delivery

Capture the destination block immediately before broadcasting the source bridge
transaction. Once the wallet broadcasts, resolve the source confirmation and
canonical message ID, then poll the destination status:

```ts
const checkpoint =
    await foreverMoney.bridge.getDeliveryCheckpoint('base-to-subtensor')
const source = await foreverMoney.bridge.getSourceStatus({
    direction: 'base-to-subtensor',
    transactionHash,
})
if (source.status !== 'confirmed') return source.status

const status = await foreverMoney.bridge.getDeliveryStatus({
    direction: checkpoint.direction,
    messageId: source.messageId,
    fromBlock: checkpoint.fromBlock,
})
```

The statuses are `waiting`, `success`, `failure`, and `recovery`. Recovery is
specific to Base-to-Subtensor: CCIP executed, but the canonical AlphaGateway
emitted `Claimable`, so the application must present the appropriate claim
flow. Delivery queries are restricted to the deployment's authorized CCIP
off-ramp, so another contract cannot imitate the execution event. Both
lifecycle reads verify the destination RPC chain before querying.
`getSourceStatus()` similarly verifies the source chain and returns `pending`,
`failed`, or a confirmed canonical gateway message ID. If the caller already
has a receipt, `bridgeMessageIdFromReceipt()` performs the same canonical event
check without another RPC request.

## Execute a plan

Every plan identifies its schema version, embedded deployment version, action,
ordered steps, and deterministic hash. Transaction values and gas limits are
decimal strings so the complete plan is JSON-safe. Show the action, destination
contract, value, and approval to the user before requesting signatures. Submit
the steps in order and wait for each successful receipt before continuing.

```ts
import { toEip1193Transaction } from '@forevermoney/sdk'

for (const step of prepared.plan.steps) {
    const hash = await walletProvider.request({
        method: 'eth_sendTransaction',
        params: [toEip1193Transaction(step.transaction)],
    })
    await waitForReceipt(hash)
}
```

Viem consumers can pass `toViemTransaction(step.transaction)` to
`walletClient.sendTransaction()`. The adapter supplies the canonical `chain`
for the plan, so viem rejects a wallet connected to another network. Do not
override that chain or disable viem's chain assertion. The adapter maps
`from` to `account`, `gasLimit` to `gas`, and decimal quantities to `bigint`.
Confirm the signing account and chain before every signature. Local-account
signers must pass their account object explicitly, after checking that its
address matches the plan's sender.

`toEthersTransaction()` remains as a dependency-free compatibility adapter for
existing consumers. All adapters validate decimal quantities before conversion.
The exported lower-level tracking functions accept either a viem `PublicClient`
or an existing ethers-style provider with `send(method, params)`. Legacy
providers are adapted through their own transport without an ethers dependency.
The `createForeverMoneyClient()` transport interface is unchanged. Exported
`foreverMoneyAbis` remain human-readable; use viem's `parseAbi()` when calling
contracts directly.

If a plan contains an approval, its later transaction intentionally has no gas
limit: that transaction cannot be simulated against pre-approval state. The
wallet should estimate it after the approval confirms.

## Vaults

The client reads allowances for vault creation and deposits:

```ts
const plan = await foreverMoney.vaults.prepareCreate({
    owner: '0x...',
    akAddress: '0x...',
    poolManager: '0x...',
    poolAddress: '0x...',
    positionManagerImplementation: '0x...',
    stashTokens: [{ token: '0x...', amount: 1_000_000n }],
})
```

Pure builders are exported for deterministic or already-indexed workflows:

- `buildCreateVaultPlan`
- `buildDepositVaultPlan`
- `buildWithdrawVaultPlan`
- `buildClaimVaultFeesPlan`
- `buildSetVaultStakingPlan`

WETH stash entries are handled as native ETH exactly as the deployed vault
contracts expect: creation adds their amount to `msg.value`, while top-up calls
use `address(0)` plus `msg.value`. Other tokens use exact-amount approvals.

Vault manager and pool addresses are dynamic protocol data, not deployment
constants. Source them from a canonical factory receipt or the ForeverMoney
indexer and present them to the user. The SDK validates their address shape and
encodes the call; it cannot prove that an arbitrary caller-supplied manager or
pool belongs to ForeverMoney.

After confirmation, `vaultManagerFromCreationReceipt(receipt)` resolves the new
manager only from the canonical factory event. For bridge receipts,
`bridgeMessageIdFromReceipt(direction, receipt)` resolves the CCIP message ID
only from the canonical source gateway. Both return `null` when the expected
event is absent; do not infer success or submit a duplicate transaction.

## Public API boundaries

- `createForeverMoneyClient()` owns state-dependent reads and preparation.
- `getDeliveryCheckpoint()` and `getDeliveryStatus()` own chain-verified CCIP
  lifecycle reads.
- `getSourceStatus()` owns source confirmation and canonical message-ID
  extraction from a transaction hash.
- Pure `build*Plan()` functions require explicit allowance and fee state and
  do not read a chain.
- `toEip1193Transaction()` and `toEthersTransaction()` only convert an already
  prepared transaction; they never submit it.
- `foreverMoneyDeployment` and `foreverMoneyAbis` are immutable production
  metadata for Base, Robinhood, and Subtensor. There is no public manifest,
  environment, address, selector, or arbitrary-chain override.
- The root package export is the supported API. Internal source modules are
  not package subpaths and should not be imported by partners.

## Production forks

A Base or Subtensor mainnet fork reports the original production chain ID and
contains the production contracts at their real addresses. Point `http()` at
the local fork RPC. Do not create a custom manifest or replace contract
addresses.

```ts
const forkClient = createForeverMoneyClient({
    transports: {
        base: http('http://127.0.0.1:8545'),
        subtensor: http('http://127.0.0.1:9545'),
    },
})
```

## Errors and security

SDK failures are `ForeverMoneyError` instances with a stable `code`. Errors are
fail-closed: invalid addresses, fractional RAO, missing allowance state,
negative values, unsupported RPC schemes, and wrong chain IDs are rejected.

- Never pass private keys to an application backend or MCP server.
- The built-in HTTP transport rejects plaintext remote RPC endpoints. Plain HTTP
  is accepted only for `localhost`, `127.0.0.1`, and `::1` development forks.
- Re-quote shortly before signing; CCIP fees and on-chain state change.
- Treat a transaction-plan hash as an integrity identifier, not authorization.
- Review approvals and wait for their receipts before submitting dependent
  transactions.
- Confirm the wallet account and chain immediately before every signature.
- Treat a confirmed transaction with an unresolved canonical event as a
  support/recovery case; never blindly resubmit it.
- Use a dedicated, low-balance wallet for production canaries.

The embedded deployment is exported as `foreverMoneyDeployment` for display and
verification. It is intentionally not replaceable through the public client
API.

## Development

Use Node.js 22 or newer. The repository is the standalone source for the npm
package; it does not depend on the ForeverMoney website repository.

Source code is grouped by protocol responsibility while `src/index.ts` remains
the only supported package boundary:

```text
src/
├── abis/          Contract interfaces owned by the SDK
├── bridge/        Bridge plans, receipt parsing, and delivery tracking
├── chains/        Canonical production deployment metadata
├── core/          Shared validation, transports, plans, and transaction types
├── integration/   Production-fork integration tests
├── vaults/        Vault plans and receipt parsing
├── client.ts      State-aware SDK client
└── index.ts       Reviewed public exports
```

```bash
npm install
npm run verify
npm run pack:dry-run
```

`verify` runs the offline tests, strict type checks, example checks, ESM and
CommonJS builds, and package smoke test. Production-fork and guarded real-key
testing are documented in [`docs/testing.md`](./docs/testing.md).

Security reports should follow [`SECURITY.md`](./SECURITY.md). Maintainer release
steps are in [`docs/releasing.md`](./docs/releasing.md).

### Minimum bridge output

Subtensor-to-EVM builders and preparation methods accept optional `minAmountOutWei` (destination token units, 18 decimals, after partner fees). It must be positive and no greater than `amountWei`; omission preserves the exact-output default. Choose the minimum explicitly to cover your acceptable slippage or native staking rounding dust. The SDK uses the same value for gas estimation and final transaction calldata. For example, `minAmountOutWei: amountWei - 4n * EVM_WEI_PER_RAO` allows four native RAO of dust when the amount exceeds that budget. This does not change the input amount or approval amount.

### Optional stake rounding adjustment

`client.bridge.prepareSubtensorToEvm` (and `prepareSubtensorToBase`) accepts
`stakeRounding: { enabled: true, positions, minStakeRao }`. Omit it, pass `false`,
or set `enabled: false` to preserve the exact requested input with no search.
Synchronous `build*Plan` methods never simulate or adjust amounts.

```ts
import { stakedMinimumOutput } from '@forevermoney/sdk'

const prepared = await client.bridge.prepareSubtensorToEvm({
    evmChain: 'base',
    asset: 'sn80',
    source: 'staked',
    sender,
    recipient,
    amountWei,
    stakePulls,
    minAmountOutWei: stakedMinimumOutput(amountWei, stakePulls.length),
    stakeRounding: {
        enabled: true,
        positions, // [{ hotkey, stakeRao }], freshly read source balances
        minStakeRao: 0n, // caller's minimum positive remainder per validator
    },
})
```

Only `StrandedStake(bytes32,uint256)` triggers adjustment. The SDK reduces the
named validator's pull by one alpha base unit per attempt, for at most eight
reductions, re-quotes fees and simulates the exact candidate. It keeps the
**original absolute minimum output**, checks balances and remaining stake,
including the partner fee apportioned on top, and propagates unrelated errors.
The search stops if no valid candidate fits that budget. `stakedMinimumOutput`
provides an explicit dust tolerance of two base units per source plus two for
the deposit; tiny inputs retain an exact minimum. It is not a guarantee of
successful execution.

When enabled, `prepared.stakeRounding` reports `requestedAmountWei`, the actual
`amountWei`, `minAmountOutWei`, `pulls`, and `simulationComplete`. Display the
returned amount and use **the returned plan**, rather than rebuilding from the
original request. If approval is required, `simulationComplete` is false:
confirm approval, refresh balances, and prepare again before sending the bridge.
Revalidate before signing; if the amount changes again, show it for review.
Keep the original `minAmountOutWei` when re-preparing an adjusted amount so
successive attempts cannot gradually lower output protection. Never automatically
retry a broadcast transaction.

For custom ethers/wallet quote flows, the SDK also exports
`estimateRoundedStake({ amountWei, minAmountOutWei, pulls, positions,
minStakeRao, adjustRounding, partnerFeeBps, quoteAndEstimate, isActive })`.
`adjustRounding` defaults to true **for this explicitly invoked helper**; false
performs one exact estimate. Its callback must quote and estimate the supplied
candidate and minimum, and must never sign or broadcast. An optional `isActive`
callback stops obsolete work between requests. `strandedStakeSource(error)`
decodes nested RPC/ethers/viem errors for UI error messages.
