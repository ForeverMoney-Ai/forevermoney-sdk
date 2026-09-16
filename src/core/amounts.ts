import { maxUint256, formatUnits, parseUnits } from 'viem'
import { EVM_WEI_PER_RAO } from '../chains/deployment.js'
import { ForeverMoneyError } from './errors.js'

export const BASIS_POINTS = 10_000n
export const NETWORK_FEE_BUFFER_BPS = 200n
export const GAS_LIMIT_BUFFER_BPS = 5_000n

export function parseTaoAmount(value: string): bigint {
    if (typeof value !== 'string') {
        throw new ForeverMoneyError(
            'AMOUNT_NOT_WHOLE_RAO',
            'TAO amounts must be decimal strings.'
        )
    }
    const decimalPlaces = value.includes('.')
        ? (value.split('.')[1]?.length ?? 0)
        : 0
    if (decimalPlaces > 9) {
        throw new ForeverMoneyError(
            'AMOUNT_NOT_WHOLE_RAO',
            'TAO amounts must be positive decimal strings with at most nine decimal places.'
        )
    }
    let amount: bigint
    try {
        amount = parseUnits(value, 18)
    } catch {
        throw new ForeverMoneyError(
            'AMOUNT_NOT_WHOLE_RAO',
            'TAO amounts must be positive decimal strings with at most nine decimal places.'
        )
    }
    assertWholeRao(amount)
    return amount
}

export function assertWholeRao(amountWei: bigint): void {
    if (typeof amountWei !== 'bigint') {
        throw new ForeverMoneyError(
            'INVALID_TRANSACTION_PLAN',
            'The amount must be a bigint.'
        )
    }
    if (amountWei === 0n) {
        throw new ForeverMoneyError(
            'AMOUNT_ZERO',
            'The amount must be greater than zero.'
        )
    }
    if (amountWei < 0n) {
        throw new ForeverMoneyError(
            'INVALID_TRANSACTION_PLAN',
            'The amount cannot be negative.'
        )
    }
    if (amountWei > maxUint256) {
        throw new ForeverMoneyError(
            'INVALID_TRANSACTION_PLAN',
            'The amount exceeds uint256.'
        )
    }
    if (amountWei % EVM_WEI_PER_RAO !== 0n) {
        throw new ForeverMoneyError(
            'AMOUNT_NOT_WHOLE_RAO',
            'TAO amounts must resolve to a whole RAO.'
        )
    }
}

export function formatTaoAmount(amountWei: bigint): string {
    if (typeof amountWei !== 'bigint') {
        throw new ForeverMoneyError(
            'INVALID_TRANSACTION_PLAN',
            'The TAO amount must be a bigint.'
        )
    }
    if (amountWei < 0n) {
        throw new ForeverMoneyError(
            'INVALID_TRANSACTION_PLAN',
            'A TAO amount cannot be negative.'
        )
    }
    if (amountWei > maxUint256) {
        throw new ForeverMoneyError(
            'INVALID_TRANSACTION_PLAN',
            'The TAO amount exceeds uint256.'
        )
    }
    if (amountWei % EVM_WEI_PER_RAO !== 0n) {
        throw new ForeverMoneyError(
            'AMOUNT_NOT_WHOLE_RAO',
            'TAO amounts must resolve to a whole RAO.'
        )
    }
    const formatted = formatUnits(amountWei, 18)
    return formatted.includes('.') ? formatted : `${formatted}.0`
}

function mulDivCeil(
    value: bigint,
    numerator: bigint,
    denominator: bigint
): bigint {
    return (value * numerator + denominator - 1n) / denominator
}

export function feeWithBuffer(fee: bigint): bigint {
    if (typeof fee !== 'bigint') {
        throw new ForeverMoneyError(
            'INVALID_TRANSACTION_PLAN',
            'The network fee must be a bigint.'
        )
    }
    if (fee < 0n) {
        throw new ForeverMoneyError(
            'INVALID_TRANSACTION_PLAN',
            'A network fee cannot be negative.'
        )
    }
    const buffered = mulDivCeil(
        fee,
        BASIS_POINTS + NETWORK_FEE_BUFFER_BPS,
        BASIS_POINTS
    )
    if (buffered > maxUint256) {
        throw new ForeverMoneyError(
            'INVALID_TRANSACTION_PLAN',
            'The buffered network fee exceeds uint256.'
        )
    }
    return buffered
}

export function gasLimitWithBuffer(gasLimit: bigint): bigint {
    if (typeof gasLimit !== 'bigint') {
        throw new ForeverMoneyError(
            'INVALID_TRANSACTION_PLAN',
            'The gas limit must be a bigint.'
        )
    }
    if (gasLimit <= 0n) {
        throw new ForeverMoneyError(
            'INVALID_TRANSACTION_PLAN',
            'A gas limit must be greater than zero.'
        )
    }
    const buffered = mulDivCeil(
        gasLimit,
        BASIS_POINTS + GAS_LIMIT_BUFFER_BPS,
        BASIS_POINTS
    )
    if (buffered > maxUint256) {
        throw new ForeverMoneyError(
            'INVALID_TRANSACTION_PLAN',
            'The buffered gas limit exceeds uint256.'
        )
    }
    return buffered
}
