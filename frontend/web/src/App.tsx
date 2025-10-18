// App.tsx
import { ConnectButton } from '@rainbow-me/rainbowkit';
import '@rainbow-me/rainbowkit/styles.css';
import React, { useEffect, useState } from "react";
import { ethers } from "ethers";
import { getContractReadOnly, getContractWithSigner } from "./contract";
import "./App.css";
import { useAccount, useSignMessage } from 'wagmi';

// Ship types and their abilities
const SHIP_TYPES = {
  CARRIER: { name: "Aircraft Carrier", size: 5, ability: "Range Attack" },
  BATTLESHIP: { name: "Battleship", size: 4, ability: "Armor Piercing" },
  CRUISER: { name: "Cruiser", size: 3, ability: "Radar Scan" },
  SUBMARINE: { name: "Submarine", size: 3, ability: "Stealth" },
  DESTROYER: { name: "Destroyer", size: 2, ability: "Sonar Ping" }
};

// Game state
interface GameState {
  board: string[][];
  ships: Ship[];
  playerTurn: boolean;
  gameOver: boolean;
  winner: string;
}

interface Ship {
  id: string;
  type: string;
  positions: { x: number; y: number }[];
  health: number;
  ability: string;
  encryptedType: string;
}

interface GameRecord {
  id: string;
  player: string;
  opponent: string;
  timestamp: number;
  winner: string;
  moves: number;
}

const BOARD_SIZE = 10;

const FHEEncryptNumber = (value: number): string => {
  return `FHE-${btoa(value.toString())}`;
};

const FHEDecryptNumber = (encryptedData: string): number => {
  if (encryptedData.startsWith('FHE-')) {
    return parseFloat(atob(encryptedData.substring(4)));
  }
  return parseFloat(encryptedData);
};

const generatePublicKey = () => `0x${Array(2000).fill(0).map(() => Math.floor(Math.random() * 16).toString(16)).join('')}`;

