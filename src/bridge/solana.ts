import { base58, base64 } from '@scure/base'
import { bytesToHex } from 'viem'
import { foreverMoneyDeployment } from '../chains/deployment.js'
import { ForeverMoneyError } from '../core/errors.js'
import {
    getSolanaAssociatedTokenAddress,
    normalizeSolanaWallet,
} from '../core/solana.js'
import type { RpcTransport } from '../core/transport.js'
import { normalizeBytes32 } from '../core/validation.js'
import { assetToken, type BridgeAsset } from './assets.js'
import type { CcipDeliveryStatus } from './tracking.js'

const COMMITMENT = 'confirmed'
// Anchor event discriminator: sha256("event:ExecutionStateChanged")[0..8].
const EXECUTION_STATE_CHANGED = 'b9b08c70ef4e1ff9'
// discriminator | sourceChainSelector u64 | sequenceNumber u64 | messageId | messageHash | state u8
const EXECUTION_STATE_CHANGED_BYTES = 8 + 8 + 8 + 32 + 32 + 1
const EXECUTION_STATE_SUCCESS = 2
const EXECUTION_STATE_FAILURE = 3
const SIGNATURE_PAGE_SIZE = 100
// Bounds a status check on a busy token account; past this the message is
// reported as still waiting rather than scanning history without limit.
const MAX_SIGNATURE_PAGES = 5

