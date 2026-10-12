import { decodeFunctionData, parseAbi, type Hex, type PublicClient } from 'viem'
import { describe, expect, it, vi } from 'vitest'
import { ALPHA_GATEWAY_ABI, STAKING_ABI } from '../abis/index.js'
import {
    EVM_WEI_PER_RAO,
    SOLANA_CCIP_SELECTOR,
    bridgeMessageIdFromReceipt,
    buildSubtensorToSolanaPlan,
    destinationChainId,
    foreverMoneyDeployment,
    sourceChainId,
    type SubtensorToSolanaRequest,
} from '../index.js'
import type { RpcRequest, RpcTransport } from '../core/transport.js'
import { prepareSubtensorToSolana } from './plans.js'
import {
    getSolanaDeliveryStatus,
    getSolanaTokenAccountStatus,
} from './solana.js'

const { subtensor, solana } = foreverMoneyDeployment
const alphaAbi = parseAbi(ALPHA_GATEWAY_ABI)
const stakingAbi = parseAbi(STAKING_ABI)
const sender = '0x5A16F43BD0F0CaD4d637244Fa9E7749a86270583'
// Live round trip of 8 Oct 2026: the deployer wallet and its SN80 account.
const wallet = 'BQHhumdtyfPF3cRBqFUQVsH7TM6xX7KEaz7SNTYzq5nm'
const walletBytes32 =
    '0x9a8c1ddd95b372d5ce3fc93a232a4d91dc4487d5344f89a93e4a0eda124ddd5e'
const tokenAccount = '6Lc4TvRD9H5oCodVJdkLrvj9GgMVZFvgY8mfTaUkfFWC'
const messageId =
    '0x4a79e611c9a5f91b47f51e2c989ca5e84eb4c3e5d5eb70d4f6c9489009a0c620'
const amountWei = 10n * 10n ** 18n
const amountRao = amountWei / EVM_WEI_PER_RAO
const toSolana: SubtensorToSolanaRequest = {
    asset: 'sn80',
    sender,
    recipient: wallet,
    amountWei,
    source: 'staked',
}

function solanaTransport(
    handlers: Record<string, (params: readonly unknown[]) => unknown>
): RpcTransport & { request: ReturnType<typeof vi.fn> } {
    return {
        request: vi.fn(async ({ method, params }: RpcRequest) => {
            const handler = handlers[method]
            if (!handler) throw new Error(`Unexpected Solana RPC ${method}`)
            return handler((params ?? []) as readonly unknown[])
        }),
    }
}

describe('Subtensor to Solana plans', () => {
    it('approves the V7 gateway and encodes bridgeOutSvm to the wallet', () => {
        const plan = buildSubtensorToSolanaPlan({
            ...toSolana,
            stakingAllowanceRao: 0n,
            exactNetworkFeeWei: 100n,
        })
        expect(plan.action).toBe('bridge.subtensor-to-solana')
        const [approval, transfer] = plan.steps
        expect(approval!.transaction.to).toBe(
            subtensor.contracts.stakingPrecompile
        )
        expect(
            decodeFunctionData({
                abi: stakingAbi,
                data: approval!.transaction.data as Hex,
            }).args
        ).toEqual([subtensor.contracts.svmGateway, 80n, amountRao])
        expect(transfer!.transaction.to).toBe(subtensor.contracts.svmGateway)
        expect(transfer!.transaction.value).toBe('102')
        const call = decodeFunctionData({
            abi: alphaAbi,
            data: transfer!.transaction.data as Hex,
        })
        expect(call.functionName).toBe('bridgeOutSvm')
        expect(call.args).toEqual([
            SOLANA_CCIP_SELECTOR,
            subtensor.contracts.wrappedSn80,
            walletBytes32,
            0n,
            amountRao,
            amountWei,
        ])
        expect(plan.summary).toContain(`to ${wallet} on Solana`)
    })

    it('pulls named stake positions through bridgeOutFromValidatorsSvm', () => {
        const hotkey = `0x${'ab'.repeat(32)}`
        const plan = buildSubtensorToSolanaPlan({
            ...toSolana,
            stakePulls: [{ hotkey, amountRao }],
            stakingAllowanceRao: amountRao,
            exactNetworkFeeWei: 100n,
        })
        expect(plan.steps).toHaveLength(1)
        const call = decodeFunctionData({
            abi: alphaAbi,
            data: plan.steps[0]!.transaction.data as Hex,
        })
        expect(call.functionName).toBe('bridgeOutFromValidatorsSvm')
        expect(call.args).toEqual([
            SOLANA_CCIP_SELECTOR,
            subtensor.contracts.wrappedSn80,
            walletBytes32,
            0n,
            [{ validator: hotkey, alphaRao: amountRao }],
            amountWei,
        ])
    })

    it('rejects token-account recipients, partner fees and assets not on Solana', () => {
        const build = (input: Partial<SubtensorToSolanaRequest>) => () =>
            buildSubtensorToSolanaPlan({
                ...toSolana,
                ...input,
                stakingAllowanceRao: amountRao,
                exactNetworkFeeWei: 1n,
            })
        expect(build({ recipient: tokenAccount })).toThrow(
            expect.objectContaining({ code: 'INVALID_SOLANA_ADDRESS' })
        )
        expect(build({ recipient: sender })).toThrow(
            expect.objectContaining({ code: 'INVALID_SOLANA_ADDRESS' })
        )
        expect(
            build({
                partnerFee: { recipient: sender, bps: 10 },
            } as Partial<SubtensorToSolanaRequest>)
        ).toThrow(expect.objectContaining({ code: 'INVALID_PARTNER_FEE' }))
        expect(build({ asset: 'tao', source: 'liquid' })).toThrow(
            /not supported on solana/
        )
        expect(build({ source: 'liquid' })).toThrow(/requires staked subnet/)
    })
})

