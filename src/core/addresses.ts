import {
    AccountId,
    Blake2256,
    getSs58AddressInfo,
} from '@polkadot-api/substrate-bindings'
import {
    bytesToHex,
    concat,
    getAddress,
    hexToBytes,
    isAddress,
    stringToBytes,
    zeroAddress,
    type Address,
    type Hex,
} from 'viem'
import { ForeverMoneyError } from './errors.js'

const BITTENSOR_SS58_PREFIX = 42

export function normalizeEvmAddress(value: string): Address {
    // All-uppercase and all-lowercase are valid unchecksummed forms. Mixed case
    // must still pass EIP-55 validation, as it did before the viem migration.
    const candidate =
        typeof value === 'string' && /^0x[0-9A-F]{40}$/.test(value)
            ? value.toLowerCase()
            : value
    if (!isAddress(candidate) || candidate === zeroAddress) {
        throw new ForeverMoneyError(
            'INVALID_ADDRESS',
            'Expected a non-zero EVM address.'
        )
    }
    return getAddress(candidate)
}

export function evmToMirrorSS58(evmAddress: string): string {
    return AccountId(BITTENSOR_SS58_PREFIX).dec(
        Blake2256(
            concat([
                stringToBytes('evm:'),
                hexToBytes(normalizeEvmAddress(evmAddress)),
            ])
        )
    )
}

function decodeBittensorAddress(value: string): Uint8Array {
    try {
        if (typeof value !== 'string' || !value || value.startsWith('0x'))
            throw new Error('Raw hex is not SS58.')
        const info = getSs58AddressInfo(value)
        if (
            !info.isValid ||
            info.ss58Format !== BITTENSOR_SS58_PREFIX ||
            info.publicKey.length !== 32
        )
            throw new Error('Invalid Bittensor address.')
        const publicKey = info.publicKey
        return publicKey
    } catch {
        throw new ForeverMoneyError(
            'INVALID_SS58',
            'Expected a Bittensor SS58 address with prefix 42.'
        )
    }
}

export function normalizeSS58(value: string): string {
    return AccountId(BITTENSOR_SS58_PREFIX).dec(decodeBittensorAddress(value))
}

export function isBittensorSS58(value: string): boolean {
    try {
        decodeBittensorAddress(value)
        return true
    } catch {
        return false
    }
}

export function ss58ToPublicKey(value: string): Hex {
    return bytesToHex(decodeBittensorAddress(value))
}
