import { describe, expect, it } from 'vitest'
import {
    BASE_CCIP_SELECTOR,
    BASE_CHAIN_ID,
    ROBINHOOD_CCIP_SELECTOR,
    ROBINHOOD_CHAIN_ID,
    SUBTENSOR_CCIP_SELECTOR,
    SUBTENSOR_CHAIN_ID,
    SN80_NETUID,
    foreverMoneyDeployment,
} from '../index.js'

describe('canonical production deployment', () => {
    it('embeds the reviewed production chain and contract identifiers', () => {
        expect(foreverMoneyDeployment.base.chainId).toBe(BASE_CHAIN_ID)
        expect(foreverMoneyDeployment.base.ccipSelector).toBe(
            BASE_CCIP_SELECTOR
        )
        expect(foreverMoneyDeployment.subtensor.chainId).toBe(
            SUBTENSOR_CHAIN_ID
        )
        expect(foreverMoneyDeployment.subtensor.ccipSelector).toBe(
            SUBTENSOR_CCIP_SELECTOR
        )
        expect(foreverMoneyDeployment.robinhood.chainId).toBe(
            ROBINHOOD_CHAIN_ID
        )
        expect(foreverMoneyDeployment.robinhood.ccipSelector).toBe(
            ROBINHOOD_CCIP_SELECTOR
        )
        expect(foreverMoneyDeployment.base.contracts.gateway).toBe(
            '0x1da2415229b614C787e145D1D7346eb496319C52'
        )
        expect(foreverMoneyDeployment.robinhood.contracts.gateway).toBe(
            '0xf27fdA637131E25B2A1b4865ED9597d881980c7E'
        )
        expect(foreverMoneyDeployment.subtensor.contracts.gateway).toBe(
            '0xd5Fa238aa4177f6c1341491969d9cBeec94EEd69'
        )
        expect(foreverMoneyDeployment.base.contracts.legacyGateways).toEqual([
            '0x5EF3d7D19e4b233a1A169DA0d5CB02ec6b160a2C',
        ])
        expect(
            foreverMoneyDeployment.subtensor.contracts.legacyGateways
        ).toEqual([
            '0x998f20Fea90bF7792774dECc7f994716442B1705',
            '0xcd0C6d98D0A126B1c113d15b4c28F38321437787',
        ])
        expect(foreverMoneyDeployment.base.contracts.ccipRouter).toBe(
            '0x881e3A65B4d4a04dD529061dd0071cf975F58bCD'
        )
        expect(
            foreverMoneyDeployment.base.contracts.ccipOffRampFromSubtensor
        ).toBe('0xf09AFe78d3c7d359b334d7cB88995751F7eC5E13')
        expect(foreverMoneyDeployment.subtensor.contracts.ccipRouter).toBe(
            '0xD941fBEcD2b971d0F54b4C34286C95faB52B60B8'
        )
        expect(
            foreverMoneyDeployment.subtensor.contracts.ccipOffRampFromBase
        ).toBe('0x51a6150400ed9F0Ae240F5D1b15E3b45Fc4339C7')
        expect(foreverMoneyDeployment.base.deploymentBlock).toBe(50_098_800)
        expect(SN80_NETUID).toBe(80n)
        expect(foreverMoneyDeployment.base.contracts.wrappedSn80).toBe(
            '0x6F63d869011f95274498023b4ABFC00b30c34378'
        )
        expect(foreverMoneyDeployment.subtensor.contracts.wrappedSn80).toBe(
            '0xfD628dE75EF96f0A5C59659159C6cA81E0DC2222'
        )
        expect(
            foreverMoneyDeployment.robinhood.contracts.legacyGateways
        ).toEqual(['0x53Dcc4FE04193e489BE537F722F65317DB1E65d8'])
        expect(
            foreverMoneyDeployment.robinhood.contracts.ccipOffRampFromSubtensor
        ).toBe('0xcDca5D374e46A6DDDab50bD2D9acB8c796eC35C3')
    })

    it('cannot be mutated by consumers', () => {
        expect(Object.isFrozen(foreverMoneyDeployment)).toBe(true)
        expect(Object.isFrozen(foreverMoneyDeployment.base.contracts)).toBe(
            true
        )
    })
})
