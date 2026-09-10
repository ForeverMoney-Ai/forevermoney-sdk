import { describe, expect, it, vi } from 'vitest'
import { createWalletClient, custom, type Chain } from 'viem'
import { mainnet } from 'viem/chains'
import {
    toEip1193Transaction,
    toEthersTransaction,
    toViemTransaction,
    type PreparedTransaction,
} from '../index.js'

const transaction: PreparedTransaction = {
    chainId: 8453,
    from: '0x1111111111111111111111111111111111111111',
    to: '0x2222222222222222222222222222222222222222',
    data: '0x1234',
    value: '16',
    gasLimit: '21000',
}

describe('prepared transaction adapters', () => {
    it('converts JSON-safe quantities for EIP-1193 wallets and ethers', () => {
        expect(toEip1193Transaction(transaction)).toEqual({
            from: transaction.from,
            to: transaction.to,
            data: transaction.data,
            value: '0x10',
            gas: '0x5208',
        })
        expect(toEthersTransaction(transaction)).toMatchObject({
            chainId: 8453,
            to: transaction.to,
            data: transaction.data,
            value: 16n,
            gasLimit: 21_000n,
        })
    })

    it('converts viem transactions without losing the signing account or gas', () => {
        expect(toViemTransaction(transaction)).toEqual({
            account: transaction.from,
            chainId: 8453,
            chain: expect.objectContaining({ id: 8453 }),
            to: transaction.to,
            data: transaction.data,
            value: 16n,
            gas: 21_000n,
        })
        const { gasLimit: _gas, ...withoutGas } = transaction
        expect(toViemTransaction(withoutGas)).not.toHaveProperty('gas')
        expect(() =>
            toViemTransaction({ ...transaction, value: '0x10' })
        ).toThrow('unsigned decimal integer')
        expect(() =>
            toViemTransaction({
                ...transaction,
                gasLimit: (2n ** 256n).toString(),
            })
        ).toThrow('uint256')
    })

    it.each([8453, 4663, 964])(
        'rejects a mismatched signing network for plan chain %s',
        async (chainId) => {
            const request = vi.fn(async ({ method }: { method: string }) => {
                if (method === 'eth_chainId') return '0x1'
                throw new Error('Must not reach a signing request')
            })
            const wallet = createWalletClient({
                chain: mainnet,
                transport: custom({ request }, { retryCount: 0 }),
            })
            await expect(
                wallet.sendTransaction(
                    toViemTransaction({ ...transaction, chainId })
                )
            ).rejects.toThrow('does not match')
            expect(request.mock.calls.map(([call]) => call.method)).toEqual([
                'eth_chainId',
            ])
        }
    )

    it.each([8453, 4663, 964])(
        'submits on the intended plan chain %s with an unconfigured wallet',
        async (chainId) => {
            const hash = `0x${'11'.repeat(32)}`
            const request = vi.fn(async ({ method }: { method: string }) => {
                if (method === 'eth_chainId') return `0x${chainId.toString(16)}`
                if (method === 'eth_sendTransaction') return hash
                throw new Error('Unexpected method')
            })
            const wallet = createWalletClient({
                transport: custom({ request }, { retryCount: 0 }),
            })
            const prepared = toViemTransaction({ ...transaction, chainId })
            expect(
                (prepared as typeof prepared & { chain: Chain }).chain.id
            ).toBe(chainId)
            await expect(wallet.sendTransaction(prepared)).resolves.toBe(hash)
            expect(request.mock.calls.map(([call]) => call.method)).toEqual([
                'eth_chainId',
                'eth_sendTransaction',
            ])
        }
    )

    it.each([1, 0, -1, NaN, 8453.1])(
        'rejects an unsupported or malformed plan chain %s',
        (chainId) => {
            expect(() =>
                toViemTransaction({ ...transaction, chainId })
            ).toThrow('Unsupported transaction chain')
        }
    )

    it('fails closed on malformed decimal quantities', () => {
        expect(() =>
            toEip1193Transaction({ ...transaction, value: '01' })
        ).toThrow('unsigned decimal integer')
        expect(() =>
            toEthersTransaction({ ...transaction, gasLimit: '-1' })
        ).toThrow('unsigned decimal integer')
    })
})
