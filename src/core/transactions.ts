import {
    defineChain,
    maxUint256,
    type Address,
    type Chain,
    type Hex,
} from 'viem'
import {
    BASE_CHAIN_ID,
    ROBINHOOD_CHAIN_ID,
    SUBTENSOR_CHAIN_ID,
} from '../chains/deployment.js'
import { ForeverMoneyError } from './errors.js'
import type { PreparedTransaction } from './plans.js'

export interface Eip1193TransactionRequest {
    readonly from: string
    readonly to: string
    readonly data: string
    readonly value: string
    readonly gas?: string
}

function decimalQuantity(value: string, label: string): bigint {
    if (!/^(0|[1-9][0-9]*)$/.test(value)) {
        throw new ForeverMoneyError(
            'INVALID_TRANSACTION_PLAN',
            `${label} must be an unsigned decimal integer.`
        )
    }
    const quantity = BigInt(value)
    if (quantity > maxUint256) {
        throw new ForeverMoneyError(
            'INVALID_TRANSACTION_PLAN',
            `${label} exceeds uint256.`
        )
    }
    return quantity
}

function hexQuantity(value: bigint): string {
    return `0x${value.toString(16)}`
}

export function toEip1193Transaction(
    transaction: PreparedTransaction
): Eip1193TransactionRequest {
    const value = decimalQuantity(transaction.value, 'Transaction value')
    const gasLimit =
        transaction.gasLimit === undefined
            ? undefined
            : decimalQuantity(transaction.gasLimit, 'Transaction gas limit')

    return Object.freeze({
        from: transaction.from,
        to: transaction.to,
        data: transaction.data,
        value: hexQuantity(value),
        ...(gasLimit === undefined ? {} : { gas: hexQuantity(gasLimit) }),
    })
}

export function toEthersTransaction(
    transaction: PreparedTransaction
): Readonly<EthersCompatibleTransactionRequest> {
    return Object.freeze({
        chainId: transaction.chainId,
        to: transaction.to,
        data: transaction.data,
        value: decimalQuantity(transaction.value, 'Transaction value'),
        ...(transaction.gasLimit === undefined
            ? {}
            : {
                  gasLimit: decimalQuantity(
                      transaction.gasLimit,
                      'Transaction gas limit'
                  ),
              }),
    })
}

// Structural compatibility for existing consumers; no ethers dependency.
export interface EthersCompatibleTransactionRequest {
    readonly chainId: number
    readonly to: string
    readonly data: string
    readonly value: bigint
    readonly gasLimit?: bigint
}

export interface ViemTransactionRequest {
    readonly chain: Chain
    readonly account: Address
    readonly chainId: number
    readonly to: Address
    readonly data: Hex
    readonly value: bigint
    readonly gas?: bigint
}

const transactionChains = new Map<number, Chain>(
    (
        [
            [BASE_CHAIN_ID, 'Base', 'Ether', 'ETH'],
            [ROBINHOOD_CHAIN_ID, 'Robinhood', 'Ether', 'ETH'],
            [SUBTENSOR_CHAIN_ID, 'Subtensor', 'TAO', 'TAO'],
        ] as const
    ).map(([id, name, currency, symbol]) => [
        id,
        Object.freeze(
            defineChain({
                id,
                name,
                nativeCurrency: Object.freeze({
                    name: currency,
                    symbol,
                    decimals: 18,
                }),
                // Chain identity only. The caller retains ownership of the wallet transport.
                rpcUrls: Object.freeze({
                    default: Object.freeze({ http: Object.freeze([]) }),
                }),
            })
        ),
    ])
)

export function toViemTransaction(
    transaction: PreparedTransaction
): Readonly<ViemTransactionRequest> {
    const chain = transactionChains.get(transaction.chainId)
    if (!chain)
        throw new ForeverMoneyError(
            'INVALID_TRANSACTION_PLAN',
            'Unsupported transaction chain.'
        )
    return Object.freeze({
        chain,
        account: transaction.from as Address,
        chainId: transaction.chainId,
        to: transaction.to as Address,
        data: transaction.data as Hex,
        value: decimalQuantity(transaction.value, 'Transaction value'),
        ...(transaction.gasLimit === undefined
            ? {}
            : {
                  gas: decimalQuantity(
                      transaction.gasLimit,
                      'Transaction gas limit'
                  ),
              }),
    })
}
