// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/access/OwnableUpgradeable.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuardTransient.sol";
import "@openzeppelin/contracts-upgradeable/utils/PausableUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/utils/cryptography/EIP712Upgradeable.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";

/**
 * @title PolareonTokenPool
 * @author Polareon
 * @notice Manages ERC-20 token pools: creation, client deposits, EIP-712 signature-verified
 *         claims, and refunds. Designed for Base L2.
 * @dev UUPS upgradeable. Owner = Safe multisig (governance). Operator = EOA hot wallet (day-to-day ops).
 *
 * IMPORTANT: Only standard ERC-20 tokens are supported.
 * Fee-on-transfer, rebasing, and ERC-777 tokens are NOT supported.
 */
contract PolareonTokenPool is
    UUPSUpgradeable,
    OwnableUpgradeable,
    ReentrancyGuardTransient,
    PausableUpgradeable,
    EIP712Upgradeable
{
    using SafeERC20 for IERC20;

    // ──────────────────────────────────────────────
    //  Types
    // ──────────────────────────────────────────────

    enum PoolStatus {
        Created, // 0 — pool registered on-chain, awaiting deposit
        Funded, // 1 — deposit received, waiting for startTime
        Ended, // 2 — endTime passed or all slots claimed
        Cancelled, // 3 — operator cancelled before any claims
        Refunded // 4 — depositor withdrew remaining tokens
    }

    /**
     * @dev Pool struct — packed for gas efficiency on Base L2.
     *      Slot 1: tokenAddress (20 bytes) + status (1 byte) + totalSlots (4 bytes) + claimedSlots (4 bytes) = 29 bytes
     *      Slot 2: expectedAmount (32 bytes)
     *      Slot 3: claimAmount (32 bytes)
     *      Slot 4: depositedAmount (32 bytes)
     *      Slot 5: startTime (32 bytes)
     *      Slot 6: endTime (32 bytes)
     *      Slot 7: authorizedDepositor (20 bytes)
     */
    struct Pool {
        address tokenAddress; // ERC-20 token contract
        PoolStatus status; // current status
        uint32 totalSlots; // max number of claimants
        uint32 claimedSlots; // claims made so far
        uint256 expectedAmount; // exact deposit required
        uint256 claimAmount; // tokens per claim
        uint256 depositedAmount; // actual deposited (for safety accounting)
        uint256 startTime; // claim window opens
        uint256 endTime; // claim window closes
        address authorizedDepositor; // only this address may deposit & refund
    }

    // ──────────────────────────────────────────────
    //  State
    // ──────────────────────────────────────────────

    /// @notice Operator EOA — authorized for createPool, cancelPool
    address public operator;

    /// @notice poolId ⇒ Pool struct
    mapping(bytes32 => Pool) private _pools;

    /// @notice poolId ⇒ user ⇒ claimed?
    mapping(bytes32 => mapping(address => bool)) public hasClaimed;

    /// @notice EIP-712 claim type hash
    bytes32 public constant CLAIM_TYPEHASH =
        keccak256(
            "Claim(bytes32 poolId,address user,uint256 amount,uint256 nonce)"
        );

    /// @notice Per-user nonce for EIP-712 replay protection
    mapping(address => uint256) public nonces;

    // ──────────────────────────────────────────────
    //  Events
    // ──────────────────────────────────────────────

    event PoolCreated(
        bytes32 indexed poolId,
        address indexed tokenAddress,
        uint256 expectedAmount,
        uint32 totalSlots,
        uint256 claimAmount,
        uint256 startTime,
        uint256 endTime,
        address authorizedDepositor
    );

    event Deposited(
        bytes32 indexed poolId,
        address indexed depositor,
        uint256 amount
    );
    event Claimed(bytes32 indexed poolId, address indexed user, uint256 amount);
    event PoolCancelled(bytes32 indexed poolId);
    event Refunded(
        bytes32 indexed poolId,
        address indexed depositor,
        uint256 amount
    );
    event OperatorUpdated(
        address indexed previousOperator,
        address indexed newOperator
    );

    // ──────────────────────────────────────────────
    //  Errors
    // ──────────────────────────────────────────────

    error OnlyOperator();
    error PoolAlreadyExists();
    error PoolNotFound();
    error InvalidAddress();
    error InvalidAmount();
    error InvalidSlots();
    error InvalidTimeWindow();
    error OnlyAuthorizedDepositor();
    error PoolNotCreated();
    error PoolNotFundedOrActive();
    error PoolNotClaimable();
    error AlreadyClaimed();
    error InvalidSignature();
    error InvalidClaimAmount();
    error PoolHasClaims();
    error PoolNotRefundable();
    error DepositAmountMismatch();
    error FeeOnTransferNotSupported();
    error NonceMismatch();

    // ──────────────────────────────────────────────
    //  Modifiers
    // ──────────────────────────────────────────────

    modifier onlyOperator() {
        if (msg.sender != operator) revert OnlyOperator();
        _;
    }

    // ──────────────────────────────────────────────
    //  Initializer
    // ──────────────────────────────────────────────

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    /**
     * @notice Initializes the contract.
     * @param owner_ Safe multisig address (contract owner)
     * @param operator_ Operator EOA address (backend hot wallet)
     */
    function initialize(
        address owner_,
        address operator_
    ) external initializer {
        if (owner_ == address(0)) revert InvalidAddress();
        if (operator_ == address(0)) revert InvalidAddress();

        __Ownable_init(owner_);
        __Pausable_init();
        __EIP712_init("PolareonTokenPool", "1");

        operator = operator_;
        emit OperatorUpdated(address(0), operator_);
    }

    // ──────────────────────────────────────────────
    //  Owner-only functions
    // ──────────────────────────────────────────────

    /**
     * @notice Replace the operator EOA. Invalidates all pending EIP-712 claim signatures.
     * @param newOperator New operator address
     */
    function setOperator(address newOperator) external onlyOwner {
        if (newOperator == address(0)) revert InvalidAddress();
        address previous = operator;
        operator = newOperator;
        emit OperatorUpdated(previous, newOperator);
    }

    /// @notice Emergency pause — blocks all state-changing functions
    function pause() external onlyOwner {
        _pause();
    }

    /// @notice Unpause
    function unpause() external onlyOwner {
        _unpause();
    }

    /// @dev UUPS upgrade authorization — owner (Safe multisig) only
    function _authorizeUpgrade(address) internal override onlyOwner {}

    // ──────────────────────────────────────────────
    //  Operator functions
    // ──────────────────────────────────────────────

    /**
     * @notice Create a new token pool.
     * @param poolId Unique identifier (computed off-chain, e.g. keccak256 of DB id)
     * @param tokenAddress ERC-20 token contract address
     * @param expectedAmount Exact deposit amount required from the depositor
     * @param slots Maximum number of claimants
     * @param claimAmount Tokens distributed per claim
     * @param startTime Unix timestamp — claim window opens
     * @param endTime Unix timestamp — claim window closes
     * @param authorizedDepositor Address allowed to deposit and refund
     */
    function createPool(
        bytes32 poolId,
        address tokenAddress,
        uint256 expectedAmount,
        uint32 slots,
        uint256 claimAmount,
        uint256 startTime,
        uint256 endTime,
        address authorizedDepositor
    ) external onlyOperator whenNotPaused {
        if (_pools[poolId].tokenAddress != address(0))
            revert PoolAlreadyExists();
        if (tokenAddress == address(0)) revert InvalidAddress();
        if (expectedAmount == 0) revert InvalidAmount();
        if (slots == 0) revert InvalidSlots();
        if (claimAmount == 0) revert InvalidAmount();
        if (endTime <= startTime) revert InvalidTimeWindow();
        if (authorizedDepositor == address(0)) revert InvalidAddress();
        // Sanity: expectedAmount should be >= slots * claimAmount
        if (expectedAmount < uint256(slots) * claimAmount)
            revert InvalidAmount();

        _pools[poolId] = Pool({
            tokenAddress: tokenAddress,
            status: PoolStatus.Created,
            totalSlots: slots,
            claimedSlots: 0,
            expectedAmount: expectedAmount,
            claimAmount: claimAmount,
            depositedAmount: 0,
            startTime: startTime,
            endTime: endTime,
            authorizedDepositor: authorizedDepositor
        });

        emit PoolCreated(
            poolId,
            tokenAddress,
            expectedAmount,
            slots,
            claimAmount,
            startTime,
            endTime,
            authorizedDepositor
        );
    }

    /**
     * @notice Cancel a pool. Only allowed if no claims have been made.
     * @param poolId Pool identifier
     */
    function cancelPool(bytes32 poolId) external onlyOperator whenNotPaused {
        Pool storage pool = _pools[poolId];
        if (pool.tokenAddress == address(0)) revert PoolNotFound();
        if (
            pool.status != PoolStatus.Created &&
            pool.status != PoolStatus.Funded
        ) revert PoolNotCreated();
        if (pool.claimedSlots > 0) revert PoolHasClaims();

        pool.status = PoolStatus.Cancelled;
        emit PoolCancelled(poolId);
    }

    // ──────────────────────────────────────────────
    //  Depositor functions
    // ──────────────────────────────────────────────

    /**
     * @notice Deposit tokens into a pool. Must be exact `expectedAmount`. Single deposit only.
     * @param poolId Pool identifier
     */
    function deposit(bytes32 poolId) external nonReentrant whenNotPaused {
        Pool storage pool = _pools[poolId];
        if (pool.tokenAddress == address(0)) revert PoolNotFound();
        if (pool.status != PoolStatus.Created) revert PoolNotCreated();
        if (msg.sender != pool.authorizedDepositor)
            revert OnlyAuthorizedDepositor();

        uint256 amount = pool.expectedAmount;
        IERC20 token = IERC20(pool.tokenAddress);

        // Check balance before transfer to detect fee-on-transfer tokens
        uint256 balanceBefore = token.balanceOf(address(this));
        token.safeTransferFrom(msg.sender, address(this), amount);
        uint256 balanceAfter = token.balanceOf(address(this));

        if (balanceAfter - balanceBefore != amount)
            revert FeeOnTransferNotSupported();

        pool.depositedAmount = amount;
        pool.status = PoolStatus.Funded;

        emit Deposited(poolId, msg.sender, amount);
    }

    /**
     * @notice Refund remaining tokens to the depositor.
     *         Allowed after endTime (pool transitions to Ended) or if pool is Cancelled.
     * @param poolId Pool identifier
     */
    function refund(bytes32 poolId) external nonReentrant whenNotPaused {
        Pool storage pool = _pools[poolId];
        if (pool.tokenAddress == address(0)) revert PoolNotFound();
        if (msg.sender != pool.authorizedDepositor)
            revert OnlyAuthorizedDepositor();

        // Determine if pool is refundable
        if (pool.status == PoolStatus.Cancelled) {
            // Cancelled + had deposit → refund the full deposit
            if (pool.depositedAmount == 0) revert PoolNotRefundable();
        } else if (pool.status == PoolStatus.Funded) {
            // Funded and past endTime → transition to Ended first
            if (block.timestamp <= pool.endTime) revert PoolNotRefundable();
            pool.status = PoolStatus.Ended;
        } else if (pool.status == PoolStatus.Ended) {
            // Already ended, proceed to refund
        } else {
            revert PoolNotRefundable();
        }

        uint256 claimedTotal = uint256(pool.claimedSlots) * pool.claimAmount;
        uint256 remaining = pool.depositedAmount - claimedTotal;

        if (remaining == 0) revert InvalidAmount();

        // Update state before transfer (CEI)
        pool.status = PoolStatus.Refunded;
        pool.depositedAmount = claimedTotal; // accounting: only claimed tokens were distributed

        IERC20(pool.tokenAddress).safeTransfer(
            pool.authorizedDepositor,
            remaining
        );

        emit Refunded(poolId, pool.authorizedDepositor, remaining);
    }

    // ──────────────────────────────────────────────
    //  Claim function (any user with valid signature)
    // ──────────────────────────────────────────────

    /**
     * @notice Claim tokens from a pool using an EIP-712 signature from the operator.
     * @param poolId Pool identifier
     * @param amount Must equal pool.claimAmount
     * @param nonce Must equal current nonce for msg.sender
     * @param signature EIP-712 signature from operator
     */
    function claim(
        bytes32 poolId,
        uint256 amount,
        uint256 nonce,
        bytes calldata signature
    ) external nonReentrant whenNotPaused {
        Pool storage pool = _pools[poolId];
        if (pool.tokenAddress == address(0)) revert PoolNotFound();

        // Check pool is claimable (Active derived state)
        if (pool.status != PoolStatus.Funded) revert PoolNotClaimable();
        if (block.timestamp < pool.startTime) revert PoolNotClaimable();
        if (block.timestamp > pool.endTime) revert PoolNotClaimable();
        if (pool.claimedSlots >= pool.totalSlots) revert PoolNotClaimable();

        // Check claim validity
        if (amount != pool.claimAmount) revert InvalidClaimAmount();
        if (hasClaimed[poolId][msg.sender]) revert AlreadyClaimed();
        if (nonce != nonces[msg.sender]) revert NonceMismatch();

        // Verify EIP-712 signature from operator
        bytes32 structHash = keccak256(
            abi.encode(CLAIM_TYPEHASH, poolId, msg.sender, amount, nonce)
        );
        bytes32 digest = _hashTypedDataV4(structHash);
        address signer = ECDSA.recover(digest, signature);
        if (signer != operator) revert InvalidSignature();

        // Effects (before interactions)
        hasClaimed[poolId][msg.sender] = true;
        nonces[msg.sender] = nonce + 1;
        pool.claimedSlots += 1;

        // Auto-transition: if all slots claimed, mark Ended
        if (pool.claimedSlots == pool.totalSlots) {
            pool.status = PoolStatus.Ended;
        }

        // Interaction
        IERC20(pool.tokenAddress).safeTransfer(msg.sender, amount);

        emit Claimed(poolId, msg.sender, amount);
    }

    // ──────────────────────────────────────────────
    //  View functions
    // ──────────────────────────────────────────────

    /**
     * @notice Get full pool details.
     * @param poolId Pool identifier
     * @return pool The pool struct
     */
    function getPool(bytes32 poolId) external view returns (Pool memory) {
        return _pools[poolId];
    }

    /**
     * @notice Get remaining token balance for a pool (deposited minus claimed).
     * @param poolId Pool identifier
     * @return remaining Tokens still in the pool
     */
    function getPoolBalance(bytes32 poolId) external view returns (uint256) {
        Pool storage pool = _pools[poolId];
        if (pool.depositedAmount == 0) return 0;
        if (pool.status == PoolStatus.Refunded) return 0;
        uint256 claimedTotal = uint256(pool.claimedSlots) * pool.claimAmount;
        return pool.depositedAmount - claimedTotal;
    }

    /**
     * @notice Get the number of claimed slots for a pool.
     * @param poolId Pool identifier
     * @return Number of claims made
     */
    function getClaimedSlots(bytes32 poolId) external view returns (uint256) {
        return _pools[poolId].claimedSlots;
    }

    /**
     * @notice Check if a pool is currently claimable (Active derived state).
     * @param poolId Pool identifier
     * @return True if pool is accepting claims right now
     */
    function isPoolActive(bytes32 poolId) external view returns (bool) {
        Pool storage pool = _pools[poolId];
        return
            pool.status == PoolStatus.Funded &&
            block.timestamp >= pool.startTime &&
            block.timestamp <= pool.endTime &&
            pool.claimedSlots < pool.totalSlots;
    }

    /**
     * @notice Get the EIP-712 domain separator (useful for off-chain signature construction).
     * @return The domain separator bytes32
     */
    function domainSeparator() external view returns (bytes32) {
        return _domainSeparatorV4();
    }
}
