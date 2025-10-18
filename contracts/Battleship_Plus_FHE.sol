pragma solidity ^0.8.24;

import { FHE, euint32, ebool } from "@fhevm/solidity/lib/FHE.sol";
import { SepoliaConfig } from "@fhevm/solidity/config/ZamaConfig.sol";

contract BattleshipPlusFHE is SepoliaConfig {
    using FHE for euint32;
    using FHE for ebool;

    address public owner;
    mapping(address => bool) public providers;
    bool public paused;
    uint256 public cooldownSeconds;
    mapping(address => uint256) public lastSubmissionTime;
    mapping(address => uint256) public lastDecryptionRequestTime;
    uint256 public currentBatchId;
    bool public batchOpen;

    struct DecryptionContext {
        uint256 batchId;
        bytes32 stateHash;
        bool processed;
    }
    mapping(uint256 => DecryptionContext) public decryptionContexts;

    struct Ship {
        euint32 typeId; // Encrypted: 0=Submarine, 1=Carrier, 2=Destroyer, etc.
        euint32 x;      // Encrypted: X-coordinate
        euint32 y;      // Encrypted: Y-coordinate
        euint32 health; // Encrypted: Health points
    }
    mapping(uint256 => mapping(uint256 => Ship)) public playerShips; // playerAddress => shipIndex => Ship

    struct GameMove {
        euint32 playerId; // Encrypted: Address of the player making the move
        euint32 targetX;  // Encrypted: X-coordinate of the target
        euint32 targetY;  // Encrypted: Y-coordinate of the target
    }
    mapping(uint256 => GameMove[]) public batchMoves; // batchId => list of moves

    event OwnershipTransferred(address indexed previousOwner, address indexed newOwner);
    event ProviderAdded(address indexed provider);
    event ProviderRemoved(address indexed provider);
    event ContractPaused();
    event ContractUnpaused();
    event CooldownSecondsSet(uint256 oldCooldownSeconds, uint256 newCooldownSeconds);
    event BatchOpened(uint256 batchId);
    event BatchClosed(uint256 batchId);
    event ShipSubmitted(address indexed player, uint256 batchId, uint256 shipIndex);
    event MoveSubmitted(address indexed player, uint256 batchId, uint256 moveIndex);
    event DecryptionRequested(uint256 indexed requestId, uint256 batchId);
    event DecryptionCompleted(uint256 indexed requestId, uint256 batchId);

    error NotOwner();
    error NotProvider();
    error Paused();
    error CooldownActive();
    error BatchClosed();
    error InvalidCoordinates();
    error ReplayDetected();
    error StateMismatch();
    error InvalidProof();
    error NotInitialized();

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    modifier onlyProvider() {
        if (!providers[msg.sender]) revert NotProvider();
        _;
    }

    modifier whenNotPaused() {
        if (paused) revert Paused();
        _;
    }

    modifier checkSubmissionCooldown() {
        if (block.timestamp < lastSubmissionTime[msg.sender] + cooldownSeconds) {
            revert CooldownActive();
        }
        _;
    }

    modifier checkDecryptionCooldown() {
        if (block.timestamp < lastDecryptionRequestTime[msg.sender] + cooldownSeconds) {
            revert CooldownActive();
        }
        _;
    }

    modifier checkBatchOpen() {
        if (!batchOpen) revert BatchClosed();
        _;
    }

    constructor() {
        owner = msg.sender;
        providers[msg.sender] = true;
        emit ProviderAdded(msg.sender);
        cooldownSeconds = 30; // Default cooldown
    }

    function transferOwnership(address newOwner) external onlyOwner {
        address previousOwner = owner;
        owner = newOwner;
        emit OwnershipTransferred(previousOwner, newOwner);
    }

    function addProvider(address provider) external onlyOwner {
        providers[provider] = true;
        emit ProviderAdded(provider);
    }

    function removeProvider(address provider) external onlyOwner {
        providers[provider] = false;
        emit ProviderRemoved(provider);
    }

    function setPaused(bool _paused) external onlyOwner {
        if (_paused) {
            paused = true;
            emit ContractPaused();
        } else {
            paused = false;
            emit ContractUnpaused();
        }
    }

    function setCooldownSeconds(uint256 _cooldownSeconds) external onlyOwner {
        uint256 oldCooldownSeconds = cooldownSeconds;
        cooldownSeconds = _cooldownSeconds;
        emit CooldownSecondsSet(oldCooldownSeconds, _cooldownSeconds);
    }

    function openBatch() external onlyProvider whenNotPaused {
        currentBatchId++;
        batchOpen = true;
        emit BatchOpened(currentBatchId);
    }

    function closeBatch() external onlyProvider whenNotPaused {
        batchOpen = false;
        emit BatchClosed(currentBatchId);
    }

    function submitShip(
        euint32 _typeId,
        euint32 _x,
        euint32 _y,
        euint32 _health,
        uint256 _shipIndex
    ) external onlyProvider whenNotPaused checkSubmissionCooldown checkBatchOpen {
        _initIfNeeded(_typeId);
        _initIfNeeded(_x);
        _initIfNeeded(_y);
        _initIfNeeded(_health);

        // Basic validation (example: coordinates within a 10x10 grid)
        ebool xValid = _x.le(FHE.asEuint32(9));
        ebool yValid = _y.le(FHE.asEuint32(9));
        ebool coordsValid = xValid.eAnd(yValid);
        if (!coordsValid.isInitialized()) revert NotInitialized(); // Ensure FHE ops are done
        if (!coordsValid.toBool()) revert InvalidCoordinates();

        playerShips[msg.sender][_shipIndex] = Ship(_typeId, _x, _y, _health);
        lastSubmissionTime[msg.sender] = block.timestamp;
        emit ShipSubmitted(msg.sender, currentBatchId, _shipIndex);
    }

    function submitMove(
        euint32 _playerId,
        euint32 _targetX,
        euint32 _targetY
    ) external onlyProvider whenNotPaused checkSubmissionCooldown checkBatchOpen {
        _initIfNeeded(_playerId);
        _initIfNeeded(_targetX);
        _initIfNeeded(_targetY);

        // Basic validation (example: coordinates within a 10x10 grid)
        ebool xValid = _targetX.le(FHE.asEuint32(9));
        ebool yValid = _targetY.le(FHE.asEuint32(9));
        ebool coordsValid = xValid.eAnd(yValid);
        if (!coordsValid.isInitialized()) revert NotInitialized(); // Ensure FHE ops are done
        if (!coordsValid.toBool()) revert InvalidCoordinates();

        batchMoves[currentBatchId].push(GameMove(_playerId, _targetX, _targetY));
        lastSubmissionTime[msg.sender] = block.timestamp;
        emit MoveSubmitted(msg.sender, currentBatchId, batchMoves[currentBatchId].length - 1);
    }

    function requestBatchDecryption() external onlyProvider whenNotPaused checkDecryptionCooldown {
        if (batchMoves[currentBatchId].length == 0) revert("No moves to decrypt");

        bytes32[] memory cts = new bytes32[](3 * batchMoves[currentBatchId].length);
        for (uint256 i = 0; i < batchMoves[currentBatchId].length; i++) {
            GameMove storage move = batchMoves[currentBatchId][i];
            cts[3*i] = move.playerId.toBytes32();
            cts[3*i + 1] = move.targetX.toBytes32();
            cts[3*i + 2] = move.targetY.toBytes32();
        }

        bytes32 stateHash = _hashCiphertexts(cts);
        uint256 requestId = FHE.requestDecryption(cts, this.myCallback.selector);
        decryptionContexts[requestId] = DecryptionContext({
            batchId: currentBatchId,
            stateHash: stateHash,
            processed: false
        });
        lastDecryptionRequestTime[msg.sender] = block.timestamp;
        emit DecryptionRequested(requestId, currentBatchId);
    }

    function myCallback(
        uint256 requestId,
        bytes memory cleartexts,
        bytes memory proof
    ) public {
        if (decryptionContexts[requestId].processed) revert ReplayDetected();

        // Rebuild ciphertexts from current storage in the exact same order
        // as during requestBatchDecryption
        uint256 batchId = decryptionContexts[requestId].batchId;
        uint256 numMoves = batchMoves[batchId].length;
        bytes32[] memory currentCts = new bytes32[](3 * numMoves);
        for (uint256 i = 0; i < numMoves; i++) {
            GameMove storage move = batchMoves[batchId][i];
            currentCts[3*i] = move.playerId.toBytes32();
            currentCts[3*i + 1] = move.targetX.toBytes32();
            currentCts[3*i + 2] = move.targetY.toBytes32();
        }

        // Verify state hash
        bytes32 currentStateHash = _hashCiphertexts(currentCts);
        if (currentStateHash != decryptionContexts[requestId].stateHash) {
            revert StateMismatch();
        }

        // Verify proof
        if (!FHE.checkSignatures(requestId, cleartexts, proof)) {
            revert InvalidProof();
        }

        // Decode cleartexts (example: assuming 3 uint32s per move)
        uint256 offset = 0;
        uint256[] memory playerIds = new uint256[](numMoves);
        uint256[] memory targetXs = new uint256[](numMoves);
        uint256[] memory targetYs = new uint256[](numMoves);
        for (uint256 i = 0; i < numMoves; i++) {
            playerIds[i] = abi.decode(cleartexts, (uint256));
            offset += 32;
            cleartexts = cleartexts[offset:];
            targetXs[i] = abi.decode(cleartexts, (uint256));
            offset += 32;
            cleartexts = cleartexts[offset:];
            targetYs[i] = abi.decode(cleartexts, (uint256));
            offset += 32;
            if (offset < cleartexts.length) cleartexts = cleartexts[offset:];
        }
        
        // Mark as processed
        decryptionContexts[requestId].processed = true;
        emit DecryptionCompleted(requestId, batchId);
        // Further game logic using decrypted playerIds, targetXs, targetYs would go here
    }

    function _hashCiphertexts(bytes32[] memory cts) internal pure returns (bytes32) {
        return keccak256(abi.encode(cts, address(this)));
    }

    function _initIfNeeded(euint32 v) internal {
        if (!v.isInitialized()) revert NotInitialized();
    }

    function _requireInitialized(euint32 v) internal pure {
        if (!v.isInitialized()) revert NotInitialized();
    }
}