describe('Subtensor to Solana preparation', () => {
    it('refuses to prepare until the recipient token account exists', async () => {
        const readContract = vi.fn()
        const transport = solanaTransport({
            getAccountInfo: () => ({ context: { slot: 1 }, value: null }),
        })
        await expect(
            prepareSubtensorToSolana(
                {
                    subtensor: { readContract } as unknown as PublicClient,
                    solana: transport,
                },
                toSolana
            )
        ).rejects.toMatchObject({
            code: 'SOLANA_TOKEN_ACCOUNT_MISSING',
            details: {
                owner: wallet,
                mint: solana.contracts.wrappedSn80,
                tokenAccount,
            },
        })
        expect(transport.request).toHaveBeenCalledWith({
            method: 'getAccountInfo',
            params: [
                tokenAccount,
                { encoding: 'base64', commitment: 'confirmed' },
            ],
        })
        expect(readContract).not.toHaveBeenCalled()
    })

    it('quotes and checks the allowance against the V7 gateway', async () => {
        const readContract = vi.fn(async ({ functionName }) =>
            functionName === 'quoteBridgeOutSvm' ? 100n : amountRao
        )
        const estimateGas = vi.fn(async () => 1000n)
        const result = await prepareSubtensorToSolana(
            {
                subtensor: {
                    readContract,
                    estimateGas,
                } as unknown as PublicClient,
                solana: solanaTransport({
                    getAccountInfo: () => ({
                        value: { owner: solana.contracts.tokenProgram },
                    }),
                }),
            },
            toSolana
        )
        expect(readContract).toHaveBeenCalledWith(
            expect.objectContaining({
                address: subtensor.contracts.svmGateway,
                functionName: 'quoteBridgeOutSvm',
                args: [
                    SOLANA_CCIP_SELECTOR,
                    subtensor.contracts.wrappedSn80,
                    walletBytes32,
                    amountWei,
                ],
            })
        )
        expect(readContract).toHaveBeenCalledWith(
            expect.objectContaining({
                functionName: 'allowance',
                args: [sender, subtensor.contracts.svmGateway, 80n],
            })
        )
        expect(estimateGas).toHaveBeenCalledWith(
            expect.objectContaining({ to: subtensor.contracts.svmGateway })
        )
        expect(result.solanaTokenAccount).toBe(tokenAccount)
        expect(result.exactNetworkFeeWei).toBe(100n)
        expect(result.plan.steps).toHaveLength(1)
    })

    it('rejects an account not owned by the SPL Token program', async () => {
        await expect(
            getSolanaTokenAccountStatus(
                solanaTransport({
                    getAccountInfo: () => ({
                        value: { owner: '11111111111111111111111111111111' },
                    }),
                }),
                { owner: wallet, asset: 'sn80' }
            )
        ).rejects.toMatchObject({ code: 'INVALID_PROVIDER_RESPONSE' })
    })
})

