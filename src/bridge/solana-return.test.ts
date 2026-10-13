import { AccountId } from '@polkadot-api/substrate-bindings'
import {
    decodeAbiParameters,
    hexToBytes,
    parseAbi,
    parseAbiParameters,
    type PublicClient,
} from 'viem'
import { describe, expect, it, vi } from 'vitest'
import { ALPHA_GATEWAY_ABI } from '../abis/index.js'
import {
    SOLANA_CCIP_SELECTOR,
    SOLANA_TO_SUBTENSOR_DESTINATION_GAS_LIMIT,
    bridgeMessageIdFromReceipt,
    buildSolanaToSubtensorMessage,
    destinationChainId,
    foreverMoneyDeployment,
    getCcipDeliveryStatus,
    sourceChainId,
    type SolanaToSubtensorRequest,
} from '../index.js'
import type { RpcRequest, RpcTransport } from '../core/transport.js'
import { eventLog } from '../test-utils.js'
import {
    getSolanaSourceStatus,
    getSolanaWalletBalances,
    solanaSendMessageId,
} from './solana.js'

const { subtensor, solana } = foreverMoneyDeployment
// Staked return of 0.2 SN80 on 12 Oct 2026 (Solana tx o4fXUehV…): the
// deployer wallet, the destination coldkey and the 964 fallback it used.
const wallet = 'BQHhumdtyfPF3cRBqFUQVsH7TM6xX7KEaz7SNTYzq5nm'
const coldkeyPublicKey =
    '0x5076251ed68fc9abe9e7138c1c677fe54fafbde93f3392d0f447f76cf7c7ec78'
const coldkey = AccountId(42).dec(hexToBytes(coldkeyPublicKey))
const evmFallback = '0x5A16F43BD0F0CaD4d637244Fa9E7749a86270583'
const messageId =
    '0xdaadd050bcaeb9b6e1fa683a309bba545dd9bc585fcb827fab6f6c1129aa0f27'
const sendSignature =
    'o4fXUehVPM7AWcP64vwLjUBwQ2SuwfRnrGPqkoigxkRowRz9t5y4YeQGHtRCwjPxqhVNo5AQEAzRFPgadjXhnbU'
const messageSentLog =
    'Program data: F01Jt3u5czk4pW8cuGyhHQQAAAAAAAAA2q3QULyuubbh+mg6MJu6VF3ZvFhfy4J/q29sESmqDyfnyZdh+7i6ATilbxy4bKEdBAAAAAAAAAAAAAAAAAAAAJqMHd2Vs3LVzj/JOiMqTZHcRIfVNE+JqT5KDtoSTd1egAAAAFB2JR7Wj8mr6ecTjBxnf+VPr73pPzOS0PRH92z3x+x4AAAAAAAAAAAAAAAAWhb0O9DwytTWNyRPqed0moYnBYMAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAIAAAAAAAAAAAAAAAAAAAAC6CGczwCrrz/t2iyTLs7VZlSq84FQAAABgdzxBAQg8AAAAAAAAAAAAAAAAAAQabiFf+q4GE+2h/Y0YYwDXaxDncGus7VZig8AAAAAABAQAAAB7Lut/rgSFQGwpi80jYZ4szemfCkPKjCUtTy55ytDIpIAAAAAAAAAAAAAAAAAAAAP1ijede+W8KXFllkVnGyoHg3CIiIAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAJAMLrCwAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAEAAAAAAFfkMwoSwEAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAMLM3JwahQIAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA='
const router = solana.contracts.ccipRouter
const sendLogs = [
    `Program ${router} invoke [1]`,
    'Program log: Instruction: CcipSend',
    messageSentLog,
    `Program ${router} success`,
]
const request: SolanaToSubtensorRequest = {
    asset: 'sn80',
    sender: wallet,
    amountWei: 2n * 10n ** 17n,
    destination: coldkey,
    delivery: 'staked',
    evmFallback,
}
const exitPayload = parseAbiParameters(
    'bytes32 ss58, address evmFallback, bool wantLiquid, uint256 minTaoOut'
)

