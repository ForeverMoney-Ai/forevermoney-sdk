import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const esm = await import('../dist/index.js')
const commonJsPath = fileURLToPath(
    new URL('../dist/index.cjs', import.meta.url)
)

const expectedExports = [
    'BASE_CCIP_SELECTOR',
    'BASE_CHAIN_ID',
    'BASIS_POINTS',
    'EVM_WEI_PER_RAO',
    'FOREVERMONEY_DEPLOYMENT_VERSION',
    'ForeverMoneyError',
    'GAS_LIMIT_BUFFER_BPS',
    'MAX_PARTNER_FEE_BPS',
    'MAX_STAKE_PULLS',
    'MIN_LIQUID_BASE_TO_SUBTENSOR_WEI',
    'MIN_LIQUID_EVM_TO_SUBTENSOR_WEI',
    'MIN_LIQUID_SUBTENSOR_TO_EVM_WEI',
    'NETWORK_FEE_BUFFER_BPS',
    'RAO_PER_TAO',
    'ROBINHOOD_CCIP_SELECTOR',
    'ROBINHOOD_CHAIN_ID',
    'SN80_NETUID',
    'SUBTENSOR_CCIP_SELECTOR',
    'SUBTENSOR_CHAIN_ID',
    'assertWholeRao',
    'buildBaseToSubtensorPlan',
    'buildEvmToSubtensorPlan',
    'bridgeMessageIdFromReceipt',
    'buildClaimVaultFeesPlan',
    'buildCreateVaultPlan',
    'buildDepositVaultPlan',
    'buildSetVaultStakingPlan',
    'buildSubtensorToBasePlan',
    'buildSubtensorToEvmPlan',
    'buildWithdrawVaultPlan',
    'createForeverMoneyClient',
    'destinationChainId',
    'evmToMirrorSS58',
    'evmChainFromBridgeDirection',
    'estimateRoundedStake',
    'strandedStakeSource',
    'stakedMinimumOutput',
    'feeWithBuffer',
    'foreverMoneyAbis',
    'foreverMoneyDeployment',
    'formatTaoAmount',
    'gasLimitWithBuffer',
    'getBridgeSourceStatus',
    'getCcipDeliveryCheckpoint',
    'getCcipDeliveryStatus',
    'getForeverMoneyEvmDeployment',
    'http',
    'isBittensorSS58',
    'isEvmToSubtensorDirection',
    'normalizeEvmAddress',
    'normalizeSS58',
    'parseTaoAmount',
    'sourceChainId',
    'ss58ToPublicKey',
    'partnerFeeCut',
    'partnerFeeTaoTopUp',
    'toEip1193Transaction',
    'toEthersTransaction',
    'toViemTransaction',
    'vaultManagerFromCreationReceipt',
].sort()

function assertExactExports(label, actualExports) {
    const actual = [...actualExports].sort()
    if (JSON.stringify(actual) !== JSON.stringify(expectedExports)) {
        throw new Error(
            `${label} exports do not match the reviewed public API.\n` +
                `Expected: ${expectedExports.join(', ')}\n` +
                `Actual: ${actual.join(', ')}`
        )
    }
}

assertExactExports('ESM', Object.keys(esm))

const sender = '0x1111111111111111111111111111111111111111'
const input = {
    sender,
    amountWei: esm.MIN_LIQUID_BASE_TO_SUBTENSOR_WEI,
    destination: esm.evmToMirrorSS58(sender),
    delivery: 'liquid',
    allowanceWei: esm.MIN_LIQUID_BASE_TO_SUBTENSOR_WEI,
    exactNetworkFeeWei: 100n,
}
const esmPlan = esm.buildBaseToSubtensorPlan(input)
const commonJsResult = JSON.parse(
    execFileSync(
        process.execPath,
        [
            '-e',
            `const sdk = require(${JSON.stringify(commonJsPath)});
const sender = '0x1111111111111111111111111111111111111111';
const input = {
  sender,
  amountWei: sdk.MIN_LIQUID_BASE_TO_SUBTENSOR_WEI,
  destination: sdk.evmToMirrorSS58(sender),
  delivery: 'liquid',
  allowanceWei: sdk.MIN_LIQUID_BASE_TO_SUBTENSOR_WEI,
  exactNetworkFeeWei: 100n,
};
process.stdout.write(JSON.stringify({
  exports: Object.keys(sdk),
  plan: sdk.buildBaseToSubtensorPlan(input),
}));`,
        ],
        { encoding: 'utf8' }
    )
)

assertExactExports('CommonJS', commonJsResult.exports)

if (JSON.stringify(esmPlan) !== JSON.stringify(commonJsResult.plan)) {
    throw new Error('ESM and CommonJS builds produced different plans.')
}

console.log(
    `Verified the exact ${expectedExports.length}-export public API and deterministic ESM/CommonJS plan parity.`
)
