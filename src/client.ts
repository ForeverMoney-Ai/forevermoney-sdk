import type { PublicClient } from 'viem'
import {
    prepareBaseToSubtensor,
    prepareEvmToSubtensor,
    prepareSubtensorToBase,
    prepareSubtensorToEvm,
    prepareSubtensorToSolana,
    type BaseToSubtensorRequest,
    type BridgePreparation,
    type EvmToSubtensorRequest,
    type SolanaBridgePreparation,
    type SubtensorToBaseRequest,
    type SubtensorToEvmRequest,
    type SubtensorToSolanaRequest,
} from './bridge/plans.js'
import {
    getSolanaDeliveryCheckpoint,
    getSolanaDeliveryStatus,
    getSolanaSourceStatus,
    getSolanaTokenAccountStatus,
    getSolanaWalletBalances,
    type SolanaSourceStatus,
    type SolanaSourceStatusRequest,
    type SolanaWalletBalances,
    type SolanaWalletBalancesRequest,
    type SolanaDeliveryCheckpoint,
    type SolanaDeliveryCheckpointRequest,
    type SolanaDeliveryStatusRequest,
    type SolanaTokenAccountRequest,
    type SolanaTokenAccountStatus,
} from './bridge/solana.js'
import {
    prepareBaseToBerachain,
    prepareBerachainToBase,
    type RoyaltyBridgePreparation,
    type RoyaltyBridgeRequest,
} from './bridge/royalty.js'
import {
    BASE_CHAIN_ID,
    BERACHAIN_CHAIN_ID,
    ROBINHOOD_CHAIN_ID,
    SUBTENSOR_CHAIN_ID,
    getForeverMoneyEvmDeployment,
} from './chains/deployment.js'
import { ForeverMoneyError } from './core/errors.js'
import { providerFromTransport, type RpcTransport } from './core/transport.js'
import { providerOperation } from './core/provider-errors.js'
import {
    prepareCreateVault,
    prepareDepositVault,
    type CreateVaultRequest,
    type DepositVaultRequest,
} from './vaults/plans.js'
import type { TransactionPlan } from './core/plans.js'
import {
    destinationChainId,
    getBridgeSourceStatus,
    getCcipDeliveryCheckpoint,
    getCcipDeliveryStatus,
    sourceChainId,
    type BridgeSourceStatus,
    type BridgeSourceStatusRequest,
    type CcipDeliveryCheckpoint,
    type CcipDeliveryStatus,
    type CcipDeliveryStatusRequest,
} from './bridge/tracking.js'
import type { BridgeDirection } from './bridge/receipts.js'

export interface ForeverMoneyClientOptions {
    readonly transports: {
        readonly base: RpcTransport
        readonly robinhood?: RpcTransport
        /** Berachain EVM; required only for Berachain routes. */
        readonly berachain?: RpcTransport
        readonly subtensor: RpcTransport
        /** Solana JSON-RPC; required only for Solana routes. */
        readonly solana?: RpcTransport
    }
}

export interface ForeverMoneyClient {
    readonly bridge: {
        prepareEvmToSubtensor(
            input: EvmToSubtensorRequest
        ): Promise<BridgePreparation>
        prepareBaseToSubtensor(
            input: BaseToSubtensorRequest
        ): Promise<BridgePreparation>
        prepareSubtensorToEvm(
            input: SubtensorToEvmRequest
        ): Promise<BridgePreparation>
        prepareSubtensorToBase(
            input: SubtensorToBaseRequest
        ): Promise<BridgePreparation>
        prepareSubtensorToSolana(
            input: SubtensorToSolanaRequest
        ): Promise<SolanaBridgePreparation>
        prepareBaseToBerachain(
            input: RoyaltyBridgeRequest
        ): Promise<RoyaltyBridgePreparation>
        prepareBerachainToBase(
            input: RoyaltyBridgeRequest
        ): Promise<RoyaltyBridgePreparation>
        getSolanaTokenAccountStatus(
            input: SolanaTokenAccountRequest
        ): Promise<SolanaTokenAccountStatus>
        getSolanaDeliveryCheckpoint(
            input: SolanaDeliveryCheckpointRequest
        ): Promise<SolanaDeliveryCheckpoint>
        getSolanaDeliveryStatus(
            input: SolanaDeliveryStatusRequest
        ): Promise<CcipDeliveryStatus>
        getSolanaSourceStatus(
            input: SolanaSourceStatusRequest
        ): Promise<SolanaSourceStatus>
        getSolanaWalletBalances(
            input: SolanaWalletBalancesRequest
        ): Promise<SolanaWalletBalances>
        getDeliveryCheckpoint(
            direction: BridgeDirection
        ): Promise<CcipDeliveryCheckpoint>
        getDeliveryStatus(
            input: CcipDeliveryStatusRequest
        ): Promise<CcipDeliveryStatus>
        getSourceStatus(
            input: BridgeSourceStatusRequest
        ): Promise<BridgeSourceStatus>
    }
    readonly vaults: {
        prepareCreate(input: CreateVaultRequest): Promise<TransactionPlan>
        prepareDeposit(input: DepositVaultRequest): Promise<TransactionPlan>
    }
    verifyConnections(): Promise<void>
}

