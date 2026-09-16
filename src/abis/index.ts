export const ERC20_ABI = Object.freeze([
    'function allowance(address owner,address spender) view returns (uint256)',
    'function approve(address spender,uint256 amount) returns (bool)',
    'function balanceOf(address account) view returns (uint256)',
] as const)

export const STAKING_ABI = Object.freeze([
    'function allowance(address sourceAddress,address spenderAddress,uint256 netuid) view returns (uint256)',
    'function approve(address spenderAddress,uint256 netuid,uint256 absoluteAmount)',
    'function getStake(bytes32 hotkey,bytes32 coldkey,uint256 netuid) view returns (uint256)',
] as const)

export const SPOKE_GATEWAY_ABI = Object.freeze([
    'function ROUTER() view returns (address)',
    'function BITTENSOR_SELECTOR() view returns (uint64)',
    'function SUBTENSOR_GATEWAY() view returns (address)',
    'function maxIntegratorFeeBps() view returns (uint16)',
    'function bridgeFeeBps() view returns (uint16)',
    'function quoteBridgeToFinney(address token,uint256 amount,(bytes32 ss58,address evmFallback,bool wantLiquid,uint256 minTaoOut) exit) view returns (uint256 fee)',
    'function bridgeToFinney(address token,uint256 amount,(bytes32 ss58,address evmFallback,bool wantLiquid,uint256 minTaoOut) exit) payable returns (bytes32 messageId)',
    'function quoteBridgeToFinneyWithFee(address token,uint256 amount,(bytes32 ss58,address evmFallback,bool wantLiquid,uint256 minTaoOut) exit,uint256 gasLimit,(address recipient,uint16 bps) integrator) view returns (uint256 fee,uint256 cut,uint256 amountCrossing)',
    'function bridgeToFinneyWithFee(address token,uint256 amount,(bytes32 ss58,address evmFallback,bool wantLiquid,uint256 minTaoOut) exit,uint256 gasLimit,(address recipient,uint16 bps) integrator) payable returns (bytes32 messageId)',
    'event BridgedToFinney(address indexed token,address indexed sender,bytes32 indexed ss58,uint256 amount,bytes32 messageId)',
] as const)

export const ALPHA_GATEWAY_ABI = Object.freeze([
    'function ROUTER() view returns (address)',
    'function allowedLane(uint64 selector) view returns (bool)',
    'function maxIntegratorFeeBps() view returns (uint16)',
    'function bridgeFeeBps() view returns (uint16)',
    'function integratorTaoTopUp(uint256 taoAmount,uint16 bps) pure returns (uint256)',
    'function quoteBridgeOut(uint64 destSelector,address token,address recipient,uint256 mintedAmount) view returns (uint256 fee)',
    'function bridgeOut(uint64 destSelector,address token,address recipient,uint256 taoAmount,uint256 stakedAlphaRao,uint256 minTokenOut) payable returns (bytes32 messageId)',
    'function integratorCut(uint256 amount,uint16 bps) pure returns (uint256)',
    'function quoteBridgeOutWithFee(uint64 destSelector,address token,address recipient,uint256 mintedAmount,uint256 taoAmount,uint256 stakedAlphaRao,(address recipient,uint16 bps) integrator) view returns (uint256 fee,uint256 nativeTopUp,uint256 alphaTopUp,uint256 amountCrossing)',
    'function bridgeOutWithFee(uint64 destSelector,address token,address recipient,uint256 taoAmount,uint256 stakedAlphaRao,uint256 minTokenOut,(address recipient,uint16 bps) integrator) payable returns (bytes32 messageId)',
    'function bridgeOutFromValidators(uint64 destSelector,address token,address recipient,uint256 taoAmount,(bytes32 validator,uint256 alphaRao)[] sources,uint256 minTokenOut) payable returns (bytes32 messageId)',
    'function bridgeOutFromValidatorsWithFee(uint64 destSelector,address token,address recipient,uint256 taoAmount,(bytes32 validator,uint256 alphaRao)[] sources,uint256 minTokenOut,(address recipient,uint16 bps) integrator) payable returns (bytes32 messageId)',
    'function minStakeRequired() view returns (uint256)',
    'function MAX_STAKE_SOURCES() view returns (uint256)',
    'function GATEWAY_COLDKEY() view returns (bytes32)',
    'function claimLiquid(address token,uint256 minTaoOut,address to)',
    'function claimNative(address to)',
    'function claimStaked(address token,bytes32 destColdkey,address to)',
    'function claimToken(address token,address to)',
    'function claimableNative(address account) view returns (uint256)',
    'function claimableToken(address token,address account) view returns (uint256)',
    'event BridgedOut(uint64 destChainSelector,address indexed token,address indexed sender,address indexed recipient,uint256 minted,bytes32 messageId)',
    'event Claimable(address indexed token,address indexed user,uint256 native,uint256 wsn)',
    'event NotDelivered(uint64 indexed sourceChainSelector,address indexed token,uint256 amount,uint8 reason)',
    'event DeliveredLiquid(address indexed token,bytes32 indexed ss58,uint256 taoOut)',
    'event DeliveredStaked(address indexed token,bytes32 indexed ss58,uint256 alphaRao)',
] as const)

export const ALPHA_VAULT_ABI = Object.freeze([
    'function isPaused() view returns (bool)',
    'function pausedUntil() view returns (uint256)',
    'function isListed(address token) view returns (bool)',
    'function backing(address token) view returns (uint256 stakedAlpha)',
    'function positionOf(address token) view returns (bytes32 validator,uint256 netuid)',
] as const)

export const VAULT_FACTORY_ABI = Object.freeze([
    'function create(address owner,bytes32 associatedMiner,address akAddress,address poolManager,address poolAddress,address positionManagerImpl,(address token,uint256 amount)[] stashTokens) payable returns (address manager)',
    'event SnLiquidityManagerCreated(address indexed manager,address indexed owner,bytes32 associatedMiner,address akAddress,address poolAddress,address poolManager,address positionManager)',
] as const)

export const VAULT_MANAGER_ABI = Object.freeze([
    'function claimFees(address akAddress)',
    'function topUpAk(address akAddress,address token,uint256 amount) payable',
    'function withdrawFromAkAndPositions(address akAddress,uint256 amount0,uint256 amount1,uint256[] decreaseTokenIds,bool unwrapETH)',
    'function stake(address akAddress,bytes data)',
    'function unstake(address akAddress,bytes data)',
    'function owner() view returns (address)',
    'event AKStashTopUp(address akAddress,address token,uint256 amount)',
    'event AKStashWithdraw(address akAddress,address token,uint256 amount)',
] as const)

export const CCIP_EXECUTION_ABI = Object.freeze([
    'event ExecutionStateChanged(uint64 indexed sourceChainSelector,uint64 indexed sequenceNumber,bytes32 indexed messageId,bytes32 messageHash,uint8 state,bytes returnData,uint256 gasUsed)',
] as const)

export const CCIP_ROUTER_ABI = Object.freeze([
    'function isOffRamp(uint64 sourceChainSelector,address offRamp) view returns (bool)',
] as const)

export const foreverMoneyAbis = Object.freeze({
    alphaGateway: ALPHA_GATEWAY_ABI,
    alphaVault: ALPHA_VAULT_ABI,
    ccipExecution: CCIP_EXECUTION_ABI,
    ccipRouter: CCIP_ROUTER_ABI,
    erc20: ERC20_ABI,
    spokeGateway: SPOKE_GATEWAY_ABI,
    staking: STAKING_ABI,
    vaultFactory: VAULT_FACTORY_ABI,
    vaultManager: VAULT_MANAGER_ABI,
})
