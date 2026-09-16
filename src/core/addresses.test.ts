import { AccountId } from '@polkadot-api/substrate-bindings'
const encodeAddress = (key: Uint8Array, prefix: number) =>
    AccountId(prefix).dec(key)
import { describe, expect, it } from 'vitest'
import {
    evmToMirrorSS58,
    normalizeEvmAddress,
    normalizeSS58,
    ss58ToPublicKey,
} from '../index.js'

const publicKey = new Uint8Array(32).fill(7)

describe('addresses', () => {
    it('normalizes non-zero EVM and Bittensor addresses', () => {
        const ss58 = encodeAddress(publicKey, 42)
        expect(
            normalizeEvmAddress('0x1111111111111111111111111111111111111111')
        ).toBe('0x1111111111111111111111111111111111111111')
        expect(normalizeSS58(ss58)).toBe(ss58)
        expect(ss58ToPublicKey(ss58)).toBe(`0x${'07'.repeat(32)}`)
        expect(
            normalizeSS58(
                evmToMirrorSS58('0x1111111111111111111111111111111111111111')
            )
        ).toBeTruthy()
    })

    it.each([
        '0xabcdefabcdefabcdefabcdefabcdefabcdefabcd',
        '0xABCDEFABCDEFABCDEFABCDEFABCDEFABCDEFABCD',
        '0xABcdEFABcdEFabcdEfAbCdefabcdeFABcDEFabCD',
    ])('preserves address normalization for %s', (address) => {
        expect(normalizeEvmAddress(address)).toBe(
            '0xABcdEFABcdEFabcdEfAbCdefabcdeFABcDEFabCD'
        )
        expect(evmToMirrorSS58(address)).toBe(
            evmToMirrorSS58('0xabcdefabcdefabcdefabcdefabcdefabcdefabcd')
        )
    })

    it.each([
        '0xAbCdEfABCDEFabcdefABCDEFabcdefabcdefabcd',
        '0x0000000000000000000000000000000000000000',
        '0xABCDEF',
        '0xGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGG',
    ])('rejects an invalid address or checksum: %s', (address) => {
        expect(() => normalizeEvmAddress(address)).toThrow(
            'non-zero EVM address'
        )
    })

    it('rejects zero addresses, raw keys, malformed SS58, and other prefixes', () => {
        expect(() =>
            normalizeEvmAddress('0x0000000000000000000000000000000000000000')
        ).toThrow('non-zero')
        expect(() => normalizeSS58(`0x${'07'.repeat(32)}`)).toThrow('prefix 42')
        expect(() => normalizeSS58(encodeAddress(publicKey, 0))).toThrow(
            'prefix 42'
        )
        expect(() => normalizeSS58('not-an-address')).toThrow('prefix 42')
    })
})
