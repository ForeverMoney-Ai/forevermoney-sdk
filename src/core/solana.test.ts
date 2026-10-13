import { describe, expect, it } from 'vitest'
import { foreverMoneyDeployment } from '../chains/deployment.js'
import {
    SolanaAccountRole,
    buildCreateSolanaTokenAccountInstruction,
    getSolanaAssociatedTokenAddress,
    isSolanaWallet,
    normalizeSolanaAddress,
    normalizeSolanaWallet,
    solanaWalletToBytes32,
} from './solana.js'

const mint = foreverMoneyDeployment.solana.contracts.wrappedSn80
// The SN80 deployer and its live token account (verified on mainnet).
const wallet = 'BQHhumdtyfPF3cRBqFUQVsH7TM6xX7KEaz7SNTYzq5nm'
const walletTokenAccount = '6Lc4TvRD9H5oCodVJdkLrvj9GgMVZFvgY8mfTaUkfFWC'

describe('Solana addresses', () => {
    it('derives the live associated token account for SN80', () => {
        expect(getSolanaAssociatedTokenAddress(wallet, mint)).toBe(
            walletTokenAccount
        )
    })

    it('accepts wallets and rejects token accounts, zero and junk', () => {
        expect(normalizeSolanaWallet(wallet)).toBe(wallet)
        expect(isSolanaWallet(wallet)).toBe(true)
        expect(isSolanaWallet(walletTokenAccount)).toBe(false)
        expect(isSolanaWallet('11111111111111111111111111111111')).toBe(false)
        expect(isSolanaWallet('0x1234')).toBe(false)
        expect(isSolanaWallet('')).toBe(false)
        expect(() => normalizeSolanaWallet(walletTokenAccount)).toThrow(
            expect.objectContaining({ code: 'INVALID_SOLANA_ADDRESS' })
        )
        // Program addresses are still valid Solana addresses.
        expect(normalizeSolanaAddress(walletTokenAccount)).toBe(
            walletTokenAccount
        )
    })

    it('encodes a wallet as the bytes32 token receiver', () => {
        expect(solanaWalletToBytes32(wallet)).toBe(
            '0x9a8c1ddd95b372d5ce3fc93a232a4d91dc4487d5344f89a93e4a0eda124ddd5e'
        )
    })

    it('builds an idempotent create-account instruction a sponsor can pay for', () => {
        const payer = '7EaxD58Xag6wVbGAZXnpBYqwGt3kVsUjp7j4euu8vcyf'
        const ix = buildCreateSolanaTokenAccountInstruction({
            payer,
            owner: wallet,
            mint,
        })
        expect(ix.programAddress).toBe(
            foreverMoneyDeployment.solana.contracts.associatedTokenProgram
        )
        expect(ix.accounts).toEqual([
            { address: payer, role: SolanaAccountRole.WRITABLE_SIGNER },
            { address: walletTokenAccount, role: SolanaAccountRole.WRITABLE },
            { address: wallet, role: SolanaAccountRole.READONLY },
            { address: mint, role: SolanaAccountRole.READONLY },
            {
                address: '11111111111111111111111111111111',
                role: SolanaAccountRole.READONLY,
            },
            {
                address: foreverMoneyDeployment.solana.contracts.tokenProgram,
                role: SolanaAccountRole.READONLY,
            },
        ])
        expect([...ix.data]).toEqual([1])
    })
})