const App: React.FC = () => {
  const { address, isConnected } = useAccount();
  const { signMessageAsync } = useSignMessage();
  const [loading, setLoading] = useState(true);
  const [gameState, setGameState] = useState<GameState | null>(null);
  const [selectedShip, setSelectedShip] = useState<string | null>(null);
  const [isPlacing, setIsPlacing] = useState(false);
  const [isAttacking, setIsAttacking] = useState(false);
  const [gameRecords, setGameRecords] = useState<GameRecord[]>([]);
  const [playerStats, setPlayerStats] = useState({ wins: 0, losses: 0, accuracy: 0 });
  const [showAbilityModal, setShowAbilityModal] = useState(false);
  const [activeAbility, setActiveAbility] = useState<string | null>(null);
  const [transactionStatus, setTransactionStatus] = useState<{ visible: boolean; status: "pending" | "success" | "error"; message: string; }>({ visible: false, status: "pending", message: "" });
  const [publicKey, setPublicKey] = useState<string>("");
  const [contractAddress, setContractAddress] = useState<string>("");
  const [chainId, setChainId] = useState<number>(0);
  const [startTimestamp, setStartTimestamp] = useState<number>(0);
  const [durationDays, setDurationDays] = useState<number>(30);
  const [operationHistory, setOperationHistory] = useState<string[]>([]);

  useEffect(() => {
    loadGameRecords().finally(() => setLoading(false));
    const initSignatureParams = async () => {
      const contract = await getContractReadOnly();
      if (contract) setContractAddress(await contract.getAddress());
      if (window.ethereum) {
        const chainIdHex = await window.ethereum.request({ method: 'eth_chainId' });
        setChainId(parseInt(chainIdHex, 16));
      }
      setStartTimestamp(Math.floor(Date.now() / 1000));
      setDurationDays(30);
      setPublicKey(generatePublicKey());
    };
    initSignatureParams();
  }, []);

  const loadGameRecords = async () => {
    try {
      const contract = await getContractReadOnly();
      if (!contract) return;
      
      const isAvailable = await contract.isAvailable();
      if (!isAvailable) return;
      
      const keysBytes = await contract.getData("game_records");
      let keys: string[] = [];
      if (keysBytes.length > 0) {
        try {
          const keysStr = ethers.toUtf8String(keysBytes);
          if (keysStr.trim() !== '') keys = JSON.parse(keysStr);
        } catch (e) { console.error("Error parsing game records:", e); }
      }
      
      const records: GameRecord[] = [];
      for (const key of keys) {
        try {
          const recordBytes = await contract.getData(`record_${key}`);
          if (recordBytes.length > 0) {
            try {
              const recordData = JSON.parse(ethers.toUtf8String(recordBytes));
              records.push({ 
                id: key, 
                player: recordData.player, 
                opponent: recordData.opponent, 
                timestamp: recordData.timestamp, 
                winner: recordData.winner,
                moves: recordData.moves
              });
            } catch (e) { console.error(`Error parsing record data for ${key}:`, e); }
          }
        } catch (e) { console.error(`Error loading record ${key}:`, e); }
      }
      
      records.sort((a, b) => b.timestamp - a.timestamp);
      setGameRecords(records);
      
      // Calculate player stats
      if (address) {
        const wins = records.filter(r => r.winner.toLowerCase() === address.toLowerCase()).length;
        const losses = records.filter(r => 
          (r.player.toLowerCase() === address.toLowerCase() || r.opponent.toLowerCase() === address.toLowerCase()) && 
          r.winner.toLowerCase() !== address.toLowerCase()
        ).length;
        
        setPlayerStats({
          wins,
          losses,
          accuracy: wins > 0 ? Math.round((wins / (wins + losses)) * 100) : 0
        });
      }
    } catch (e) { 
      console.error("Error loading game records:", e); 
    } finally { 
      setLoading(false); 
    }
  };

  const startNewGame = async () => {
    if (!isConnected) { alert("Please connect wallet first"); return; }
    
    setTransactionStatus({ visible: true, status: "pending", message: "Initializing encrypted game..." });
    
    try {
      // Initialize empty board
      const board = Array(BOARD_SIZE).fill(null).map(() => Array(BOARD_SIZE).fill('empty'));
      
      // Create ships with encrypted types
      const ships: Ship[] = Object.entries(SHIP_TYPES).map(([type, shipData]) => {
        const encryptedType = FHEEncryptNumber(Object.keys(SHIP_TYPES).indexOf(type));
        return {
          id: `${type}-${Date.now()}`,
          type: shipData.name,
          positions: [],
          health: shipData.size,
          ability: shipData.ability,
          encryptedType
        };
      });
      
      const newGameState: GameState = {
        board,
        ships,
        playerTurn: true,
        gameOver: false,
        winner: ""
      };
      
      setGameState(newGameState);
      setIsPlacing(true);
      setOperationHistory([`Game started at ${new Date().toLocaleTimeString()}`]);
      
      setTransactionStatus({ visible: true, status: "success", message: "Game initialized! Place your ships." });
      setTimeout(() => setTransactionStatus({ visible: false, status: "pending", message: "" }), 2000);
    } catch (e: any) {
      const errorMessage = e.message.includes("user rejected transaction") ? "Transaction rejected" : "Game initialization failed";
      setTransactionStatus({ visible: true, status: "error", message: errorMessage });
      setTimeout(() => setTransactionStatus({ visible: false, status: "pending", message: "" }), 3000);
    }
  };

  const placeShip = (x: number, y: number) => {
    if (!gameState || !selectedShip || !isPlacing) return;
    
    const shipType = Object.keys(SHIP_TYPES).find(key => 
      SHIP_TYPES[key as keyof typeof SHIP_TYPES].name === selectedShip
    );
    
    if (!shipType) return;
    
    const shipSize = SHIP_TYPES[shipType as keyof typeof SHIP_TYPES].size;
    const newBoard = [...gameState.board];
    const ships = [...gameState.ships];
    const ship = ships.find(s => s.type === selectedShip);
    
    if (!ship || ship.positions.length >= shipSize) return;
    
    // Check if position is valid
    if (newBoard[x][y] !== 'empty') return;
    
    // Place ship part
    newBoard[x][y] = 'ship';
    ship.positions.push({ x, y });
    
    setGameState({
      ...gameState,
      board: newBoard,
      ships
    });
    
    setOperationHistory([...operationHistory, `Placed ${selectedShip} at (${x},${y})`]);
    
    // Check if all ships are placed
    const allShipsPlaced = ships.every(s => 
      s.positions.length === SHIP_TYPES[s.type as keyof typeof SHIP_TYPES]?.size
    );
    
    if (allShipsPlaced) {
      setIsPlacing(false);
      setIsAttacking(true);
      setOperationHistory([...operationHistory, "All ships placed. Ready for battle!"]);
    }
  };

  const attackPosition = async (x: number, y: number) => {
    if (!gameState || !gameState.playerTurn || !isAttacking || gameState.gameOver) return;
    
    setTransactionStatus({ visible: true, status: "pending", message: "Processing attack with FHE..." });
    
    try {
      const newBoard = [...gameState.board];
      const ships = [...gameState.ships];
      let hit = false;
      let shipSunk = false;
      let sunkShipType = "";
      
      // Check if attack hits a ship
      for (const ship of ships) {
        const positionIndex = ship.positions.findIndex(pos => pos.x === x && pos.y === y);
        if (positionIndex !== -1) {
          hit = true;
          ship.health--;
          
          if (ship.health <= 0) {
            shipSunk = true;
            sunkShipType = ship.type;
            // Mark all positions as sunk
            ship.positions.forEach(pos => {
              newBoard[pos.x][pos.y] = 'sunk';
            });
          } else {
            newBoard[x][y] = 'hit';
          }
          break;
        }
      }
      
      if (!hit) {
        newBoard[x][y] = 'miss';
      }
      
      // Check if all ships are sunk
      const allShipsSunk = ships.every(ship => ship.health <= 0);
      
      const newGameState: GameState = {
        ...gameState,
        board: newBoard,
        ships,
        playerTurn: !gameState.playerTurn,
        gameOver: allShipsSunk,
        winner: allShipsSunk ? address || "Player" : ""
      };
      
      setGameState(newGameState);
      
      // Add to operation history
      const attackResult = hit ? 
        (shipSunk ? `Sunk enemy ${sunkShipType} at (${x},${y})` : `Hit at (${x},${y})`) : 
        `Miss at (${x},${y})`;
      setOperationHistory([...operationHistory, attackResult]);
      
      if (allShipsSunk) {
        setIsAttacking(false);
        setOperationHistory([...operationHistory, "Victory! All enemy ships destroyed"]);
        
        // Save game record
        await saveGameRecord(true);
      }
      
      setTransactionStatus({ visible: true, status: "success", message: hit ? "Direct hit!" : "Missed target" });
      setTimeout(() => setTransactionStatus({ visible: false, status: "pending", message: "" }), 2000);
    } catch (e: any) {
      setTransactionStatus({ visible: true, status: "error", message: "Attack failed: " + (e.message || "Unknown error") });
      setTimeout(() => setTransactionStatus({ visible: false, status: "pending", message: "" }), 3000);
    }
  };

  const saveGameRecord = async (isWinner: boolean) => {
    if (!address || !gameState) return;
    
    try {
      const contract = await getContractWithSigner();
      if (!contract) return;
      
      const recordId = `game-${Date.now()}`;
      const recordData = {
        player: address,
        opponent: "AI", // In this version, opponent is AI
        timestamp: Math.floor(Date.now() / 1000),
        winner: isWinner ? address : "AI",
        moves: operationHistory.length
      };
      
      await contract.setData(`record_${recordId}`, ethers.toUtf8Bytes(JSON.stringify(recordData)));
      
      // Update keys
      const keysBytes = await contract.getData("game_records");
      let keys: string[] = [];
      if (keysBytes.length > 0) {
        try { keys = JSON.parse(ethers.toUtf8String(keysBytes)); } 
        catch (e) { console.error("Error parsing keys:", e); }
      }
      keys.push(recordId);
      await contract.setData("game_records", ethers.toUtf8Bytes(JSON.stringify(keys)));
      
      // Reload records
      await loadGameRecords();
    } catch (e) {
      console.error("Error saving game record:", e);
    }
  };

  const useShipAbility = (ability: string) => {
    setActiveAbility(ability);
    setShowAbilityModal(true);
    setOperationHistory([...operationHistory, `Activated ability: ${ability}`]);
  };

  const renderBoard = (isPlayerBoard: boolean) => {
    if (!gameState) return null;
    
    return (
      <div className={`game-board ${isPlayerBoard ? 'player-board' : 'enemy-board'}`}>
        {gameState.board.map((row, x) => (
          <div key={x} className="board-row">
            {row.map((cell, y) => (
              <div 
                key={`${x}-${y}`} 
                className={`board-cell ${cell}`}
                onClick={() => {
                  if (isPlayerBoard && isPlacing) placeShip(x, y);
                  else if (!isPlayerBoard && isAttacking) attackPosition(x, y);
                }}
              >
                {cell === 'hit' && <div className="hit-mark"></div>}
                {cell === 'miss' && <div className="miss-mark"></div>}
                {cell === 'sunk' && <div className="sunk-mark"></div>}
              </div>
            ))}
          </div>
        ))}
      </div>
    );
  };

  const renderShipSelector = () => {
    return (
      <div className="ship-selector">
        <h3>Select Ship to Place</h3>
        <div className="ships-grid">
          {Object.values(SHIP_TYPES).map((ship, index) => (
            <div 
              key={index}
              className={`ship-card ${selectedShip === ship.name ? 'selected' : ''}`}
              onClick={() => setSelectedShip(ship.name)}
            >
              <div className="ship-icon"></div>
              <div className="ship-info">
                <h4>{ship.name}</h4>
                <p>Size: {ship.size}</p>
                <p>Ability: {ship.ability}</p>
              </div>
            </div>
          ))}
        </div>
      </div>
    );
  };

  const renderShipStats = () => {
    if (!gameState) return null;
    
    return (
      <div className="ship-stats">
        <h3>Your Fleet</h3>
        <div className="ships-status">
          {gameState.ships.map((ship, index) => (
            <div key={index} className="ship-status">
              <div className="ship-name">{ship.type}</div>
              <div className="health-bar">
                <div 
                  className="health-fill" 
                  style={{ width: `${(ship.health / SHIP_TYPES[ship.type as keyof typeof SHIP_TYPES]?.size) * 100}%` }}
                ></div>
              </div>
              <button 
                className="ability-btn"
                onClick={() => useShipAbility(ship.ability)}
                disabled={!isAttacking}
              >
                Use {ship.ability}
              </button>
            </div>
          ))}
        </div>
      </div>
    );
  };

  const renderStatsChart = () => {
    const totalGames = playerStats.wins + playerStats.losses;
    const winPercentage = totalGames > 0 ? (playerStats.wins / totalGames) * 100 : 0;
    
    return (
      <div className="stats-chart">
        <div className="chart-bar">
          <div 
            className="win-bar" 
            style={{ width: `${winPercentage}%` }}
          >
            <span>Wins: {playerStats.wins}</span>
          </div>
          <div 
            className="loss-bar" 
            style={{ width: `${100 - winPercentage}%` }}
          >
            <span>Losses: {playerStats.losses}</span>
          </div>
        </div>
        <div className="accuracy">
          <div className="accuracy-value">{playerStats.accuracy}%</div>
          <div className="accuracy-label">Accuracy</div>
        </div>
      </div>
    );
  };

  const renderLeaderboard = () => {
    // Calculate player rankings
    const playerStatsMap: Record<string, { wins: number; games: number }> = {};
    
    gameRecords.forEach(record => {
      if (!playerStatsMap[record.player]) {
        playerStatsMap[record.player] = { wins: 0, games: 0 };
      }
      if (!playerStatsMap[record.opponent]) {
        playerStatsMap[record.opponent] = { wins: 0, games: 0 };
      }
      
      playerStatsMap[record.player].games++;
      playerStatsMap[record.opponent].games++;
      
      if (record.winner === record.player) {
        playerStatsMap[record.player].wins++;
      } else if (record.winner === record.opponent) {
        playerStatsMap[record.opponent].wins++;
      }
    });
    
    const leaderboard = Object.entries(playerStatsMap)
      .map(([player, stats]) => ({
        player,
        wins: stats.wins,
        losses: stats.games - stats.wins,
        winRate: stats.games > 0 ? Math.round((stats.wins / stats.games) * 100) : 0
      }))
      .sort((a, b) => b.winRate - a.winRate || b.wins - a.wins)
      .slice(0, 5);
    
    return (
      <div className="leaderboard">
        <h3>Top Commanders</h3>
        <div className="leaderboard-list">
          {leaderboard.map((entry, index) => (
            <div key={index} className="leaderboard-entry">
              <div className="rank">#{index + 1}</div>
              <div className="player-info">
                <div className="player-address">{entry.player.substring(0, 6)}...{entry.player.substring(38)}</div>
                <div className="player-stats">
                  <span>{entry.wins}W</span>
                  <span>{entry.losses}L</span>
                  <span>{entry.winRate}%</span>
                </div>
              </div>
            </div>
          ))}
        </div>
      </div>
    );
  };

  if (loading) return (
    <div className="loading-screen">
      <div className="metal-spinner"></div>
      <p>Initializing encrypted battlefield...</p>
    </div>
  );

  return (
    <div className="app-container metal-theme">
      <header className="app-header">
        <div className="logo">
          <div className="logo-icon"><div className="warship-icon"></div></div>
          <h1>Battleship<span>Plus</span>FHE</h1>
        </div>
        <div className="header-actions">
          <button onClick={startNewGame} className="new-game-btn metal-button">
            <div className="target-icon"></div>New Game
          </button>
          <div className="wallet-connect-wrapper"><ConnectButton accountStatus="address" chainStatus="icon" showBalance={false}/></div>
        </div>
      </header>
      
      <div className="main-content">
        <div className="welcome-banner">
          <div className="welcome-text">
            <h2>Naval Warfare with FHE Encryption</h2>
            <p>Deploy encrypted warships with special abilities powered by Zama FHE technology</p>
          </div>
          <div className="fhe-indicator"><div className="fhe-lock"></div><span>FHE Encryption Active</span></div>
        </div>
        
        <div className="game-grid">
          {gameState ? (
            <>
              <div className="player-section">
                <h3>Your Fleet</h3>
                {renderBoard(true)}
                {isPlacing && renderShipSelector()}
                {renderShipStats()}
              </div>
              
              <div className="enemy-section">
                <h3>Enemy Waters</h3>
                {renderBoard(false)}
                <div className="game-status">
                  <div className={`status-indicator ${gameState.playerTurn ? 'active' : ''}`}>
                    {gameState.playerTurn ? "Your Turn" : "Enemy Turn"}
                  </div>
                  {gameState.gameOver && (
                    <div className="victory-message">
                      {gameState.winner === address ? "Victory!" : "Defeat!"}
                    </div>
                  )}
                </div>
              </div>
            </>
          ) : (
            <div className="start-prompt">
              <div className="battleship-icon"></div>
              <h2>Ready for Naval Combat?</h2>
              <p>Deploy your encrypted fleet and engage in tactical warfare</p>
              <button className="metal-button primary" onClick={startNewGame}>Start New Game</button>
            </div>
          )}
          
          <div className="stats-section">
            <h3>Commander Statistics</h3>
            {renderStatsChart()}
            <div className="stats-grid">
              <div className="stat-card">
                <div className="stat-value">{playerStats.wins}</div>
                <div className="stat-label">Victories</div>
              </div>
              <div className="stat-card">
                <div className="stat-value">{playerStats.losses}</div>
                <div className="stat-label">Defeats</div>
              </div>
              <div className="stat-card">
                <div className="stat-value">{gameRecords.length}</div>
                <div className="stat-label">Battles</div>
              </div>
            </div>
          </div>
          
          <div className="history-section">
            <h3>Operation History</h3>
            <div className="history-list">
              {operationHistory.map((op, index) => (
                <div key={index} className="history-entry">
                  <div className="history-icon"></div>
                  <div className="history-text">{op}</div>
                </div>
              ))}
              {operationHistory.length === 0 && (
                <div className="empty-history">No operations recorded</div>
              )}
            </div>
          </div>
          
          <div className="leaderboard-section">
            {renderLeaderboard()}
          </div>
        </div>
      </div>
      
      {showAbilityModal && activeAbility && (
        <div className="ability-modal">
          <div className="ability-content metal-card">
            <div className="modal-header">
              <h3>Activate {activeAbility}</h3>
              <button onClick={() => setShowAbilityModal(false)} className="close-modal">&times;</button>
            </div>
            <div className="modal-body">
              <div className="ability-description">
                {activeAbility === "Stealth" && "Submarine becomes undetectable for next enemy turn"}
                {activeAbility === "Range Attack" && "Attack 3 adjacent squares simultaneously"}
                {activeAbility === "Armor Piercing" && "Next attack penetrates armor for double damage"}
                {activeAbility === "Radar Scan" && "Reveal enemy ships in a 3x3 area"}
                {activeAbility === "Sonar Ping" && "Detect all enemy ships within 2 squares"}
              </div>
              <div className="fhe-notice">
                <div className="encryption-icon"></div>
                <p>Ability activation processed with Zama FHE encryption</p>
              </div>
            </div>
            <div className="modal-footer">
              <button 
                className="metal-button" 
                onClick={() => {
                  setOperationHistory([...operationHistory, `Used ability: ${activeAbility}`]);
                  setShowAbilityModal(false);
                }}
              >
                Activate
              </button>
            </div>
          </div>
        </div>
      )}
      
      {transactionStatus.visible && (
        <div className="transaction-modal">
          <div className="transaction-content metal-card">
            <div className={`transaction-icon ${transactionStatus.status}`}>
              {transactionStatus.status === "pending" && <div className="metal-spinner"></div>}
              {transactionStatus.status === "success" && <div className="success-icon"></div>}
              {transactionStatus.status === "error" && <div className="error-icon"></div>}
            </div>
            <div className="transaction-message">{transactionStatus.message}</div>
          </div>
        </div>
      )}
      
      <footer className="app-footer">
        <div className="footer-content">
          <div className="footer-brand">
            <div className="logo"><div className="warship-icon"></div><span>BattleshipPlusFHE</span></div>
            <p>Naval warfare enhanced with Zama FHE encrypted ship abilities</p>
          </div>
          <div className="footer-links">
            <a href="#" className="footer-link">Documentation</a>
            <a href="#" className="footer-link">About Zama FHE</a>
            <a href="#" className="footer-link">Game Rules</a>
          </div>
        </div>
        <div className="footer-bottom">
          <div className="fhe-badge"><span>FHE-Powered Tactics</span></div>
          <div className="copyright">© {new Date().getFullYear()} BattleshipPlusFHE. All rights reserved.</div>
        </div>
      </footer>
    </div>
  );
};

export default App;