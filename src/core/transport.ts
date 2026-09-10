import { createPublicClient, custom, type PublicClient } from 'viem'
import { ForeverMoneyError } from './errors.js'

export interface RpcRequest {
    readonly method: string
    readonly params?: readonly unknown[] | Record<string, unknown>
}

export interface RpcTransport {
    request(request: RpcRequest): Promise<unknown>
}

export interface HttpTransportOptions {
    readonly timeoutMs?: number
    readonly fetch?: typeof globalThis.fetch
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function invalidJsonRpcResponse(): ForeverMoneyError {
    return new ForeverMoneyError(
        'RPC_ERROR',
        'RPC returned an invalid JSON-RPC response.'
    )
}

function isLoopback(endpoint: URL): boolean {
    return (
        endpoint.hostname === 'localhost' ||
        endpoint.hostname === '127.0.0.1' ||
        endpoint.hostname === '[::1]'
    )
}

function jsonRpcResult(body: unknown, expectedId: number): unknown {
    if (!isRecord(body) || body.jsonrpc !== '2.0' || body.id !== expectedId) {
        throw invalidJsonRpcResponse()
    }
    if (body.error !== undefined) {
        if (
            !isRecord(body.error) ||
            !Number.isInteger(body.error.code) ||
            typeof body.error.message !== 'string'
        ) {
            throw invalidJsonRpcResponse()
        }
        throw new ForeverMoneyError('RPC_ERROR', body.error.message, {
            rpcCode: body.error.code,
            ...(body.error.data === undefined
                ? {}
                : { rpcData: body.error.data }),
        })
    }
    if (!Object.prototype.hasOwnProperty.call(body, 'result')) {
        throw invalidJsonRpcResponse()
    }
    return body.result
}

export function http(
    url: string,
    options: HttpTransportOptions = {}
): RpcTransport {
    let endpoint: URL
    try {
        endpoint = new URL(url)
    } catch {
        throw new ForeverMoneyError('RPC_ERROR', 'RPC URL is invalid.')
    }
    if (endpoint.protocol !== 'https:' && endpoint.protocol !== 'http:') {
        throw new ForeverMoneyError(
            'RPC_ERROR',
            'RPC URL must use HTTP or HTTPS.'
        )
    }
    if (endpoint.protocol === 'http:' && !isLoopback(endpoint)) {
        throw new ForeverMoneyError(
            'RPC_ERROR',
            'Non-local RPC URLs must use HTTPS.'
        )
    }

    const timeoutMs = options.timeoutMs ?? 15_000
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
        throw new ForeverMoneyError(
            'RPC_ERROR',
            'RPC timeout must be a positive integer.'
        )
    }
    const fetchImplementation = options.fetch ?? globalThis.fetch
    if (typeof fetchImplementation !== 'function') {
        throw new ForeverMoneyError(
            'RPC_ERROR',
            'This runtime does not provide fetch. Pass an explicit fetch implementation.'
        )
    }

    let requestId = 0
    return Object.freeze({
        async request(request: RpcRequest): Promise<unknown> {
            if (
                !isRecord(request) ||
                typeof request.method !== 'string' ||
                request.method.length === 0
            ) {
                throw new ForeverMoneyError(
                    'RPC_ERROR',
                    'RPC method must be a non-empty string.'
                )
            }
            if (
                request.params !== undefined &&
                !Array.isArray(request.params) &&
                !isRecord(request.params)
            ) {
                throw new ForeverMoneyError(
                    'RPC_ERROR',
                    'RPC params must be an array or object.'
                )
            }
            const controller = new AbortController()
            const timer = setTimeout(() => controller.abort(), timeoutMs)
            const id = ++requestId
            try {
                const response = await fetchImplementation(endpoint, {
                    method: 'POST',
                    headers: { 'content-type': 'application/json' },
                    body: JSON.stringify({
                        jsonrpc: '2.0',
                        id,
                        method: request.method,
                        params: request.params ?? [],
                    }),
                    signal: controller.signal,
                })
                if (!response.ok) {
                    throw new ForeverMoneyError(
                        'RPC_ERROR',
                        `RPC returned HTTP ${response.status}.`,
                        { status: response.status }
                    )
                }
                return jsonRpcResult(await response.json(), id)
            } catch (error) {
                if (error instanceof ForeverMoneyError) throw error
                const message =
                    error instanceof Error && error.name === 'AbortError'
                        ? `RPC request timed out after ${timeoutMs}ms.`
                        : 'RPC request failed.'
                throw new ForeverMoneyError('RPC_ERROR', message)
            } finally {
                clearTimeout(timer)
            }
        },
    })
}

export function providerFromTransport(transport: RpcTransport): PublicClient {
    if (!transport || typeof transport.request !== 'function') {
        throw new ForeverMoneyError(
            'MISSING_TRANSPORT',
            'An EIP-1193-compatible RPC transport is required.'
        )
    }
    return createPublicClient({
        transport: custom(transport, { retryCount: 0 }),
        cacheTime: 0,
        batch: { multicall: false },
    })
}

/** Minimal structural interface implemented by ethers JSON-RPC providers. */
export interface LegacyRpcProvider {
    send(method: string, params: unknown[]): Promise<unknown>
}

export type TrackingProvider = PublicClient | LegacyRpcProvider

/** Adapt legacy providers without importing ethers or changing their RPC endpoint. */
export function trackingClient(provider: TrackingProvider): PublicClient {
    if (
        provider &&
        'getChainId' in provider &&
        typeof provider.getChainId === 'function'
    )
        return provider
    if (provider && 'send' in provider && typeof provider.send === 'function') {
        return providerFromTransport({
            request: ({ method, params }) => {
                if (params !== undefined && !Array.isArray(params))
                    throw new ForeverMoneyError(
                        'RPC_ERROR',
                        'Tracking RPC params must be an array.'
                    )
                return provider.send(
                    method,
                    params === undefined
                        ? []
                        : [...(params as readonly unknown[])]
                )
            },
        })
    }
    throw new ForeverMoneyError(
        'MISSING_TRANSPORT',
        'A viem public client or JSON-RPC provider is required.'
    )
}