describe('Subtensor to Solana tracking', () => {
    // BridgedOutSvm from the live v7 bridge-out (964 tx 0xd1cba62d…).
    const bridgedOutSvm = {
        address: '0x2e8219ccf00abaf3fedda2c932eced56654aaf38',
        topics: [
            '0x79b26093e437a77f58c4ecf6f4ab011f908e812c08c8104ecd95b095630c8732',
            '0x00000000000000000000000000000000000000000000000001bab8fb6197c9e7',
            '0x000000000000000000000000fd628de75ef96f0a5c59659159c6ca81e0dc2222',
            '0x0000000000000000000000005a16f43bd0f0cad4d637244fa9e7749a86270583',
        ],
        data: `${walletBytes32}0000000000000000000000000000000000000000000000000b2bc2fcee389c00${messageId.slice(2)}`,
    }

    it('reads the message ID from the V7 gateway event only', () => {
        expect(
            bridgeMessageIdFromReceipt('subtensor-to-solana', {
                logs: [bridgedOutSvm],
            })
        ).toBe(messageId)
        expect(
            bridgeMessageIdFromReceipt('subtensor-to-solana', {
                logs: [
                    { ...bridgedOutSvm, address: subtensor.contracts.gateway },
                ],
            })
        ).toBeNull()
        expect(sourceChainId('subtensor-to-solana')).toBe(subtensor.chainId)
        expect(() => destinationChainId('subtensor-to-solana')).toThrow(
            /getSolanaDeliveryStatus/
        )
    })

    // Off-ramp execution of that message on Solana (sig 2QwZDbvv…).
    const offRamp = solana.contracts.ccipOffRamp
    const pool = '41FGToCmdaWa1dgZLKFAjvmx6e6AjVTX7SVRibvsMGVB'
    const inProgress =
        'Program data: ubCMcO9OH/k4pW8cuGyhHQIAAAAAAAAASnnmEcml+RtH9R4smJyl6E60w+XV63DU9slIkAmgxiBKmOeBZTB+dRTBXM6pD1QYxrR5mu6KP1wuAJfACwGOLwE='
    const success =
        'Program data: ubCMcO9OH/k4pW8cuGyhHQIAAAAAAAAASnnmEcml+RtH9R4smJyl6E60w+XV63DU9slIkAmgxiBKmOeBZTB+dRTBXM6pD1QYxrR5mu6KP1wuAJfACwGOLwI='
    const deliveryLogs = [
        `Program ${offRamp} invoke [1]`,
        'Program log: Instruction: Execute',
        inProgress,
        `Program ${pool} invoke [2]`,
        'Program log: Instruction: ReleaseOrMintTokens',
        `Program ${pool} success`,
        success,
        `Program ${offRamp} success`,
    ]
    const signature =
        '2QwZDbvvJhcVqG4VHXs4KYR254S3BrNTUNJc6bbYRe2xfF7KPtknfbWS7twXpqtcSLVHUYtA34Fvum17WQBhkpMf'

    function trackingTransport(logs: readonly string[]) {
        return solanaTransport({
            getSignaturesForAddress: ([address]) => {
                expect(address).toBe(tokenAccount)
                return [{ signature, err: null }]
            },
            getTransaction: () => ({ meta: { logMessages: logs } }),
        })
    }
    const request = {
        messageId,
        recipient: wallet,
        asset: 'sn80' as const,
        untilSignature: null,
    }

    it('reports success from the off-ramp execution event', async () => {
        expect(
            await getSolanaDeliveryStatus(
                trackingTransport(deliveryLogs),
                request
            )
        ).toBe('success')
    })

    it('ignores the same bytes logged by any other program', async () => {
        const spoofed = [
            `Program ${pool} invoke [1]`,
            success,
            `Program ${pool} success`,
        ]
        expect(
            await getSolanaDeliveryStatus(trackingTransport(spoofed), request)
        ).toBe('waiting')
    })

    it('waits while only an in-progress state exists, or for other messages', async () => {
        expect(
            await getSolanaDeliveryStatus(
                trackingTransport(deliveryLogs.filter((l) => l !== success)),
                request
            )
        ).toBe('waiting')
        expect(
            await getSolanaDeliveryStatus(trackingTransport(deliveryLogs), {
                ...request,
                messageId: `0x${'11'.repeat(32)}`,
            })
        ).toBe('waiting')
    })
})
