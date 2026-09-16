import { parseAbi } from 'viem'
import { describe, expect, it } from 'vitest'
import { ALPHA_GATEWAY_ABI, SPOKE_GATEWAY_ABI } from '../abis/index.js'
import { foreverMoneyDeployment } from '../chains/deployment.js'
import { eventLog } from '../test-utils.js'
import { bridgeMessageIdFromReceipt } from './receipts.js'

const { base, subtensor } = foreverMoneyDeployment
const sender = '0x1111111111111111111111111111111111111111'
const recipient = '0x2222222222222222222222222222222222222222'
const messageId = `0x${'44'.repeat(32)}`

describe('V5 gateway receipt tracking', () => {
    it('reads message IDs from both the new and the old Base gateway', () => {
        const log = eventLog(parseAbi(SPOKE_GATEWAY_ABI), 'BridgedToFinney', [
            base.contracts.wrappedTao,
            sender,
            `0x${'55'.repeat(32)}`,
            100n,
            messageId,
        ])
        for (const address of [
            base.contracts.gateway,
            base.contracts.legacyGateways[0]!,
        ]) {
            expect(
                bridgeMessageIdFromReceipt('base-to-subtensor', {
                    logs: [{ address, ...log }],
                })
            ).toBe(messageId)
        }
    })

    it('reads a new Subtensor gateway message ID only for its lane', () => {
        const log = eventLog(parseAbi(ALPHA_GATEWAY_ABI), 'BridgedOut', [
            base.ccipSelector,
            subtensor.contracts.wrappedTao,
            sender,
            recipient,
            100n,
            messageId,
        ])
        const receipt = {
            logs: [{ address: subtensor.contracts.gateway, ...log }],
        }
        expect(bridgeMessageIdFromReceipt('subtensor-to-base', receipt)).toBe(
            messageId
        )
        expect(
            bridgeMessageIdFromReceipt('subtensor-to-robinhood', receipt)
        ).toBeNull()
    })
})
