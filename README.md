# `@forevermoney/sdk`

Typed, non-custodial transaction preparation for the ForeverMoney bridge and
vault contracts.

The SDK owns the canonical production deployment: chain IDs, CCIP selectors,
contract addresses, ABIs, and protocol-specific amount conversion. An
integrator supplies only RPC transports and user input. The SDK never accepts a
private key, signs a transaction, or broadcasts a transaction. Bridge principal
is transferred 1:1 and the network fee is charged separately, so the SDK fixes
the contract's minimum destination output to the bridged principal instead of
exposing configurable slippage.

Bridge plans use the V5 gateways in `contracts.gateway`. The previous gateways
remain under `contracts.legacyGateway` only so receipts and deliveries of
bridges sent through them can still be tracked. Plans call the V5 entrypoints
without a partner fee, so approvals and transaction value contain no partner cut.

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