/** Resolve an asset that is deployed on Solana: its SPL mint and Subtensor token. */
export function solanaBridgeAsset(asset: BridgeAsset = 'tao') {
    const mint = assetToken<string>(
        foreverMoneyDeployment.solana.contracts,
        asset
    )
    const subtensorToken = assetToken<`0x${string}`>(
        foreverMoneyDeployment.subtensor.contracts,
        asset
    )
    if (!mint || !subtensorToken) {
        throw new ForeverMoneyError(
            'INVALID_TRANSACTION_PLAN',
            `${asset.toUpperCase()} bridging is not supported on solana.`
        )
    }
    return { mint, subtensorToken, label: asset.toUpperCase() }
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function invalidResponse(message: string): ForeverMoneyError {
    return new ForeverMoneyError('INVALID_PROVIDER_RESPONSE', message)
}

export interface SolanaTokenAccountRequest {
    /** The Solana wallet that will receive the bridged tokens. */
    readonly owner: string
    readonly asset?: BridgeAsset
}

export interface SolanaTokenAccountStatus {
    readonly owner: string
    readonly mint: string
    readonly tokenAccount: string
    readonly exists: boolean
}

/**
 * Whether `owner` already has the associated token account CCIP delivers to.
 * Bridging to a wallet without one leaves the message unexecuted on Solana
 * until the account is created and the message is manually executed.
 */
export async function getSolanaTokenAccountStatus(
    transport: RpcTransport,
    input: SolanaTokenAccountRequest
): Promise<SolanaTokenAccountStatus> {
    const owner = normalizeSolanaWallet(input.owner)
    const { mint } = solanaBridgeAsset(input.asset)
    const tokenAccount = getSolanaAssociatedTokenAddress(owner, mint)
    const result = await transport.request({
        method: 'getAccountInfo',
        params: [tokenAccount, { encoding: 'base64', commitment: COMMITMENT }],
    })
    if (!isRecord(result) || !('value' in result)) {
        throw invalidResponse(
            'Solana getAccountInfo returned an invalid result.'
        )
    }
    const account = result.value
    if (account !== null) {
        if (!isRecord(account) || typeof account.owner !== 'string') {
            throw invalidResponse('Solana token account data is invalid.')
        }
        // Only the SPL Token program can own an associated token account.
        if (
            account.owner !==
            foreverMoneyDeployment.solana.contracts.tokenProgram
        ) {
            throw invalidResponse(
                'The Solana token account is not owned by the SPL Token program.'
            )
        }
    }
    return Object.freeze({
        owner,
        mint,
        tokenAccount,
        exists: account !== null,
    })
}

/** Throws `SOLANA_TOKEN_ACCOUNT_MISSING` unless the recipient's token account exists. */
export async function assertSolanaTokenAccount(
    transport: RpcTransport,
    input: SolanaTokenAccountRequest
): Promise<SolanaTokenAccountStatus> {
    const status = await getSolanaTokenAccountStatus(transport, input)
    if (!status.exists) {
        throw new ForeverMoneyError(
            'SOLANA_TOKEN_ACCOUNT_MISSING',
            'The Solana recipient has no token account for this asset. Create it (buildCreateSolanaTokenAccountInstruction) before bridging.',
            {
                owner: status.owner,
                mint: status.mint,
                tokenAccount: status.tokenAccount,
            }
        )
    }
    return status
}

interface SignatureInfo {
    readonly signature: string
    readonly err: unknown
}

async function signaturesFor(
    transport: RpcTransport,
    address: string,
    options: { limit: number; until?: string; before?: string }
): Promise<SignatureInfo[]> {
    const result = await transport.request({
        method: 'getSignaturesForAddress',
        params: [address, { ...options, commitment: COMMITMENT }],
    })
    if (
        !Array.isArray(result) ||
        !result.every(
            (item) => isRecord(item) && typeof item.signature === 'string'
        )
    ) {
        throw invalidResponse(
            'Solana getSignaturesForAddress returned an invalid result.'
        )
    }
    return result as SignatureInfo[]
}

export interface SolanaDeliveryCheckpointRequest {
    readonly recipient: string
    readonly asset?: BridgeAsset
}

export interface SolanaDeliveryCheckpoint {
    readonly tokenAccount: string
    /** Newest signature on the token account before the bridge; null when it has none. */
    readonly untilSignature: string | null
}

/**
 * Capture where to start looking for the delivery: the token account's newest
 * transaction. Take it before sending the bridge, like an EVM `fromBlock`.
 */
export async function getSolanaDeliveryCheckpoint(
    transport: RpcTransport,
    input: SolanaDeliveryCheckpointRequest
): Promise<SolanaDeliveryCheckpoint> {
    const recipient = normalizeSolanaWallet(input.recipient)
    const { mint } = solanaBridgeAsset(input.asset)
    const tokenAccount = getSolanaAssociatedTokenAddress(recipient, mint)
    const [latest] = await signaturesFor(transport, tokenAccount, { limit: 1 })
    return Object.freeze({
        tokenAccount,
        untilSignature: latest?.signature ?? null,
    })
}

export interface SolanaDeliveryStatusRequest {
    readonly messageId: string
    readonly recipient: string
    readonly asset?: BridgeAsset
    /** From `getSolanaDeliveryCheckpoint`; null scans the account's recent history. */
    readonly untilSignature: string | null
}

/**
 * The CCIP off-ramp's ExecutionStateChanged states for `messageId` in one
 * transaction, oldest first. Only events the off-ramp program itself emitted
 * count: another program in the same transaction could log identical bytes.
 */
function executionStates(logs: readonly string[], messageId: string): number[] {
    const { ccipOffRamp } = foreverMoneyDeployment.solana.contracts
    const sourceSelector = foreverMoneyDeployment.subtensor.ccipSelector
    const stack: string[] = []
    const states: number[] = []
    for (const line of logs) {
        const invoke = /^Program (\w+) invoke \[\d+\]$/.exec(line)
        if (invoke) {
            stack.push(invoke[1]!)
            continue
        }
        if (/^Program \w+ (success|failed)/.test(line)) {
            stack.pop()
            continue
        }
        if (!line.startsWith('Program data: ') || stack.at(-1) !== ccipOffRamp)
            continue
        let data: Uint8Array
        try {
            data = base64.decode(line.slice('Program data: '.length))
        } catch {
            continue
        }
        if (
            data.length !== EXECUTION_STATE_CHANGED_BYTES ||
            bytesToHex(data.subarray(0, 8)).slice(2) !== EXECUTION_STATE_CHANGED
        )
            continue
        const view = new DataView(data.buffer, data.byteOffset, data.length)
        if (view.getBigUint64(8, true) !== sourceSelector) continue
        if (bytesToHex(data.subarray(24, 56)) !== messageId) continue
        states.push(data[88]!)
    }
    return states
}

async function transactionLogs(
    transport: RpcTransport,
    signature: string
): Promise<readonly string[]> {
    const result = await transport.request({
        method: 'getTransaction',
        params: [
            signature,
            {
                encoding: 'json',
                commitment: COMMITMENT,
                maxSupportedTransactionVersion: 0,
            },
        ],
    })
    if (result === null) return []
    if (
        !isRecord(result) ||
        !isRecord(result.meta) ||
        !Array.isArray(result.meta.logMessages)
    ) {
        throw invalidResponse(
            'Solana getTransaction returned an invalid result.'
        )
    }
    return result.meta.logMessages.filter(
        (line): line is string => typeof line === 'string'
    )
}

/**
 * Delivery status of a Subtensor-to-Solana message, read from the CCIP
 * off-ramp's execution events on the recipient's token account.
 */
export async function getSolanaDeliveryStatus(
    transport: RpcTransport,
    input: SolanaDeliveryStatusRequest
): Promise<CcipDeliveryStatus> {
    const messageId = normalizeBytes32(input.messageId, 'CCIP message ID')
    const recipient = normalizeSolanaWallet(input.recipient)
    const until =
        input.untilSignature === null
            ? undefined
            : normalizeSolanaSignature(input.untilSignature)
    const { mint } = solanaBridgeAsset(input.asset)
    const tokenAccount = getSolanaAssociatedTokenAddress(recipient, mint)
    let before: string | undefined
    for (let page = 0; page < MAX_SIGNATURE_PAGES; page++) {
        const signatures = await signaturesFor(transport, tokenAccount, {
            limit: SIGNATURE_PAGE_SIZE,
            ...(until === undefined ? {} : { until }),
            ...(before === undefined ? {} : { before }),
        })
        // Newest first: the first transaction carrying the message holds its
        // latest state. Reverted transactions emit nothing that sticks.
        for (const { signature, err } of signatures) {
            if (err !== null) continue
            const states = executionStates(
                await transactionLogs(transport, signature),
                messageId
            )
            const state = states.at(-1)
            if (state === EXECUTION_STATE_SUCCESS) return 'success'
            if (state === EXECUTION_STATE_FAILURE) return 'failure'
        }
        if (signatures.length < SIGNATURE_PAGE_SIZE) break
        before = signatures.at(-1)!.signature
    }
    return 'waiting'
}

const SOLANA_SIGNATURE_BYTES = 64

function normalizeSolanaSignature(value: string): string {
    let bytes: Uint8Array | undefined
    try {
        bytes = base58.decode(value)
    } catch {
        bytes = undefined
    }
    if (bytes?.length !== SOLANA_SIGNATURE_BYTES) {
        throw new ForeverMoneyError(
            'INVALID_TRANSACTION_PLAN',
            'untilSignature must be a base58 Solana transaction signature.'
        )
    }
    return base58.encode(bytes)
}