function transport(
    handlers: Record<string, (params: readonly unknown[]) => unknown>
): RpcTransport {
    return {
        request: vi.fn(async ({ method, params }: RpcRequest) => {
            const handler = handlers[method]
            if (!handler) throw new Error(`Unexpected Solana RPC ${method}`)
            return handler((params ?? []) as readonly unknown[])
        }),
    }
}

describe('Solana to Subtensor message', () => {
    it('sends the token to the V7 gateway with the exit payload and 3M gas', () => {
        const {
            router: sendRouter,
            destChainSelector,
            sender,
            message,
        } = buildSolanaToSubtensorMessage(request)
        expect(sendRouter).toBe(router)
        expect(destChainSelector).toBe(subtensor.ccipSelector)
        expect(sender).toBe(wallet)
        expect(message.receiver).toBe(subtensor.contracts.svmGateway)
        expect(message.tokenAmounts).toEqual([
            { token: solana.contracts.wrappedSn80, amount: 200_000_000n },
        ])
        expect(message.extraArgs).toEqual({
            gasLimit: SOLANA_TO_SUBTENSOR_DESTINATION_GAS_LIMIT,
            allowOutOfOrderExecution: true,
        })
        expect(SOLANA_TO_SUBTENSOR_DESTINATION_GAS_LIMIT).toBe(3_000_000n)
        expect(decodeAbiParameters(exitPayload, message.data)).toEqual([
            coldkeyPublicKey,
            evmFallback,
            false,
            2n * 10n ** 17n,
        ])
        // Byte-identical to the verified mainnet send, apart from minTaoOut
        // (ignored on the staked route; that send used 0).
        expect(message.data.slice(0, 2 + 96 * 2)).toBe(
            `${coldkeyPublicKey}${'0'.repeat(24)}${evmFallback.slice(2).toLowerCase()}${'0'.repeat(64)}`
        )
    })

    it('rejects a missing fallback, EVM senders, liquid subnet delivery and partial RAO', () => {
        const build = (input: Partial<SolanaToSubtensorRequest>) => () =>
            buildSolanaToSubtensorMessage({ ...request, ...input })
        expect(build({ evmFallback: '' })).toThrow(
            expect.objectContaining({ code: 'INVALID_ADDRESS' })
        )
        expect(
            build({ evmFallback: '0x0000000000000000000000000000000000000000' })
        ).toThrow(expect.objectContaining({ code: 'INVALID_ADDRESS' }))
        expect(build({ sender: evmFallback })).toThrow(
            expect.objectContaining({ code: 'INVALID_SOLANA_ADDRESS' })
        )
        expect(build({ delivery: 'liquid' })).toThrow(/requires staked subnet/)
        expect(build({ amountWei: 2n * 10n ** 17n + 1n })).toThrow(
            expect.objectContaining({ code: 'AMOUNT_NOT_WHOLE_RAO' })
        )
        expect(build({ asset: 'tao' })).toThrow(/not supported on solana/)
    })
})

