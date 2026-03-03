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
 * @title PolareonVault
 * @author Polareon
 * @notice Persistent-balance vault on Base L2 — holds a running USDC balance across
 *         prize cycles. Uncracked prizes carry over automatically (no withdraw/re-deposit).
 *         Winners claim via EIP-712 signature from the operator.
 * @dev UUPS upgradeable. Owner = Safe multisig (governance). Operator = EOA hot wallet (day-to-day ops).
 *
 * IMPORTANT: Designed exclusively for USDC on Base (6 decimals, standard ERC-20).
 * Fee-on-transfer, rebasing, and ERC-777 tokens are NOT supported.
 */
contract PolareonVault is
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

    enum CycleStatus {
        Created, // 0 — cycle registered, awaiting startTime
        Claimed, // 1 — prize claimed by winner
        Cancelled // 2 — operator cancelled the cycle
    }
    // Active is derived: Created AND block.timestamp ∈ [startTime, endTime]
    // Ended is derived:  Created AND block.timestamp > endTime

    /**
     * @dev Cycle struct — packed for gas efficiency on Base L2.
     *      Slot 1: winner (20 bytes) + status (1 byte) = 21 bytes
     *      Slot 2: prizeAmount (32 bytes)
     *      Slot 3: startTime (32 bytes)
     *      Slot 4: endTime (32 bytes)
     */
    struct Cycle {
        address winner; // winner address (zero if unclaimed)
        CycleStatus status; // stored status
        uint256 prizeAmount; // prize for this cycle
        uint256 startTime; // claim window opens
        uint256 endTime; // claim window closes
    }

    // ──────────────────────────────────────────────
    //  State
    // ──────────────────────────────────────────────

    /// @notice The USDC token address (set once in initialize, immutable thereafter)
    address public token;

    /// @notice Operator EOA — authorized for createCycle, depositPrize, cancelCycle
    address public operator;

    /// @notice Running vault balance (USDC held in contract, tracked for accounting)
    uint256 public vaultBalance;

    /// @notice Currently active/pending cycle ID (zero if no cycle)
    bytes32 public currentCycleId;

    /// @notice cycleId ⇒ Cycle struct
    mapping(bytes32 => Cycle) private _cycles;

    /// @notice EIP-712 claim type hash
    bytes32 public constant CLAIM_TYPEHASH =
        keccak256(
            "Claim(bytes32 cycleId,address user,uint256 amount,uint256 nonce)"
        );

    /// @notice Per-user nonce for EIP-712 replay protection
    mapping(address => uint256) public nonces;

    // ──────────────────────────────────────────────
    //  Events
    // ──────────────────────────────────────────────

    event CycleCreated(
        bytes32 indexed cycleId,
        uint256 prizeAmount,
        uint256 startTime,
        uint256 endTime
    );

    event PrizeDeposited(uint256 amount, uint256 newVaultBalance);
    event PrizeClaimed(
        bytes32 indexed cycleId,
        address indexed winner,
        uint256 amount
    );
    event CycleCancelled(bytes32 indexed cycleId);
    event ExcessWithdrawn(uint256 amount, uint256 newVaultBalance);
    event OperatorUpdated(
        address indexed previousOperator,
        address indexed newOperator
    );

    // ──────────────────────────────────────────────
    //  Errors
    // ──────────────────────────────────────────────

    error OnlyOperator();
    error CycleAlreadyExists();
    error CycleNotFound();
    error CycleNotClaimable();
    error CycleAlreadyClaimed();
    error CycleNotCancellable();
    error AnotherCycleActive();
    error NoCycleActive();
    error InvalidAddress();
    error InvalidAmount();
    error InvalidTimeWindow();
    error InvalidSignature();
    error InsufficientVaultBalance();
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
     * @notice Initializes the vault contract.
     * @param owner_ Safe multisig address (contract owner)
     * @param operator_ Operator EOA address (backend hot wallet)
     * @param token_ USDC token address on Base
     */
    function initialize(
        address owner_,
        address operator_,
        address token_
    ) external initializer {
        if (owner_ == address(0)) revert InvalidAddress();
        if (operator_ == address(0)) revert InvalidAddress();
        if (token_ == address(0)) revert InvalidAddress();

        __Ownable_init(owner_);
        __Pausable_init();
        __EIP712_init("PolareonVault", "1");

        operator = operator_;
        token = token_;

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

    /**
     * @notice Withdraw excess funds from the vault.
     *         Only allowed when NO cycle is currently active/pending.
     *         Requires multisig approval (owner-only).
     * @param amount Amount to withdraw
     */
    function withdrawExcess(
        uint256 amount
    ) external onlyOwner nonReentrant whenNotPaused {
        if (amount == 0) revert InvalidAmount();
        if (amount > vaultBalance) revert InsufficientVaultBalance();

        // Revert if there's an active/pending cycle
        if (currentCycleId != bytes32(0)) {
            Cycle storage cycle = _cycles[currentCycleId];
            // Only allow if the current cycle is finished (Claimed/Cancelled or naturally ended)
            if (cycle.status == CycleStatus.Created) {
                // Could be pending or ended — check time
                if (block.timestamp <= cycle.endTime)
                    revert AnotherCycleActive();
                // Past endTime with status Created → naturally ended, clear it
                currentCycleId = bytes32(0);
            }
            // Claimed or Cancelled — clear it and allow withdrawal
            if (currentCycleId != bytes32(0)) {
                currentCycleId = bytes32(0);
            }
        }

        vaultBalance -= amount;
        IERC20(token).safeTransfer(msg.sender, amount);

        emit ExcessWithdrawn(amount, vaultBalance);
    }

    /// @dev UUPS upgrade authorization — owner (Safe multisig) only
    function _authorizeUpgrade(address) internal override onlyOwner {}

    // ──────────────────────────────────────────────
    //  Operator functions
    // ──────────────────────────────────────────────

    /**
     * @notice Deposit USDC into the vault. Accumulative — can be called multiple times.
     *         Operator must have approved this contract to spend the token.
     * @param amount Amount of USDC to deposit
     */
    function depositPrize(
        uint256 amount
    ) external onlyOperator nonReentrant whenNotPaused {
        if (amount == 0) revert InvalidAmount();

        IERC20 tokenContract = IERC20(token);

        // Fee-on-transfer detection
        uint256 balanceBefore = tokenContract.balanceOf(address(this));
        tokenContract.safeTransferFrom(msg.sender, address(this), amount);
        uint256 balanceAfter = tokenContract.balanceOf(address(this));

        if (balanceAfter - balanceBefore != amount)
            revert FeeOnTransferNotSupported();

        vaultBalance += amount;

        emit PrizeDeposited(amount, vaultBalance);
    }

    /**
     * @notice Create a new prize cycle.
     *         Only one cycle can be active/pending at a time.
     *         prizeAmount is recorded but not locked — checked against vaultBalance at claim time.
     * @param cycleId Unique identifier (computed off-chain)
     * @param prizeAmount Prize amount for this cycle
     * @param startTime Unix timestamp — claim window opens
     * @param endTime Unix timestamp — claim window closes
     */
    function createCycle(
        bytes32 cycleId,
        uint256 prizeAmount,
        uint256 startTime,
        uint256 endTime
    ) external onlyOperator whenNotPaused {
        if (_cycles[cycleId].endTime != 0) revert CycleAlreadyExists();
        if (prizeAmount == 0) revert InvalidAmount();
        if (endTime <= startTime) revert InvalidTimeWindow();

        // Enforce one active cycle at a time
        if (currentCycleId != bytes32(0)) {
            Cycle storage current = _cycles[currentCycleId];
            if (current.status == CycleStatus.Created) {
                // Still Created — check if naturally ended
                if (block.timestamp <= current.endTime)
                    revert AnotherCycleActive();
                // Past endTime → naturally ended, can clear
            }
            // Claimed or Cancelled or naturally ended → clear slot
        }

        _cycles[cycleId] = Cycle({
            winner: address(0),
            status: CycleStatus.Created,
            prizeAmount: prizeAmount,
            startTime: startTime,
            endTime: endTime
        });

        currentCycleId = cycleId;

        emit CycleCreated(cycleId, prizeAmount, startTime, endTime);
    }

    /**
     * @notice Cancel a cycle. Only when NOT yet claimed.
     *         Funds remain in vaultBalance (no transfer).
     * @param cycleId Cycle identifier
     */
    function cancelCycle(bytes32 cycleId) external onlyOperator whenNotPaused {
        Cycle storage cycle = _cycles[cycleId];
        if (cycle.endTime == 0) revert CycleNotFound();
        if (cycle.status == CycleStatus.Claimed) revert CycleAlreadyClaimed();
        if (cycle.status == CycleStatus.Cancelled) revert CycleNotCancellable();

        cycle.status = CycleStatus.Cancelled;

        // Clear current cycle slot if this was the active one
        if (currentCycleId == cycleId) {
            currentCycleId = bytes32(0);
        }

        emit CycleCancelled(cycleId);
    }

    // ──────────────────────────────────────────────
    //  Claim function (any user with valid signature)
    // ──────────────────────────────────────────────

    /**
     * @notice Claim the prize for a cycle using an EIP-712 signature from the operator.
     * @param cycleId Cycle identifier
     * @param amount Must equal cycle.prizeAmount
     * @param nonce Must equal current nonce for msg.sender
     * @param signature EIP-712 signature from operator
     */
    function claimPrize(
        bytes32 cycleId,
        uint256 amount,
        uint256 nonce,
        bytes calldata signature
    ) external nonReentrant whenNotPaused {
        Cycle storage cycle = _cycles[cycleId];
        if (cycle.endTime == 0) revert CycleNotFound();

        // Check cycle is claimable (Active derived state)
        if (cycle.status != CycleStatus.Created) revert CycleNotClaimable();
        if (block.timestamp < cycle.startTime) revert CycleNotClaimable();
        if (block.timestamp > cycle.endTime) revert CycleNotClaimable();

        // Verify amount matches cycle prize
        if (amount != cycle.prizeAmount) revert InvalidAmount();

        // Verify vault has sufficient balance
        if (amount > vaultBalance) revert InsufficientVaultBalance();

        // Verify nonce
        if (nonce != nonces[msg.sender]) revert NonceMismatch();

        // Verify EIP-712 signature from operator
        bytes32 structHash = keccak256(
            abi.encode(CLAIM_TYPEHASH, cycleId, msg.sender, amount, nonce)
        );
        bytes32 digest = _hashTypedDataV4(structHash);
        address signer = ECDSA.recover(digest, signature);
        if (signer != operator) revert InvalidSignature();

        // Effects (before interactions — CEI pattern)
        cycle.status = CycleStatus.Claimed;
        cycle.winner = msg.sender;
        nonces[msg.sender] = nonce + 1;
        vaultBalance -= amount;

        // Clear current cycle slot
        if (currentCycleId == cycleId) {
            currentCycleId = bytes32(0);
        }

        // Interaction
        IERC20(token).safeTransfer(msg.sender, amount);

        emit PrizeClaimed(cycleId, msg.sender, amount);
    }

    // ──────────────────────────────────────────────
    //  View functions
    // ──────────────────────────────────────────────

    /**
     * @notice Get the current vault USDC balance (the growing number users see).
     * @return Current vault balance
     */
    function getVaultBalance() external view returns (uint256) {
        return vaultBalance;
    }

    /**
     * @notice Get full cycle details.
     * @param cycleId Cycle identifier
     * @return cycle The cycle struct
     */
    function getCycle(bytes32 cycleId) external view returns (Cycle memory) {
        return _cycles[cycleId];
    }

    /**
     * @notice Get the currently active/pending cycle ID (zero if none).
     * @return The current cycle ID
     */
    function getCurrentCycleId() external view returns (bytes32) {
        return currentCycleId;
    }

    /**
     * @notice Check if a cycle has been claimed.
     * @param cycleId Cycle identifier
     * @return True if claimed
     */
    function isClaimed(bytes32 cycleId) external view returns (bool) {
        return _cycles[cycleId].status == CycleStatus.Claimed;
    }

    /**
     * @notice Get the winner of a cycle (zero address if unclaimed).
     * @param cycleId Cycle identifier
     * @return Winner address
     */
    function getCycleWinner(bytes32 cycleId) external view returns (address) {
        return _cycles[cycleId].winner;
    }

    /**
     * @notice Check if a cycle is currently active (claimable right now).
     * @param cycleId Cycle identifier
     * @return True if cycle is in the active claim window
     */
    function isCycleActive(bytes32 cycleId) external view returns (bool) {
        Cycle storage cycle = _cycles[cycleId];
        return
            cycle.status == CycleStatus.Created &&
            block.timestamp >= cycle.startTime &&
            block.timestamp <= cycle.endTime;
    }

    /**
     * @notice Get the EIP-712 domain separator (useful for off-chain signature construction).
     * @return The domain separator bytes32
     */
    function domainSeparator() external view returns (bytes32) {
        return _domainSeparatorV4();
    }
}
