import { maxUint256, zeroHash, isHex, type Hex } from 'viem'
import { ForeverMoneyError } from './errors.js'

function assertBigInt(
    amount: unknown,
    label: string
): asserts amount is bigint {
    if (typeof amount !== 'bigint') {
        throw new ForeverMoneyError(
            'INVALID_TRANSACTION_PLAN',
            `${label} must be a bigint.`
        )
    }
}

export function assertPositiveAmount(
    amount: unknown,
    label: string
): asserts amount is bigint {
    assertBigInt(amount, label)
    if (amount === 0n) {
        throw new ForeverMoneyError(
            'AMOUNT_ZERO',
            `${label} must be greater than zero.`
        )
    }
    if (amount < 0n) {
        throw new ForeverMoneyError(
            'INVALID_TRANSACTION_PLAN',
            `${label} cannot be negative.`
        )
    }
    if (amount > maxUint256) {
        throw new ForeverMoneyError(
            'INVALID_TRANSACTION_PLAN',
            `${label} exceeds uint256.`
        )
    }
}

export function assertNonNegativeAmount(
    amount: unknown,
    label: string
): asserts amount is bigint {
    assertBigInt(amount, label)
    if (amount < 0n) {
        throw new ForeverMoneyError(
            'INVALID_TRANSACTION_PLAN',
            `${label} cannot be negative.`
        )
    }
    if (amount > maxUint256) {
        throw new ForeverMoneyError(
            'INVALID_TRANSACTION_PLAN',
            `${label} exceeds uint256.`
        )
    }
}

export function assertBoolean(
    value: unknown,
    label: string
): asserts value is boolean {
    if (typeof value !== 'boolean') {
        throw new ForeverMoneyError(
            'INVALID_TRANSACTION_PLAN',
            `${label} must be a boolean.`
        )
    }
}

export function assertArray(
    value: unknown,
    label: string
): asserts value is readonly unknown[] {
    if (!Array.isArray(value)) {
        throw new ForeverMoneyError(
            'INVALID_TRANSACTION_PLAN',
            `${label} must be an array.`
        )
    }
}

export function assertRecord(
    value: unknown,
    label: string
): asserts value is Readonly<Record<string, unknown>> {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
        throw new ForeverMoneyError(
            'INVALID_TRANSACTION_PLAN',
            `${label} must be an object.`
        )
    }
}

export function normalizeBytes32(value: string, label: string): Hex {
    if (!isHex(value, { strict: true }) || value.length !== 66) {
        throw new ForeverMoneyError(
            'INVALID_BYTES32',
            `${label} must be a 32-byte hex value.`
        )
    }
    return value.toLowerCase() as Hex
}

export function normalizeOptionalBytes32(
    value: string | undefined,
    label: string
): Hex {
    return value === undefined ? zeroHash : normalizeBytes32(value, label)
}