describe('Solana to Subtensor tracking', () => {
    it('reads the message ID from the router event only', () => {
        expect(solanaSendMessageId(sendLogs)).toBe(messageId)
        const pool = '41FGToCmdaWa1dgZLKFAjvmx6e6AjVTX7SVRibvsMGVB'
        expect(
            solanaSendMessageId([
                `Program ${pool} invoke [1]`,
                messageSentLog,
                `Program ${pool} success`,
            ])
        ).toBeNull()
    })

    it('resolves pending, failed and confirmed sends from the full history', async () => {
        const statuses = (status: unknown) =>
            transport({
                getSignatureStatuses: ([, options]) => {
                    expect(options).toEqual({ searchTransactionHistory: true })
                    return { value: [status] }
                },
                getTransaction: () => ({ meta: { logMessages: sendLogs } }),
            })
        await expect(
            getSolanaSourceStatus(statuses(null), { signature: sendSignature })
        ).resolves.toMatchObject({ status: 'pending', messageId: null })
        await expect(
            getSolanaSourceStatus(
                statuses({ confirmationStatus: 'processed', err: null }),
                { signature: sendSignature }
            )
        ).resolves.toMatchObject({ status: 'pending' })
        await expect(
            getSolanaSourceStatus(
                statuses({ confirmationStatus: 'confirmed', err: { x: 1 } }),
                { signature: sendSignature }
            )
        ).resolves.toMatchObject({ status: 'failed', messageId: null })
        await expect(
            getSolanaSourceStatus(
                statuses({ confirmationStatus: 'finalized', err: null }),
                { signature: sendSignature }
            )
        ).resolves.toEqual({
            signature: sendSignature,
            status: 'confirmed',
            messageId,
        })
    })

    it('reads SOL and token balances, zero without a token account', async () => {
        const balances = (account: unknown) =>
            transport({
                getBalance: () => ({ value: 51_000_000 }),
                getAccountInfo: () => ({ value: account }),
            })
        await expect(
            getSolanaWalletBalances(
                balances({
                    data: {
                        parsed: {
                            info: { tokenAmount: { amount: '400000000' } },
                        },
                    },
                }),
                { owner: wallet, asset: 'sn80' }
            )
        ).resolves.toEqual({
            lamports: 51_000_000n,
            tokenAccount: '6Lc4TvRD9H5oCodVJdkLrvj9GgMVZFvgY8mfTaUkfFWC',
            tokenWei: 4n * 10n ** 17n,
        })
        await expect(
            getSolanaWalletBalances(balances(null), {
                owner: wallet,
                asset: 'sn80',
            })
        ).resolves.toMatchObject({ tokenWei: 0n })
    })

    it('tracks delivery on Subtensor and reports V7 gateway recovery', async () => {
        const alphaGatewayAbi = parseAbi(ALPHA_GATEWAY_ABI)
        const execution = {
            transactionHash: `0x${'33'.repeat(32)}`,
            blockNumber: 1n,
            logIndex: 0,
            args: { state: 2 },
        }
        const claimable = {
            address: subtensor.contracts.svmGateway,
            ...eventLog(alphaGatewayAbi, 'Claimable', [
                subtensor.contracts.wrappedSn80,
                evmFallback,
                0n,
                10n,
            ]),
        }
        const client = (receiptLogs: unknown[]) =>
            ({
                getChainId: vi.fn(async () => 964),
                readContract: vi.fn(async () => []),
                getLogs: vi.fn(async () => [execution]),
                getTransactionReceipt: vi.fn(async () => ({
                    logs: receiptLogs,
                })),
            }) as unknown as PublicClient
        const input = {
            direction: 'solana-to-subtensor' as const,
            messageId,
            fromBlock: 1,
        }
        const recovering = client([claimable])
        await expect(getCcipDeliveryStatus(recovering, input)).resolves.toBe(
            'recovery'
        )
        expect(recovering.getLogs).toHaveBeenCalledWith(
            expect.objectContaining({
                address: subtensor.contracts.ccipOffRampFromSolana,
                args: { sourceChainSelector: SOLANA_CCIP_SELECTOR, messageId },
            })
        )
        await expect(getCcipDeliveryStatus(client([]), input)).resolves.toBe(
            'success'
        )
        expect(destinationChainId('solana-to-subtensor')).toBe(964)
        expect(() => sourceChainId('solana-to-subtensor')).toThrow(
            /getSolanaSourceStatus/
        )
        expect(() =>
            bridgeMessageIdFromReceipt('solana-to-subtensor', { logs: [] })
        ).toThrow(/getSolanaSourceStatus/)
    })
})
