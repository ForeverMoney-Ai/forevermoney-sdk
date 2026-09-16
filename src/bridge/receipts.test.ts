import { eventLog } from '../test-utils.js'
import { parseAbi } from 'viem'
import { describe, expect, it } from 'vitest'
import { ALPHA_GATEWAY_ABI, SPOKE_GATEWAY_ABI } from '../abis/index.js'
import { bridgeMessageIdFromReceipt, foreverMoneyDeployment } from '../index.js'
const messageId = `0x${'12'.repeat(32)}`
const sender = '0x1111111111111111111111111111111111111111'
const manager = '0x2222222222222222222222222222222222222222'
describe('canonical bridge receipt parsing', () => {
    it('extracts bridge message IDs only from the expected gateway', () => {
        const contractAbi = parseAbi(SPOKE_GATEWAY_ABI)
        const event = eventLog(contractAbi, 'BridgedToFinney', [
            foreverMoneyDeployment.base.contracts.wrappedTao,
            sender,
            `0x${'34'.repeat(32)}`,
            1n,
            messageId,
        ])
        const receipt = {
            logs: [
                {
                    address:
                        foreverMoneyDeployment.base.contracts
                            .legacyGateways[0]!,
                    ...event,
                },
            ],
        }
        expect(bridgeMessageIdFromReceipt('base-to-subtensor', receipt)).toBe(
            messageId
        )
        expect(
            bridgeMessageIdFromReceipt('subtensor-to-base', receipt)
        ).toBeNull()
    })
    it('supports Subtensor bridge receipts', () => {
        const alpha = parseAbi(ALPHA_GATEWAY_ABI)
        const bridgeEvent = eventLog(alpha, 'BridgedOut', [
            foreverMoneyDeployment.base.ccipSelector,
            foreverMoneyDeployment.subtensor.contracts.wrappedTao,
            sender,
            manager,
            1n,
            messageId,
        ])
        expect(
            bridgeMessageIdFromReceipt('subtensor-to-base', {
                logs: [
                    {
                        address:
                            foreverMoneyDeployment.subtensor.contracts
                                .legacyGateways[0]!,
                        ...bridgeEvent,
                    },
                ],
            })
        ).toBe(messageId)
    })
    it('uses the canonical Robinhood gateway and destination selector', () => {
        const spoke = parseAbi(SPOKE_GATEWAY_ABI)
        const toSubtensor = eventLog(spoke, 'BridgedToFinney', [
            foreverMoneyDeployment.robinhood.contracts.wrappedTao,
            sender,
            `0x${'34'.repeat(32)}`,
            1n,
            messageId,
        ])
        expect(
            bridgeMessageIdFromReceipt('robinhood-to-subtensor', {
                logs: [
                    {
                        address:
                            foreverMoneyDeployment.robinhood.contracts
                                .legacyGateways[0]!,
                        ...toSubtensor,
                    },
                ],
            })
        ).toBe(messageId)
        const alpha = parseAbi(ALPHA_GATEWAY_ABI)
        const toRobinhood = eventLog(alpha, 'BridgedOut', [
            foreverMoneyDeployment.robinhood.ccipSelector,
            foreverMoneyDeployment.subtensor.contracts.wrappedTao,
            sender,
            manager,
            1n,
            messageId,
        ])
        expect(
            bridgeMessageIdFromReceipt('subtensor-to-robinhood', {
                logs: [
                    {
                        address:
                            foreverMoneyDeployment.subtensor.contracts
                                .legacyGateways[0]!,
                        ...toRobinhood,
                    },
                ],
            })
        ).toBe(messageId)
        expect(
            bridgeMessageIdFromReceipt('subtensor-to-base', {
                logs: [
                    {
                        address:
                            foreverMoneyDeployment.subtensor.contracts
                                .legacyGateways[0]!,
                        ...toRobinhood,
                    },
                ],
            })
        ).toBeNull()
    })
    it('rejects an unknown bridge direction instead of selecting a gateway', () => {
        expect(() =>
            bridgeMessageIdFromReceipt('invalid' as 'base-to-subtensor', {
                logs: [],
            })
        ).toThrow('Bridge direction')
    })
})
