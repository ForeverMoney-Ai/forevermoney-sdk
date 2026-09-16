import {
    decodeFunctionData,
    parseAbi,
    zeroAddress,
    zeroHash,
    type Hex,
} from 'viem'
import { describe, expect, it } from 'vitest'
import { VAULT_FACTORY_ABI, VAULT_MANAGER_ABI } from '../abis/index.js'
import {
    buildClaimVaultFeesPlan,
    buildCreateVaultPlan,
    buildDepositVaultPlan,
    buildSetVaultStakingPlan,
    buildWithdrawVaultPlan,
    foreverMoneyDeployment,
} from '../index.js'
const owner = '0x1111111111111111111111111111111111111111'
const token = '0x2222222222222222222222222222222222222222'
const akAddress = '0x3333333333333333333333333333333333333333'
const poolManager = '0x4444444444444444444444444444444444444444'
const poolAddress = '0x5555555555555555555555555555555555555555'
const positionManager = '0x6666666666666666666666666666666666666666'
const manager = '0x7777777777777777777777777777777777777777'
describe('vault transaction plans', () => {
    it('builds approvals and a payable create call with canonical factory data', () => {
        const plan = buildCreateVaultPlan({
            owner,
            akAddress,
            poolManager,
            poolAddress,
            positionManagerImplementation: positionManager,
            stashTokens: [
                { token, amount: 10n },
                {
                    token: foreverMoneyDeployment.base.contracts.weth,
                    amount: 20n,
                },
            ],
            allowances: [{ token, allowance: 9n }],
        })
        expect(plan.steps).toHaveLength(2)
        expect(plan.steps[0]!.kind).toBe('approval')
        expect(plan.steps[1]!.transaction.value).toBe('20')
        const decoded = decodeFunctionData({
            abi: parseAbi(VAULT_FACTORY_ABI),
            data: plan.steps[1]!.transaction.data as Hex,
        }).args!
        expect(decoded[0]).toBe(owner)
        expect(decoded[1]).toBe(zeroHash)
        expect(decoded[2]).toBe(akAddress)
        expect(decoded[6][0]!.token).toBe(token)
        expect(decoded[6][1]!.amount).toBe(20n)
    })
    it('requires explicit allowance data and rejects duplicate stash tokens', () => {
        const common = {
            owner,
            akAddress,
            poolManager,
            poolAddress,
            positionManagerImplementation: positionManager,
        }
        expect(() =>
            buildCreateVaultPlan({
                ...common,
                stashTokens: [{ token, amount: 10n }],
                allowances: [],
            })
        ).toThrow('Missing allowance')
        expect(() =>
            buildCreateVaultPlan({
                ...common,
                stashTokens: [
                    { token, amount: 10n },
                    { token, amount: 20n },
                ],
                allowances: [{ token, allowance: 100n }],
            })
        ).toThrow('Duplicate stash token')
    })
    it('encodes ERC20 and native vault deposits without conflating WETH and ETH', () => {
        const plan = buildDepositVaultPlan({
            owner,
            manager,
            akAddress,
            deposits: [
                { token, amount: 10n },
                {
                    token: foreverMoneyDeployment.base.contracts.weth,
                    amount: 20n,
                },
            ],
            allowances: [{ token, allowance: 0n }],
        })
        expect(plan.steps.map(({ kind }) => kind)).toEqual([
            'approval',
            'transaction',
            'transaction',
        ])
        const nativeDeposit = plan.steps[2]!
        const decoded = decodeFunctionData({
            abi: parseAbi(VAULT_MANAGER_ABI),
            data: nativeDeposit.transaction.data as Hex,
        }).args!
        expect(decoded[1]).toBe(zeroAddress)
        expect(decoded[2]).toBe(20n)
        expect(nativeDeposit.transaction.value).toBe('20')
    })
    it('encodes withdrawals, fee claims, and staking with explicit overloads', () => {
        const withdrawal = buildWithdrawVaultPlan({
            owner,
            manager,
            akAddress,
            amount0: 10n,
            amount1: 0n,
            decreaseTokenIds: [123n],
            unwrapWeth: true,
        })
        const decoded = decodeFunctionData({
            abi: parseAbi(VAULT_MANAGER_ABI),
            data: withdrawal.steps[0]!.transaction.data as Hex,
        }).args!
        expect(decoded[3]).toEqual([123n])
        expect(decoded[4]).toBe(true)
        expect(
            buildClaimVaultFeesPlan({ owner, manager, akAddress }).action
        ).toBe('vault.claim-fees')
        const staking = buildSetVaultStakingPlan({
            owner,
            manager,
            akAddress,
            staking: true,
        })
        expect(
            decodeFunctionData({
                abi: parseAbi(VAULT_MANAGER_ABI),
                data: staking.steps[0]!.transaction.data as Hex,
            }).functionName
        ).toBe('stake')
    })
    it('rejects empty deposits, zero withdrawals, and negative position IDs', () => {
        expect(() =>
            buildDepositVaultPlan({
                owner,
                manager,
                akAddress,
                deposits: [],
                allowances: [],
            })
        ).toThrow('At least one')
        expect(() =>
            buildWithdrawVaultPlan({
                owner,
                manager,
                akAddress,
                amount0: 0n,
                amount1: 0n,
                decreaseTokenIds: [],
                unwrapWeth: true,
            })
        ).toThrow('At least one')
        expect(() =>
            buildWithdrawVaultPlan({
                owner,
                manager,
                akAddress,
                amount0: 1n,
                amount1: 0n,
                decreaseTokenIds: [-1n],
                unwrapWeth: true,
            })
        ).toThrow('cannot be negative')
        expect(() =>
            buildSetVaultStakingPlan({
                owner,
                manager,
                akAddress,
                staking: 'true' as unknown as boolean,
            })
        ).toThrow('must be a boolean')
        expect(() =>
            buildDepositVaultPlan({
                owner,
                manager,
                akAddress,
                deposits: [{ token, amount: 1n }],
                allowances: [
                    { token, allowance: 1n },
                    {
                        token: positionManager,
                        allowance: 1n,
                    },
                ],
            })
        ).toThrow('Unexpected allowance')
    })
    it('rejects malformed JavaScript array entries with stable SDK errors', () => {
        expect(() =>
            buildDepositVaultPlan({
                owner,
                manager,
                akAddress,
                deposits: [null] as unknown as readonly {
                    token: string
                    amount: bigint
                }[],
                allowances: [],
            })
        ).toThrow('Stash token must be an object')
        expect(() =>
            buildDepositVaultPlan({
                owner,
                manager,
                akAddress,
                deposits: [{ token, amount: 1n }],
                allowances: [null] as unknown as readonly {
                    token: string
                    allowance: bigint
                }[],
            })
        ).toThrow('Token allowance must be an object')
    })
})
