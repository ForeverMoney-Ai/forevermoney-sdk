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
    | 'base-to-berachain'
    | 'berachain-to-base'
    | 'base-to-subtensor'
    | 'robinhood-to-subtensor'
    | 'subtensor-to-base'
    | 'subtensor-to-robinhood'
    | 'subtensor-to-solana'
    | 'solana-to-subtensor'

export function assertBridgeDirection(
    value: unknown
): asserts value is BridgeDirection {
    if (
        value !== 'base-to-berachain' &&
        value !== 'berachain-to-base' &&
        value !== 'base-to-subtensor' &&
        value !== 'robinhood-to-subtensor' &&
        value !== 'subtensor-to-base' &&
        value !== 'subtensor-to-robinhood' &&
        value !== 'subtensor-to-solana' &&
        value !== 'solana-to-subtensor'
    ) {
        throw new ForeverMoneyError(
            'INVALID_TRANSACTION_PLAN',
            'Bridge direction must identify a canonical Base, Robinhood, Berachain or Solana lane.'
        )
    }
}

/** Either Berachain lane: Base to Berachain, or Berachain to Base. */
export function isBerachainDirection(direction: BridgeDirection): boolean {
    assertBridgeDirection(direction)
    return (
        direction === 'base-to-berachain' || direction === 'berachain-to-base'
    )
}

/** Either Solana lane: Subtensor to Solana, or Solana to Subtensor. */
export function isSolanaDirection(direction: BridgeDirection): boolean {
    assertBridgeDirection(direction)
    return (
        direction === 'subtensor-to-solana' ||
        direction === 'solana-to-subtensor'
    )
}

export function evmChainFromBridgeDirection(
    direction: BridgeDirection
): ForeverMoneyEvmChain {
    if (isSolanaDirection(direction)) {
        throw new ForeverMoneyError(
            'INVALID_TRANSACTION_PLAN',
            'Solana lanes have no EVM chain on the Solana side.'
        )
    }
    if (isBerachainDirection(direction)) {
        throw new ForeverMoneyError(
            'INVALID_TRANSACTION_PLAN',
            'Berachain lanes pair Base with Berachain and do not touch Subtensor.'
        )
    }
    return direction.includes('robinhood') ? 'robinhood' : 'base'
}

export function isEvmToSubtensorDirection(direction: BridgeDirection): boolean {
    return (
        direction.endsWith('-to-subtensor') &&
        !isSolanaDirection(direction) &&
        !isBerachainDirection(direction)
    )
}

export function bridgeMessageIdFromReceipt(
    direction: BridgeDirection,
    receipt: TransactionReceiptLike
): string | null {
    if (direction === 'solana-to-subtensor') {
        throw new ForeverMoneyError(
            'INVALID_TRANSACTION_PLAN',
            'A Solana send has no EVM receipt; read it with getSolanaSourceStatus.'
        )
    }
    if (direction === 'subtensor-to-solana') {
        return solanaMessageIdFromReceipt(receipt)
    }
    if (isBerachainDirection(direction)) {
        return ccipOnRampMessageIdFromReceipt(
            receipt,
            direction === 'base-to-berachain'
                ? foreverMoneyDeployment.berachain.ccipSelector
                : foreverMoneyDeployment.base.ccipSelector
        )
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

// CCIP v2.0 OnRamp `CCIPMessageSent`: topics are destChainSelector,
// sequenceNumber and messageId. Matched by topic rather than OnRamp address, so
// a Chainlink OnRamp upgrade does not break tracking; a Berachain-lane send only
// calls the router (directly or through the RoyaltyGateway), so the only
// OnRamp in the receipt is the one the router chose.
const CCIP_MESSAGE_SENT_TOPIC =
    '0x371bc2ff0a006f4ef863b1d27a065d4e9f938b6d883eb154572b4aea593b32cc'

function ccipOnRampMessageIdFromReceipt(
    receipt: TransactionReceiptLike,
    destinationSelector: bigint
): string | null {
    for (const log of receipt.logs) {
        const [topic, selector, , messageId] = log.topics
        if (
            topic?.toLowerCase() === CCIP_MESSAGE_SENT_TOPIC &&
            selector !== undefined &&
            isHex(selector, { strict: true }) &&
            BigInt(selector) === destinationSelector &&
            messageId !== undefined &&
            isHex(messageId, { strict: true }) &&
            messageId.length === 66
        ) {
            return messageId.toLowerCase()
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
