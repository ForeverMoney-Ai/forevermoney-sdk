# Testing and production canary

The default SDK suite is offline and deterministic:

```bash
npm run verify
npm run pack:dry-run
```

`npm audit --omit=dev` must be clean before release. Review the full development
dependency audit separately and fix supported updates instead of hiding
advisories with package overrides.

## Production forks

Fork tests start local Anvil nodes from the real Base and Subtensor chains.
They use the SDK's production addresses and selectors unchanged; there is no
fork manifest.

```bash
BASE_RPC_URL=https://... \
SUBTENSOR_RPC_URL=https://... \
npm run test:fork
```

The suite verifies both chain IDs, deployed bytecode, the configured CCIP lane,
live contract quotes, and SDK transaction preparation. RPC URLs may contain
provider credentials, so keep them in a local untracked environment file or a
secret manager rather than shell history or CI logs.

## Real-key canary

Only run a production canary after the offline, package, consuming-application,
and fork suites pass. Use a newly generated wallet funded with no more than the
amount required for one minimum-size transfer and fees. Never use a founder,
treasury, deployer, keeper, or user wallet.

The canary script is intentionally dry-run unless the exact broadcast phrase is
present. It refuses CI, bridge amounts above `0.001 TAO`, or source wallets with
more than `0.05` native units.

Read the key without putting it in shell history, then run the dry run:

```bash
read -r -s FOREVERMONEY_CANARY_PRIVATE_KEY
export FOREVERMONEY_CANARY_PRIVATE_KEY

FOREVERMONEY_CANARY_SOURCE=base \
FOREVERMONEY_CANARY_DESTINATION=5... \
FOREVERMONEY_CANARY_AMOUNT_TAO=0.001 \
BASE_RPC_URL=https://... \
SUBTENSOR_RPC_URL=https://... \
npm run canary
```

Review the printed sender, plan hash, contracts, calldata, value, and approval.
To broadcast the reviewed plan, rerun with:

```bash
FOREVERMONEY_LIVE_CANARY_BROADCAST=I_ACKNOWLEDGE_THIS_SENDS_REAL_FUNDS
```

The private key is read only from the process environment and is never printed.
Clear it from the shell immediately after the run with
`unset FOREVERMONEY_CANARY_PRIVATE_KEY`. Record transaction hashes and verify
the received amount and any residual approval before declaring the canary
successful. The script itself verifies source confirmation, resolves the
canonical CCIP message ID, and polls destination delivery for up to 30 minutes.

The canary uses viem and preserves the dedicated-wallet, amount, balance, and
explicit-broadcast guards. Base-to-Subtensor canaries request **staked** delivery
because the 0.001 TAO canary cap is below the 0.01 TAO minimum for liquid delivery.
