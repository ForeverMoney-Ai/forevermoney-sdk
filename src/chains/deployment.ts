import { getAddress } from 'viem'

export const BASE_CHAIN_ID = 8453
export const ROBINHOOD_CHAIN_ID = 4663
export const SUBTENSOR_CHAIN_ID = 964
export const BASE_CCIP_SELECTOR = 15_971_525_489_660_198_786n
export const ROBINHOOD_CCIP_SELECTOR = 6_180_753_054_346_818_345n
export const SUBTENSOR_CCIP_SELECTOR = 2_135_107_236_357_186_872n
export const RAO_PER_TAO = 1_000_000_000n
export const EVM_WEI_PER_RAO = 1_000_000_000n
export const SN78_NETUID = 78n
export const SN10_NETUID = 10n
export const SN80_NETUID = 80n
export const FOREVERMONEY_DEPLOYMENT_VERSION = '1.6.0' as const

export const foreverMoneyDeployment = Object.freeze({
    version: FOREVERMONEY_DEPLOYMENT_VERSION,
    base: Object.freeze({
        key: 'base',
        name: 'Base',
        chainId: BASE_CHAIN_ID,
        ccipSelector: BASE_CCIP_SELECTOR,
        contracts: Object.freeze({
            gateway: getAddress('0x1da2415229b614C787e145D1D7346eb496319C52'),
            // Retired gateways, oldest first; kept only to track transfers sent
            // through them.
            legacyGateways: [
                getAddress('0x5EF3d7D19e4b233a1A169DA0d5CB02ec6b160a2C'),
            ] as readonly `0x${string}`[],
            wrappedTao: getAddress(
                '0xf3081494b87e8d5fb7960f066e931d1d0e6e3d67'
            ),
            wrappedSn78: getAddress(
                '0x6e2feEE56bc5F0Db2104Ab1dac2cf1Fb0334eb49'
            ),
            wrappedSn10: getAddress(
                '0xDdDE5965D49e69b6362BD8743e139a45dBFEb7b3'
            ),
            wrappedSn80: getAddress(
                '0x6f63d869011f95274498023b4abfc00b30c34378'
            ),
            ccipRouter: getAddress(
                '0x881e3A65B4d4a04dD529061dd0071cf975F58bCD'
            ),
            ccipOffRampFromSubtensor: getAddress(
                '0xf09AFe78d3c7d359b334d7cB88995751F7eC5E13'
            ),
            vaultFactory: getAddress(
                '0x9b7F3c7aa335D8BF9f91741E541820466735F868'
            ),
            vaultManagerImplementation: getAddress(
                '0x235Ad8654fe3a1619a9892eBCaD9361F416168da'
            ),
            batchLiquidityManagerQuery: getAddress(
                '0xd117176C5E6809b68500995F59589A8c081565A5'
            ),
            weth: getAddress('0x4200000000000000000000000000000000000006'),
        }),
        deploymentBlock: 50_098_800,
    }),
    robinhood: Object.freeze({
        key: 'robinhood',
        name: 'Robinhood',
        chainId: ROBINHOOD_CHAIN_ID,
        ccipSelector: ROBINHOOD_CCIP_SELECTOR,
        contracts: Object.freeze({
            gateway: getAddress('0xf27fdA637131E25B2A1b4865ED9597d881980c7E'),
            legacyGateways: [
                getAddress('0x53Dcc4FE04193e489BE537F722F65317DB1E65d8'),
            ] as readonly `0x${string}`[],
            wrappedTao: getAddress(
                '0xf3081494B87e8D5fb7960f066E931D1D0e6E3d67'
            ),
            wrappedSn78: getAddress(
                '0x6e2feEE56bc5F0Db2104Ab1dac2cf1Fb0334eb49'
            ),
            wrappedSn10: getAddress(
                '0xDdDE5965D49e69b6362BD8743e139a45dBFEb7b3'
            ),
            wrappedSn80: getAddress(
                '0x6f63d869011f95274498023b4abfc00b30c34378'
            ),
            ccipRouter: getAddress(
                '0x06fC836cf9839B1cd891C440A0a45242DA6Ae1c9'
            ),
            ccipOffRampFromSubtensor: getAddress(
                '0xcDca5D374e46A6DDDab50bD2D9acB8c796eC35C3'
            ),
        }),
    }),
    subtensor: Object.freeze({
        chainId: SUBTENSOR_CHAIN_ID,
        ccipSelector: SUBTENSOR_CCIP_SELECTOR,
        contracts: Object.freeze({
            // V5.1 AlphaGateway: multi-validator staked input (tao-bridge 485c898).
            gateway: getAddress('0xd5Fa238aa4177f6c1341491969d9cBeec94EEd69'),
            // V4 and V5 hubs. The spokes still deliver to the V5 hub (their hub
            // pointer is immutable), so it stays here for delivery tracking.
            legacyGateways: [
                getAddress('0x998f20Fea90bF7792774dECc7f994716442B1705'),
                getAddress('0xcd0C6d98D0A126B1c113d15b4c28F38321437787'),
            ] as readonly `0x${string}`[],
            alphaVault: getAddress(
                '0x11837459896D96F821a8D88eC93a3C8D152033D4'
            ),
            wrappedTao: getAddress(
                '0xC5b6C1632d34901239396F5E1BDe54B342900256'
            ),
            wrappedSn78: getAddress(
                '0xF2a747b004fACa8EAB646948117499E25CB8641d'
            ),
            wrappedSn10: getAddress(
                '0xcd0836D1ecE4AEDf5B39f2792e0790BBE79449b3'
            ),
            wrappedSn80: getAddress(
                '0xfD628dE75EF96f0A5C59659159C6cA81E0DC2222'
            ),
            ccipRouter: getAddress(
                '0xD941fBEcD2b971d0F54b4C34286C95faB52B60B8'
            ),
            ccipOffRampFromBase: getAddress(
                '0x51a6150400ed9F0Ae240F5D1b15E3b45Fc4339C7'
            ),
            ccipOffRampFromRobinhood: getAddress(
                '0x51a6150400ed9F0Ae240F5D1b15E3b45Fc4339C7'
            ),
            stakingPrecompile: getAddress(
                '0x0000000000000000000000000000000000000805'
            ),
        }),
    }),
})

export type ForeverMoneyDeployment = typeof foreverMoneyDeployment
export type ForeverMoneyEvmChain = 'base' | 'robinhood'

export function getForeverMoneyEvmDeployment(
    chain: ForeverMoneyEvmChain = 'base'
): ForeverMoneyDeployment['base'] | ForeverMoneyDeployment['robinhood'] {
    return foreverMoneyDeployment[chain]
}
