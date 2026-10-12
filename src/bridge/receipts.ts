import { decodeEventLog, isHex, parseAbi, type Hex } from 'viem'
import { ALPHA_GATEWAY_ABI, SPOKE_GATEWAY_ABI } from '../abis/index.js'
import {
    foreverMoneyDeployment,
    getForeverMoneyEvmDeployment,
    type ForeverMoneyEvmChain,
} from '../chains/deployment.js'
import { ForeverMoneyError } from '../core/errors.js'
import { isLogFrom, type TransactionReceiptLike } from '../core/receipts.js'

export type { ReceiptLog, TransactionReceiptLike } from '../core/receipts.js'

const alphaGatewayAbi = parseAbi(ALPHA_GATEWAY_ABI)
const spokeGatewayAbi = parseAbi(SPOKE_GATEWAY_ABI)

export type BridgeDirection =
    | 'base-to-subtensor'
    | 'robinhood-to-subtensor'
    | 'subtensor-to-base'
    | 'subtensor-to-robinhood'
    | 'subtensor-to-solana'

export function assertBridgeDirection(
    value: unknown
): asserts value is BridgeDirection {
    if (
        value !== 'base-to-subtensor' &&
        value !== 'robinhood-to-subtensor' &&
        value !== 'subtensor-to-base' &&
        value !== 'subtensor-to-robinhood' &&
        value !== 'subtensor-to-solana'
    ) {
        throw new ForeverMoneyError(
            'INVALID_TRANSACTION_PLAN',
            'Bridge direction must identify a canonical Base, Robinhood or Solana lane.'
        )
    }
}

export function isSolanaDirection(direction: BridgeDirection): boolean {
    assertBridgeDirection(direction)
    return direction === 'subtensor-to-solana'
}

export function evmChainFromBridgeDirection(
    direction: BridgeDirection
): ForeverMoneyEvmChain {
    if (isSolanaDirection(direction)) {
        throw new ForeverMoneyError(
            'INVALID_TRANSACTION_PLAN',
            'The Subtensor to Solana lane has no EVM destination chain.'
        )
    }
    return direction.includes('robinhood') ? 'robinhood' : 'base'
}

export function isEvmToSubtensorDirection(direction: BridgeDirection): boolean {
    assertBridgeDirection(direction)
    return direction.endsWith('-to-subtensor')
}

export function bridgeMessageIdFromReceipt(
    direction: BridgeDirection,
    receipt: TransactionReceiptLike
): string | null {
    if (isSolanaDirection(direction)) {
        return solanaMessageIdFromReceipt(receipt)
    }
    const evm = getForeverMoneyEvmDeployment(
        evmChainFromBridgeDirection(direction)
    )
    const evmToSubtensor = isEvmToSubtensorDirection(direction)
    const [addresses, contractAbi, eventName] = evmToSubtensor
        ? [
              [...evm.contracts.legacyGateways, evm.contracts.gateway],
              spokeGatewayAbi,
              'BridgedToFinney',
          ]
        : [
              [
                  ...foreverMoneyDeployment.subtensor.contracts.legacyGateways,
                  foreverMoneyDeployment.subtensor.contracts.gateway,
              ],
              alphaGatewayAbi,
              'BridgedOut',
          ]

    for (const log of receipt.logs) {
        if (!addresses.some((address) => isLogFrom(log, address))) continue
        try {
            const parsed = decodeEventLog({
                abi: contractAbi,
                data: log.data as Hex,
                topics: [...log.topics] as [Hex, ...Hex[]],
            })
            const messageId =
                'messageId' in parsed.args ? parsed.args.messageId : undefined
            if (
                parsed.eventName === eventName &&
                typeof messageId === 'string' &&
                isHex(messageId, { strict: true }) &&
                messageId.length === 66 &&
                (evmToSubtensor ||
                    ('destChainSelector' in parsed.args &&
                        parsed.args.destChainSelector === evm.ccipSelector))
            ) {
                return messageId.toLowerCase()
            }
        } catch {
            // A receipt can contain unrelated events from the same contract.
        }
    }
    return null
}

function solanaMessageIdFromReceipt(
    receipt: TransactionReceiptLike
): string | null {
    const { subtensor, solana } = foreverMoneyDeployment
    for (const log of receipt.logs) {
        if (!isLogFrom(log, subtensor.contracts.svmGateway)) continue
        try {
            const parsed = decodeEventLog({
                abi: alphaGatewayAbi,
                data: log.data as Hex,
                topics: [...log.topics] as [Hex, ...Hex[]],
            })
            if (
                parsed.eventName === 'BridgedOutSvm' &&
                parsed.args.destSelector === solana.ccipSelector &&
                isHex(parsed.args.messageId, { strict: true }) &&
                parsed.args.messageId.length === 66
            ) {
                return parsed.args.messageId.toLowerCase()
            }
        } catch {
            // A receipt can contain unrelated events from the same contract.
        }
    }
    return null
}
