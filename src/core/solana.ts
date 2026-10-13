import { ed25519 } from '@noble/curves/ed25519'
import { sha256 } from '@noble/hashes/sha2.js'
import { base58 } from '@scure/base'
import { bytesToHex, type Hex } from 'viem'
import { foreverMoneyDeployment } from '../chains/deployment.js'
import { ForeverMoneyError } from './errors.js'

const SOLANA_PUBLIC_KEY_BYTES = 32
const PDA_MARKER = new TextEncoder().encode('ProgramDerivedAddress')
// spl-associated-token-account `CreateIdempotent`: succeeds when the account
// already exists, so a retried or raced creation never fails the caller.
const CREATE_IDEMPOTENT_DATA = 1

function invalidSolanaAddress(message: string): ForeverMoneyError {
    return new ForeverMoneyError('INVALID_SOLANA_ADDRESS', message)
}

function decodeSolanaAddress(value: string): Uint8Array {
    let bytes: Uint8Array
    try {
        if (typeof value !== 'string' || value.length === 0)
            throw new Error('Empty address.')
        bytes = base58.decode(value)
    } catch {
        throw invalidSolanaAddress('Expected a base58 Solana address.')
    }
    if (bytes.length !== SOLANA_PUBLIC_KEY_BYTES) {
        throw invalidSolanaAddress('Expected a 32-byte Solana address.')
    }
    return bytes
}

function isOnCurve(bytes: Uint8Array): boolean {
    try {
        ed25519.ExtendedPoint.fromHex(bytes)
        return true
    } catch {
        return false
    }
}

/**
 * Canonical base58 form of a Solana address. Accepts any 32-byte address,
 * including program-derived ones; use `normalizeSolanaWallet` for recipients.
 */
export function normalizeSolanaAddress(value: string): string {
    return base58.encode(decodeSolanaAddress(value))
}

function decodeSolanaWallet(value: string): Uint8Array {
    const bytes = decodeSolanaAddress(value)
    if (bytes.every((byte) => byte === 0)) {
        throw invalidSolanaAddress('Solana recipient must not be zero.')
    }
    // A wallet is an ed25519 public key. Off-curve addresses are PDAs, such as
    // an associated token account pasted in place of its owner: tokens sent
    // there would land in an account nobody can sign for.
    if (!isOnCurve(bytes)) {
        throw invalidSolanaAddress(
            'Solana recipient must be a wallet address, not a token account or program address.'
        )
    }
    return bytes
}

/**
 * Validate a Solana wallet (ed25519 public key) and return its canonical
 * base58 form. Rejects the zero key and off-curve program addresses.
 */
export function normalizeSolanaWallet(value: string): string {
    return base58.encode(decodeSolanaWallet(value))
}

export function isSolanaWallet(value: string): boolean {
    try {
        decodeSolanaWallet(value)
        return true
    } catch {
        return false
    }
}

/** The 32-byte form of a Solana wallet, as the gateway's `tokenReceiver`. */
export function solanaWalletToBytes32(value: string): Hex {
    return bytesToHex(decodeSolanaWallet(value))
}

function findProgramAddress(
    seeds: readonly Uint8Array[],
    programId: Uint8Array
): Uint8Array {
    for (let bump = 255; bump >= 0; bump--) {
        const hash = sha256
            .create()
            .update(new Uint8Array(seeds.flatMap((seed) => [...seed])))
            .update(Uint8Array.of(bump))
            .update(programId)
            .update(PDA_MARKER)
            .digest()
        if (!isOnCurve(hash)) return hash
    }
    // Unreachable in practice: each bump has ~50% odds of landing off-curve.
    throw invalidSolanaAddress(
        'No valid program address exists for these seeds.'
    )
}

/**
 * The associated token account that holds `mint` for `owner` (classic SPL
 * Token program). CCIP delivers Solana tokens here, and does not create it.
 */
export function getSolanaAssociatedTokenAddress(
    owner: string,
    mint: string
): string {
    const { tokenProgram, associatedTokenProgram } =
        foreverMoneyDeployment.solana.contracts
    return base58.encode(
        findProgramAddress(
            [
                decodeSolanaWallet(owner),
                decodeSolanaAddress(tokenProgram),
                decodeSolanaAddress(mint),
            ],
            decodeSolanaAddress(associatedTokenProgram)
        )
    )
}

/** Account roles, numbered as `@solana/kit`'s `AccountRole`. */
export const SolanaAccountRole = Object.freeze({
    READONLY: 0,
    WRITABLE: 1,
    READONLY_SIGNER: 2,
    WRITABLE_SIGNER: 3,
} as const)
export type SolanaAccountRole =
    (typeof SolanaAccountRole)[keyof typeof SolanaAccountRole]

/** A Solana instruction in the shape `@solana/kit` accepts. */
export interface SolanaInstruction {
    readonly programAddress: string
    readonly accounts: readonly {
        readonly address: string
        readonly role: SolanaAccountRole
    }[]
    readonly data: Uint8Array
}

export interface CreateSolanaTokenAccountRequest {
    /** Pays the account's rent (about 0.002 SOL) and signs. Need not be the owner. */
    readonly payer: string
    readonly owner: string
    readonly mint: string
}

/**
 * Instruction that creates `owner`'s associated token account for `mint` if it
 * does not exist yet. Any wallet can pay for it, so an app can sponsor the
 * account for a recipient who holds no SOL.
 */
export function buildCreateSolanaTokenAccountInstruction(
    input: CreateSolanaTokenAccountRequest
): SolanaInstruction {
    const { tokenProgram, associatedTokenProgram } =
        foreverMoneyDeployment.solana.contracts
    const payer = normalizeSolanaWallet(input.payer)
    const owner = normalizeSolanaWallet(input.owner)
    const mint = normalizeSolanaAddress(input.mint)
    return Object.freeze({
        programAddress: associatedTokenProgram,
        accounts: Object.freeze([
            { address: payer, role: SolanaAccountRole.WRITABLE_SIGNER },
            {
                address: getSolanaAssociatedTokenAddress(owner, mint),
                role: SolanaAccountRole.WRITABLE,
            },
            { address: owner, role: SolanaAccountRole.READONLY },
            { address: mint, role: SolanaAccountRole.READONLY },
            {
                address: '11111111111111111111111111111111',
                role: SolanaAccountRole.READONLY,
            },
            { address: tokenProgram, role: SolanaAccountRole.READONLY },
        ]),
        data: Uint8Array.of(CREATE_IDEMPOTENT_DATA),
    })
}