async function assertProviderChain(
    provider: PublicClient,
    expectedChainId: number,
    name: string
): Promise<void> {
    const chainId = await providerOperation(
        `Reading the ${name} chain ID`,
        () => provider.getChainId()
    )
    if (chainId !== expectedChainId) {
        throw new ForeverMoneyError(
            'CHAIN_MISMATCH',
            `${name} transport reported chain ID ${chainId}; expected ${expectedChainId}.`,
            {
                expectedChainId,
                actualChainId: chainId.toString(),
            }
        )
    }
}

export function createForeverMoneyClient(
    options: ForeverMoneyClientOptions
): ForeverMoneyClient {
    if (!options?.transports?.base || !options.transports.subtensor) {
        throw new ForeverMoneyError(
            'MISSING_TRANSPORT',
            'Base and Subtensor transports are required.'
        )
    }
    const baseProvider = providerFromTransport(options.transports.base)
    const subtensorProvider = providerFromTransport(
        options.transports.subtensor
    )
    const robinhoodProvider = options.transports.robinhood
        ? providerFromTransport(options.transports.robinhood)
        : undefined
    const berachainProvider = options.transports.berachain
        ? providerFromTransport(options.transports.berachain)
        : undefined
    const solanaTransport = (): RpcTransport => {
        if (options.transports.solana === undefined) {
            throw new ForeverMoneyError(
                'MISSING_TRANSPORT',
                'A Solana transport is required for this operation.'
            )
        }
        return options.transports.solana
    }
    const verifyBaseConnection = async (): Promise<void> => {
        await assertProviderChain(baseProvider, BASE_CHAIN_ID, 'Base')
    }
    const verifySubtensorConnection = async (): Promise<void> => {
        await assertProviderChain(
            subtensorProvider,
            SUBTENSOR_CHAIN_ID,
            'Subtensor'
        )
    }
    const verifyRobinhoodConnection = async (): Promise<void> => {
        if (robinhoodProvider === undefined) return
        await assertProviderChain(
            robinhoodProvider,
            ROBINHOOD_CHAIN_ID,
            'Robinhood'
        )
    }
    const verifyBerachainConnection = async (): Promise<void> => {
        if (berachainProvider === undefined) return
        await assertProviderChain(
            berachainProvider,
            BERACHAIN_CHAIN_ID,
            'Berachain'
        )
    }
    const verifyConnections = async (): Promise<void> => {
        await Promise.all([
            verifyBaseConnection(),
            verifyRobinhoodConnection(),
            verifyBerachainConnection(),
            verifySubtensorConnection(),
        ])
    }
    const providerForChain = (chainId: number): PublicClient => {
        if (chainId === BASE_CHAIN_ID) return baseProvider
        if (chainId === SUBTENSOR_CHAIN_ID) return subtensorProvider
        if (chainId === ROBINHOOD_CHAIN_ID && robinhoodProvider !== undefined) {
            return robinhoodProvider
        }
        if (chainId === BERACHAIN_CHAIN_ID && berachainProvider !== undefined) {
            return berachainProvider
        }
        throw new ForeverMoneyError(
            'MISSING_TRANSPORT',
            `A transport for chain ID ${chainId} is required for this operation.`
        )
    }

    return Object.freeze({
        bridge: Object.freeze({
            async prepareEvmToSubtensor(input: EvmToSubtensorRequest) {
                const evm = getForeverMoneyEvmDeployment(input.evmChain)
                const provider = providerForChain(evm.chainId)
                await assertProviderChain(provider, evm.chainId, evm.name)
                return providerOperation(
                    `Preparing the ${evm.name} to Subtensor bridge`,
                    () => prepareEvmToSubtensor(provider, input)
                )
            },
            async prepareBaseToSubtensor(input: BaseToSubtensorRequest) {
                await verifyBaseConnection()
                return providerOperation(
                    'Preparing the Base to Subtensor bridge',
                    () => prepareBaseToSubtensor(baseProvider, input)
                )
            },
            async prepareSubtensorToEvm(input: SubtensorToEvmRequest) {
                const evm = getForeverMoneyEvmDeployment(input.evmChain)
                await verifySubtensorConnection()
                return providerOperation(
                    `Preparing the Subtensor to ${evm.name} bridge`,
                    () => prepareSubtensorToEvm(subtensorProvider, input)
                )
            },
            async prepareSubtensorToBase(input: SubtensorToBaseRequest) {
                await verifySubtensorConnection()
                return providerOperation(
                    'Preparing the Subtensor to Base bridge',
                    () => prepareSubtensorToBase(subtensorProvider, input)
                )
            },
            async prepareSubtensorToSolana(input: SubtensorToSolanaRequest) {
                const solana = solanaTransport()
                await verifySubtensorConnection()
                return providerOperation(
                    'Preparing the Subtensor to Solana bridge',
                    () =>
                        prepareSubtensorToSolana(
                            { subtensor: subtensorProvider, solana },
                            input
                        )
                )
            },
            async prepareBaseToBerachain(input: RoyaltyBridgeRequest) {
                await verifyBaseConnection()
                return providerOperation(
                    'Preparing the Base to Berachain bridge',
                    () => prepareBaseToBerachain(baseProvider, input)
                )
            },
            async prepareBerachainToBase(input: RoyaltyBridgeRequest) {
                const provider = providerForChain(BERACHAIN_CHAIN_ID)
                await assertProviderChain(
                    provider,
                    BERACHAIN_CHAIN_ID,
                    'Berachain'
                )
                return providerOperation(
                    'Preparing the Berachain to Base bridge',
                    () => prepareBerachainToBase(provider, input)
                )
            },
            async getSolanaTokenAccountStatus(
                input: SolanaTokenAccountRequest
            ) {
                const solana = solanaTransport()
                return providerOperation(
                    'Reading the Solana token account',
                    () => getSolanaTokenAccountStatus(solana, input)
                )
            },
            async getSolanaDeliveryCheckpoint(
                input: SolanaDeliveryCheckpointRequest
            ) {
                const solana = solanaTransport()
                return providerOperation(
                    'Reading the Solana delivery checkpoint',
                    () => getSolanaDeliveryCheckpoint(solana, input)
                )
            },
            async getSolanaDeliveryStatus(input: SolanaDeliveryStatusRequest) {
                const solana = solanaTransport()
                return providerOperation('Reading Solana delivery status', () =>
                    getSolanaDeliveryStatus(solana, input)
                )
            },
            async getSolanaSourceStatus(input: SolanaSourceStatusRequest) {
                const solana = solanaTransport()
                return providerOperation('Reading the Solana send', () =>
                    getSolanaSourceStatus(solana, input)
                )
            },
            async getSolanaWalletBalances(input: SolanaWalletBalancesRequest) {
                const solana = solanaTransport()
                return providerOperation('Reading Solana balances', () =>
                    getSolanaWalletBalances(solana, input)
                )
            },
            async getDeliveryCheckpoint(direction: BridgeDirection) {
                const expectedChainId = destinationChainId(direction)
                const provider = providerForChain(expectedChainId)
                return providerOperation(
                    'Reading the bridge delivery checkpoint',
                    () => getCcipDeliveryCheckpoint(provider, direction)
                )
            },
            async getDeliveryStatus(input: CcipDeliveryStatusRequest) {
                const expectedChainId = destinationChainId(input.direction)
                const provider = providerForChain(expectedChainId)
                return providerOperation('Reading CCIP delivery status', () =>
                    getCcipDeliveryStatus(provider, input)
                )
            },
            async getSourceStatus(input: BridgeSourceStatusRequest) {
                const expectedChainId = sourceChainId(input.direction)
                const provider = providerForChain(expectedChainId)
                return providerOperation(
                    'Reading the bridge source transaction',
                    () => getBridgeSourceStatus(provider, input)
                )
            },
        }),
        vaults: Object.freeze({
            async prepareCreate(input: CreateVaultRequest) {
                await verifyBaseConnection()
                return providerOperation('Preparing vault creation', () =>
                    prepareCreateVault(baseProvider, input)
                )
            },
            async prepareDeposit(input: DepositVaultRequest) {
                await verifyBaseConnection()
                return providerOperation('Preparing the vault deposit', () =>
                    prepareDepositVault(baseProvider, input)
                )
            },
        }),
        verifyConnections,
    })
}
