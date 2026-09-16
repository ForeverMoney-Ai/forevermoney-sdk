import { eventLog } from '../test-utils.js'
import { parseAbi } from 'viem'
import { describe, expect, it } from 'vitest'
import { VAULT_FACTORY_ABI } from '../abis/index.js'
import {
    foreverMoneyDeployment,
    vaultManagerFromCreationReceipt,
} from '../index.js'
const owner = '0x1111111111111111111111111111111111111111'
const manager = '0x2222222222222222222222222222222222222222'
describe('canonical vault receipt parsing', () => {
    it('extracts the manager only from the canonical factory event', () => {
        const factory = parseAbi(VAULT_FACTORY_ABI)
        const creationEvent = eventLog(factory, 'SnLiquidityManagerCreated', [
            manager,
            owner,
            `0x${'00'.repeat(32)}`,
            '0x3333333333333333333333333333333333333333',
            '0x4444444444444444444444444444444444444444',
            '0x5555555555555555555555555555555555555555',
            '0x6666666666666666666666666666666666666666',
        ])
        const log = {
            address: foreverMoneyDeployment.base.contracts.vaultFactory,
            ...creationEvent,
        }
        expect(vaultManagerFromCreationReceipt({ logs: [log] })).toBe(manager)
        expect(
            vaultManagerFromCreationReceipt({
                logs: [
                    {
                        ...log,
                        address: '0x7777777777777777777777777777777777777777',
                    },
                ],
            })
        ).toBeNull()
    })
})
