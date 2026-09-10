import fc from 'fast-check'
import { maxUint256 } from 'viem'
import { describe, expect, it } from 'vitest'
import {
    EVM_WEI_PER_RAO,
    feeWithBuffer,
    formatTaoAmount,
    gasLimitWithBuffer,
    parseTaoAmount,
} from '../index.js'

describe('TAO amounts', () => {
    it('parses and formats exact RAO precision', () => {
        expect(parseTaoAmount('1.23456789')).toBe(1_234_567_890_000_000_000n)
        expect(formatTaoAmount(1_234_567_890_000_000_000n)).toBe('1.23456789')
        expect(formatTaoAmount(0n)).toBe('0.0')
    })

    it('rejects zero, negative, and sub-RAO bridge amounts', () => {
        expect(() => parseTaoAmount('0')).toThrow('greater than zero')
        expect(() => parseTaoAmount('-1')).toThrow('cannot be negative')
        expect(() => parseTaoAmount('0.0000000001')).toThrow(
            'at most nine decimal places'
        )
        expect(() => formatTaoAmount(-EVM_WEI_PER_RAO)).toThrow(
            'cannot be negative'
        )
        expect(() => formatTaoAmount(maxUint256 + 1n)).toThrow(
            'exceeds uint256'
        )
        expect(() => parseTaoAmount(1 as unknown as string)).toThrow(
            'decimal strings'
        )
        expect(() => feeWithBuffer(1 as unknown as bigint)).toThrow(
            'must be a bigint'
        )
    })

    it('round-trips positive whole-RAO amounts', () => {
        fc.assert(
            fc.property(fc.bigInt({ min: 1n, max: 10n ** 18n }), (rao) => {
                const wei = rao * EVM_WEI_PER_RAO
                expect(parseTaoAmount(formatTaoAmount(wei))).toBe(wei)
            })
        )
    })

    it('uses ceiling integer arithmetic for fee and gas buffers', () => {
        fc.assert(
            fc.property(fc.bigInt({ min: 0n, max: 10n ** 30n }), (fee) => {
                const buffered = feeWithBuffer(fee)
                expect(buffered * 100n).toBeGreaterThanOrEqual(fee * 102n)
                if (buffered > 0n) {
                    expect((buffered - 1n) * 100n).toBeLessThan(fee * 102n)
                }
            })
        )
        expect(gasLimitWithBuffer(101n)).toBe(152n)
        expect(() => gasLimitWithBuffer(0n)).toThrow('greater than zero')
        expect(() => feeWithBuffer(maxUint256)).toThrow('exceeds uint256')
        expect(() => gasLimitWithBuffer(maxUint256)).toThrow('exceeds uint256')
    })
})
