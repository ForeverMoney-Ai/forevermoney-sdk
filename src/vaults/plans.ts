import {
    encodeFunctionData,
    parseAbi,
    zeroAddress,
    type Address,
    type PublicClient,
} from 'viem'
import {
    ERC20_ABI,
    VAULT_FACTORY_ABI,
    VAULT_MANAGER_ABI,
} from '../abis/index.js'
import { normalizeEvmAddress } from '../core/addresses.js'
import { foreverMoneyDeployment } from '../chains/deployment.js'
import { ForeverMoneyError } from '../core/errors.js'
import {
    createTransactionPlan,
    type TransactionPlan,
    type TransactionStep,
} from '../core/plans.js'
import {
    assertArray,
    assertBoolean,
    assertNonNegativeAmount,
    assertPositiveAmount,
    assertRecord,
    normalizeOptionalBytes32,
} from '../core/validation.js'
const erc20Abi = parseAbi(ERC20_ABI)
const factoryAbi = parseAbi(VAULT_FACTORY_ABI)
const managerAbi = parseAbi(VAULT_MANAGER_ABI)
export interface VaultStashToken {
    readonly token: string
    readonly amount: bigint
}
export interface CreateVaultRequest {
    readonly owner: string
    readonly associatedMiner?: string
    readonly akAddress: string
    readonly poolManager: string
    readonly poolAddress: string
    readonly positionManagerImplementation: string
    readonly stashTokens: readonly VaultStashToken[]
}
export interface VaultTokenAllowance {
    readonly token: string
    readonly allowance: bigint
}
function step(
    kind: TransactionStep['kind'],
    label: string,
    from: string,
    to: string,
    data: string,
    value = 0n
): TransactionStep {
    return {
        kind,
        label,
        transaction: {
            chainId: foreverMoneyDeployment.base.chainId,
            from,
            to,
            data,
            value: value.toString(),
        },
    }
}
function normalizeStashTokens(
    stashTokens: readonly VaultStashToken[]
): readonly { readonly token: Address; readonly amount: bigint }[] {
    assertArray(stashTokens, 'Stash tokens')
    const seen = new Set<string>()
    return stashTokens.map((entry) => {
        assertRecord(entry, 'Stash token')
        if (typeof entry.token !== 'string') {
            throw new ForeverMoneyError(
                'INVALID_TRANSACTION_PLAN',
                'Stash token address must be a string.'
            )
        }
        const normalizedToken = normalizeEvmAddress(entry.token)
        assertPositiveAmount(entry.amount, 'Stash amount')
        const key = normalizedToken.toLowerCase()
        if (seen.has(key)) {
            throw new ForeverMoneyError(
                'INVALID_TRANSACTION_PLAN',
                `Duplicate stash token: ${normalizedToken}.`
            )
        }
        seen.add(key)
        return Object.freeze({
            token: normalizedToken,
            amount: entry.amount,
        })
    })
}
function allowanceMap(
    allowances: readonly VaultTokenAllowance[]
): ReadonlyMap<string, bigint> {
    assertArray(allowances, 'Token allowances')
    const result = new Map<string, bigint>()
    for (const entry of allowances) {
        assertRecord(entry, 'Token allowance')
        if (typeof entry.token !== 'string') {
            throw new ForeverMoneyError(
                'INVALID_TRANSACTION_PLAN',
                'Allowance token address must be a string.'
            )
        }
        const token = normalizeEvmAddress(entry.token).toLowerCase()
        assertNonNegativeAmount(entry.allowance, 'Token allowance')
        if (result.has(token)) {
            throw new ForeverMoneyError(
                'INVALID_TRANSACTION_PLAN',
                `Duplicate allowance for token ${entry.token}.`
            )
        }
        result.set(token, entry.allowance)
    }
    return result
}
function assertAllowanceSet(
    allowances: ReadonlyMap<string, bigint>,
    tokens: readonly VaultStashToken[]
): void {
    const expected = new Set(
        tokens
            .filter(
                ({ token }) =>
                    token !== foreverMoneyDeployment.base.contracts.weth
            )
            .map(({ token }) => token.toLowerCase())
    )
    for (const token of allowances.keys()) {
        if (!expected.has(token)) {
            throw new ForeverMoneyError(
                'INVALID_TRANSACTION_PLAN',
                `Unexpected allowance for token ${token}.`
            )
        }
    }
}
export function buildCreateVaultPlan(
    input: CreateVaultRequest & {
        readonly allowances: readonly VaultTokenAllowance[]
    }
): TransactionPlan {
    const owner = normalizeEvmAddress(input.owner)
    const akAddress = normalizeEvmAddress(input.akAddress)
    const poolManager = normalizeEvmAddress(input.poolManager)
    const poolAddress = normalizeEvmAddress(input.poolAddress)
    const positionManagerImplementation = normalizeEvmAddress(
        input.positionManagerImplementation
    )
    const associatedMiner = normalizeOptionalBytes32(
        input.associatedMiner,
        'Associated miner'
    )
    const stashTokens = normalizeStashTokens(input.stashTokens)
    const allowances = allowanceMap(input.allowances)
    assertAllowanceSet(allowances, stashTokens)
    const { base } = foreverMoneyDeployment
    const steps: TransactionStep[] = []
    let value = 0n
    for (const stash of stashTokens) {
        if (stash.token === base.contracts.weth) {
            value += stash.amount
            assertNonNegativeAmount(value, 'Vault creation value')
            continue
        }
        const allowance = allowances.get(stash.token.toLowerCase())
        if (allowance === undefined) {
            throw new ForeverMoneyError(
                'INVALID_TRANSACTION_PLAN',
                `Missing allowance for stash token ${stash.token}.`
            )
        }
        if (allowance < stash.amount) {
            steps.push(
                step(
                    'approval',
                    `Approve ${stash.token} for the vault factory`,
                    owner,
                    stash.token,
                    encodeFunctionData({
                        abi: erc20Abi,
                        functionName: 'approve',
                        args: [base.contracts.vaultFactory, stash.amount],
                    })
                )
            )
        }
    }
    steps.push(
        step(
            'transaction',
            'Create ForeverMoney vault',
            owner,
            base.contracts.vaultFactory,
            encodeFunctionData({
                abi: factoryAbi,
                functionName: 'create',
                args: [
                    owner,
                    associatedMiner,
                    akAddress,
                    poolManager,
                    poolAddress,
                    positionManagerImplementation,
                    stashTokens,
                ],
            }),
            value
        )
    )
    return createTransactionPlan({
        action: 'vault.create',
        summary: `Create a vault owned by ${owner} with ${stashTokens.length} initial stash token(s).`,
        steps,
    })
}
export async function prepareCreateVault(
    provider: PublicClient,
    input: CreateVaultRequest
): Promise<TransactionPlan> {
    const owner = normalizeEvmAddress(input.owner)
    const stashTokens = normalizeStashTokens(input.stashTokens)
    const erc20Stash = stashTokens.filter(
        ({ token }) => token !== foreverMoneyDeployment.base.contracts.weth
    )
    const allowances = await Promise.all(
        erc20Stash.map(async ({ token }) => ({
            token,
            allowance: await provider.readContract({
                address: token,
                abi: erc20Abi,
                functionName: 'allowance',
                args: [
                    owner,
                    foreverMoneyDeployment.base.contracts.vaultFactory,
                ],
            }),
        }))
    )
    return buildCreateVaultPlan({ ...input, allowances })
}
export interface DepositVaultRequest {
    readonly owner: string
    readonly manager: string
    readonly akAddress: string
    readonly deposits: readonly VaultStashToken[]
}
export function buildDepositVaultPlan(
    input: DepositVaultRequest & {
        readonly allowances: readonly VaultTokenAllowance[]
    }
): TransactionPlan {
    const owner = normalizeEvmAddress(input.owner)
    const manager = normalizeEvmAddress(input.manager)
    const akAddress = normalizeEvmAddress(input.akAddress)
    const deposits = normalizeStashTokens(input.deposits)
    if (deposits.length === 0) {
        throw new ForeverMoneyError(
            'INVALID_TRANSACTION_PLAN',
            'At least one vault deposit is required.'
        )
    }
    const allowances = allowanceMap(input.allowances)
    assertAllowanceSet(allowances, deposits)
    const steps: TransactionStep[] = []
    for (const deposit of deposits) {
        if (deposit.token === foreverMoneyDeployment.base.contracts.weth) {
            steps.push(
                step(
                    'transaction',
                    'Deposit native ETH into the vault as WETH',
                    owner,
                    manager,
                    encodeFunctionData({
                        abi: managerAbi,
                        functionName: 'topUpAk',
                        args: [akAddress, zeroAddress, deposit.amount],
                    }),
                    deposit.amount
                )
            )
            continue
        }
        const allowance = allowances.get(deposit.token.toLowerCase())
        if (allowance === undefined) {
            throw new ForeverMoneyError(
                'INVALID_TRANSACTION_PLAN',
                `Missing allowance for deposit token ${deposit.token}.`
            )
        }
        if (allowance < deposit.amount) {
            steps.push(
                step(
                    'approval',
                    `Approve ${deposit.token} for the vault manager`,
                    owner,
                    deposit.token,
                    encodeFunctionData({
                        abi: erc20Abi,
                        functionName: 'approve',
                        args: [manager, deposit.amount],
                    })
                )
            )
        }
        steps.push(
            step(
                'transaction',
                `Deposit ${deposit.token} into the vault`,
                owner,
                manager,
                encodeFunctionData({
                    abi: managerAbi,
                    functionName: 'topUpAk',
                    args: [akAddress, deposit.token, deposit.amount],
                })
            )
        )
    }
    return createTransactionPlan({
        action: 'vault.deposit',
        summary: `Deposit ${deposits.length} token amount(s) into vault ${manager}.`,
        steps,
    })
}
export async function prepareDepositVault(
    provider: PublicClient,
    input: DepositVaultRequest
): Promise<TransactionPlan> {
    const owner = normalizeEvmAddress(input.owner)
    const manager = normalizeEvmAddress(input.manager)
    const deposits = normalizeStashTokens(input.deposits)
    const erc20Deposits = deposits.filter(
        ({ token }) => token !== foreverMoneyDeployment.base.contracts.weth
    )
    const allowances = await Promise.all(
        erc20Deposits.map(async ({ token }) => ({
            token,
            allowance: await provider.readContract({
                address: token,
                abi: erc20Abi,
                functionName: 'allowance',
                args: [owner, manager],
            }),
        }))
    )
    return buildDepositVaultPlan({ ...input, allowances })
}
export interface WithdrawVaultRequest {
    readonly owner: string
    readonly manager: string
    readonly akAddress: string
    readonly amount0: bigint
    readonly amount1: bigint
    readonly decreaseTokenIds: readonly bigint[]
    readonly unwrapWeth: boolean
}
export function buildWithdrawVaultPlan(
    input: WithdrawVaultRequest
): TransactionPlan {
    const owner = normalizeEvmAddress(input.owner)
    const manager = normalizeEvmAddress(input.manager)
    const akAddress = normalizeEvmAddress(input.akAddress)
    assertArray(input.decreaseTokenIds, 'Position token IDs')
    assertBoolean(input.unwrapWeth, 'unwrapWeth')
    assertNonNegativeAmount(input.amount0, 'Token 0 withdrawal')
    assertNonNegativeAmount(input.amount1, 'Token 1 withdrawal')
    if (input.amount0 === 0n && input.amount1 === 0n) {
        throw new ForeverMoneyError(
            'AMOUNT_ZERO',
            'At least one withdrawal amount must be greater than zero.'
        )
    }
    for (const tokenId of input.decreaseTokenIds) {
        assertNonNegativeAmount(tokenId, 'Position token ID')
    }
    return createTransactionPlan({
        action: 'vault.withdraw',
        summary: `Withdraw token amounts from vault ${manager}.`,
        steps: [
            step(
                'transaction',
                'Withdraw assets from the vault',
                owner,
                manager,
                encodeFunctionData({
                    abi: managerAbi,
                    functionName: 'withdrawFromAkAndPositions',
                    args: [
                        akAddress,
                        input.amount0,
                        input.amount1,
                        input.decreaseTokenIds,
                        input.unwrapWeth,
                    ],
                })
            ),
        ],
    })
}
export function buildClaimVaultFeesPlan(input: {
    readonly owner: string
    readonly manager: string
    readonly akAddress: string
}): TransactionPlan {
    const owner = normalizeEvmAddress(input.owner)
    const manager = normalizeEvmAddress(input.manager)
    const akAddress = normalizeEvmAddress(input.akAddress)
    return createTransactionPlan({
        action: 'vault.claim-fees',
        summary: `Claim all fees for ${akAddress} from vault ${manager}.`,
        steps: [
            step(
                'transaction',
                'Claim vault fees',
                owner,
                manager,
                encodeFunctionData({
                    abi: managerAbi,
                    functionName: 'claimFees',
                    args: [akAddress],
                })
            ),
        ],
    })
}
export function buildSetVaultStakingPlan(input: {
    readonly owner: string
    readonly manager: string
    readonly akAddress: string
    readonly staking: boolean
}): TransactionPlan {
    const owner = normalizeEvmAddress(input.owner)
    const manager = normalizeEvmAddress(input.manager)
    const akAddress = normalizeEvmAddress(input.akAddress)
    assertBoolean(input.staking, 'staking')
    const action = input.staking ? 'stake' : 'unstake'
    return createTransactionPlan({
        action: `vault.${action}`,
        summary: `${input.staking ? 'Stake' : 'Unstake'} the active position in vault ${manager}.`,
        steps: [
            step(
                'transaction',
                `${input.staking ? 'Stake' : 'Unstake'} the vault position`,
                owner,
                manager,
                encodeFunctionData({
                    abi: managerAbi,
                    functionName: action,
                    args: [akAddress, '0x'],
                })
            ),
        ],
    })
}
