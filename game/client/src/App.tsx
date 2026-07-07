import { useEffect, useRef, useState, useCallback } from "react";
import { useLocation } from "react-router-dom";
import "./App.css";
import { HUD } from "./ui/HUD";
import { CoinInsertButton } from "./ui/CoinInsertButton";
import { ConnectionStatus } from "./ui/ConnectionStatus";
import { Toolbar, type ScrollCounts } from "./ui/Toolbar";
import { HoleTooltip, HoleTooltipData } from "./ui/HoleTooltip";
import { Leaderboard, type LeaderboardEntry } from "./ui/Leaderboard";
import { ComboCounter } from "./ui/ComboCounter";
import { KeyCoinDrawOverlay } from "./ui/KeyCoinDrawOverlay";
import { AbilityToast, type AbilityToastEntry } from "./ui/AbilityToast";
import { InventoryBar } from "./ui/InventoryBar";
import { WalletLogin } from "./ui/WalletLogin";
import { SpectatorBanner } from "./ui/SpectatorBanner";
import { getSavedAuth, getSavedAddress, clearAuth, saveAuth, updateSavedBalance, type AuthResult, type Account } from "./net/auth";
import { InventoryClient } from "./net/InventoryClient";
import { getProfile } from "./net/ProfileClient";
import { MegaspeakerPanel, type MegaspeakerMsg } from "./ui/MegaspeakerPanel";
import { TargetingHint } from "./ui/TargetingHint";
import { IdleWarningBanner, IdleTimeoutOverlay } from "./ui/IdleOverlay";
import { PlayerInfo } from "./ui/PlayerInfo";
// import { SponsorBalances } from "./ui/SponsorBalances"; // hidden until deposit gate
import { TutorialOverlay, shouldShowTutorial } from "./ui/TutorialOverlay";
import { ChestPage } from "./pages/ChestPage";
import { DepositPage } from "./pages/DepositPage";
import { WithdrawPage } from "./pages/WithdrawPage";
import { ProgressPage } from "./pages/ProgressPage";
import { ProfilePage } from "./pages/ProfilePage";
// import { SponsorPage } from "./pages/SponsorPage"; // hidden until deposit gate
// import { AdminSponsorsPage } from "./pages/AdminSponsorsPage"; // hidden until deposit gate

import { SceneManager } from "./scene/SceneManager";
import { BonusDropVFX } from "./scene/BonusDropVFX";
import { ToonDebugGUI } from "./scene/ToonDebugGUI";
import { SceneDebugGUI } from "./scene/SceneDebugGUI";
import { extendDebugApi, type DebugAbilityName } from "./scene/DebugReadout";
import { buildSceneDump } from "./scene/DebugDump";
import { GameClient } from "./net/GameClient";
import { SLOT_CONFIG, RATE_LIMIT_CONFIG, RANK_NONE, SCENE_CONFIG, type EditorObjectNet } from "@coin-pusher/shared";
import { Vector3 } from "@babylonjs/core";
import { EditorManager, GizmoMode } from "./editor/EditorManager";
import { EditorPanel } from "./editor/EditorPanel";
import { EditorObjectData } from "./editor/EditorObject";

// Auto-detect WS/API host from browser location so mobile on same WiFi works.
// Use secure protocols (wss/https) when served over HTTPS, plain for local dev.
const isSecure = window.location.protocol === "https:";
const WS_URL = import.meta.env.VITE_WS_URL || `${isSecure ? "wss" : "ws"}://${window.location.hostname}:4000/ws`;
const API_URL = import.meta.env.VITE_API_URL || `${isSecure ? "https" : "http"}://${window.location.hostname}:4000`;

function App() {
  const [auth, setAuth] = useState(() => getSavedAuth());
  const [address, setAddress] = useState(() => getSavedAddress() ?? '');
  const [showLoginModal, setShowLoginModal] = useState(false);

  const handleLoginSuccess = useCallback((result: AuthResult) => {
    setAuth({ token: result.token, account: result.account });
    setAddress(getSavedAddress() ?? '');
    setShowLoginModal(false);
  }, []);

  const handleAuthFailure = useCallback(() => {
    clearAuth();
    setAuth(null);
  }, []);

  const handleRequestLogin = useCallback(() => {
    setShowLoginModal(true);
  }, []);

  return (
    <>
      <Game
        token={auth?.token ?? null}
        account={auth?.account ?? null}
        address={address}
        onAuthFailure={handleAuthFailure}
        onRequestLogin={handleRequestLogin}
      />
      {showLoginModal && (
        <WalletLogin
          apiBase={API_URL}
          onSuccess={handleLoginSuccess}
          onClose={() => setShowLoginModal(false)}
        />
      )}
    </>
  );
}

interface GameProps {
  token: string | null;
  account: Account | null;
  address: string;
  onAuthFailure: () => void;
  onRequestLogin: () => void;
}

function Game({ token, account, address, onAuthFailure, onRequestLogin }: GameProps) {
  const isSpectator = !token;
  const location = useLocation();
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const sceneManagerRef = useRef<SceneManager | null>(null);
  const gameClientRef = useRef<GameClient | null>(null);
  const toonGuiRef = useRef<ToonDebugGUI | null>(null);

  const [fps, setFps] = useState(0);
  const [ping, setPing] = useState(0);
  const [activeCoinCount, setActiveCoinCount] = useState(0);
  const [connectionStatus, setConnectionStatus] = useState<
    "connecting" | "connected" | "disconnected"
  >("disconnected");
  const [buttonDisabled, setButtonDisabled] = useState(false);
  const [shockCooldown, setShockCooldown] = useState(false);
  const [tornadoCooldown, setTornadoCooldown] = useState(false);
  const [tornadoTargeting, setTornadoTargeting] = useState(false);
  const [explosionCooldown, setExplosionCooldown] = useState(false);
  const [explosionTargeting, setExplosionTargeting] = useState(false);
  const [lightningCooldown, setLightningCooldown] = useState(false);
  const [superPushCooldown, setSuperPushCooldown] = useState(false);
  const [isTesting, setIsTesting] = useState(false);
  const [themeName, setThemeName] = useState("Psychedelic Pop");
  const [celShading, setCelShading] = useState(true);
  const [muted, setMuted] = useState(false);
  const [devToolsOpen, setDevToolsOpen] = useState(false);
  const [slotCounter, setSlotCounter] = useState(0);
  const [wheelCounter, setWheelCounter] = useState(0);
  const [holeTooltip, setHoleTooltip] = useState<HoleTooltipData | null>(null);
  const lastHolePickTime = useRef(0);
  const [leaderboard, setLeaderboard] = useState<LeaderboardEntry[]>([]);
  const [myRankEntry, setMyRankEntry] = useState<LeaderboardEntry | null>(null);
  const [slotCounts, setSlotCounts] = useState<number[]>([0, 0, 0, 0, 0]);
  const [rewardToast, setRewardToast] = useState<{ amount: number; id: number } | null>(null);
  const rewardIdRef = useRef(0);
  const [insertAckMsg, setInsertAckMsg] = useState<string | null>(null);
  const [insertRejected, setInsertRejected] = useState(false);

  // Inventory state
  const [keyCoins, setKeyCoins] = useState(0);
  const [scrollCounts, setScrollCounts] = useState<ScrollCounts>({
    shock: 0, tornado: 0, explosion: 0, lightning: 0, superPush: 0, megaspeaker: 0,
  });
  const [megaspeakerCount, setMegaspeakerCount] = useState(0);
  const [megaspeakerMessages, setMegaspeakerMessages] = useState<MegaspeakerMsg[]>([]);
  const [idleWarning, setIdleWarning] = useState(false);
  const [idleTimeout, setIdleTimeout] = useState(false);
  const [megaspeakerOpen, setMegaspeakerOpen] = useState(false);
  const [showTutorial, setShowTutorial] = useState(() => shouldShowTutorial());
  const [megaspeakerUnread, setMegaspeakerUnread] = useState(0);
  const megaspeakerOpenRef = useRef(false);
  const [keyCoinDraw, setKeyCoinDraw] = useState<{
    winnerName: string; winnerId: string; count: number; isMe: boolean; id: number;
  } | null>(null);
  const keyCoinDrawIdRef = useRef(0);
  const [abilityToasts, setAbilityToasts] = useState<AbilityToastEntry[]>([]);
  const abilityToastIdRef = useRef(0);
  // Track which coin IDs are key coins for rendering
  const keyCoinIdsRef = useRef<Set<number>>(new Set());
  // Track which coin IDs are sponsor coins (coinId -> sponsorId)
  const sponsorCoinIdsRef = useRef<Map<number, string>>(new Map());
  // Top-5 leaderboard userId -> rank color index (0-4)
  const top5MapRef = useRef<Map<string, number>>(new Map());
  const bonusDropVFXRef = useRef<BonusDropVFX | null>(null);
  const [_sponsorBalances, setSponsorBalances] = useState<Array<{ campaign_id: string; token_symbol: string; balance: string }>>([]);
  const lastRequestedAmount = useRef(0);
  const [balance, _setBalance] = useState<string>(account?.balance_play ?? "0");
  const [balanceCash, _setBalanceCash] = useState<string>(account?.balance_cash ?? "0");

  const setBalance = useCallback((val: string | ((prev: string) => string)) => {
    _setBalance((prev) => {
      const next = typeof val === "function" ? val(prev) : val;
      updateSavedBalance(next, undefined);
      return next;
    });
  }, []);

  const setBalanceCash = useCallback((val: string | ((prev: string) => string)) => {
    _setBalanceCash((prev) => {
      const next = typeof val === "function" ? val(prev) : val;
      updateSavedBalance(undefined, next);
      return next;
    });
  }, []);

  // Refresh balance from server on mount (sessionStorage may be stale).
  useEffect(() => {
    if (!token) return;
    getProfile(API_URL, token).then((fresh) => {
      setBalance(fresh.balance_play);
      setBalanceCash(fresh.balance_cash);
      saveAuth(token, fresh);
    }).catch(() => { /* ignore — stale token will be caught elsewhere */ });
  }, [token]); // eslint-disable-line react-hooks/exhaustive-deps

  // Editor state
  const editorManagerRef = useRef<EditorManager | null>(null);
  const [editorActive, setEditorActive] = useState(false);
  const [editorObjects, setEditorObjects] = useState<EditorObjectData[]>([]);
  const [selectedObjectId, setSelectedObjectId] = useState<string | null>(null);
  const [gizmoMode, setGizmoMode] = useState<GizmoMode>("position");

  useEffect(() => {
    if (!canvasRef.current) return;

    // Initialize scene
    const sceneManager = new SceneManager(canvasRef.current, account?.role === "admin");
    sceneManagerRef.current = sceneManager;

    // Initialize game client (token may be null for spectators)
    const gameClient = new GameClient(WS_URL, token ?? undefined);
    gameClientRef.current = gameClient;

    // Agent perception debug API (no-op unless ?debug=1 installed the surface).
    // dump() = structured scene state (R1); actions = same code paths as the
    // real UI handlers, routed through a ref so they never go stale (R5).
    extendDebugApi({
      dump: () =>
        buildSceneDump({
          scene: sceneManager.getScene(),
          getCoinCount: () => sceneManager.getCoinCount(),
          getLatestAuthoritativeState: () =>
            gameClientRef.current?.getLatestAuthoritativeState() ?? null,
        }),
      actions: {
        insertCoin: (slot = 2, count = 1) => debugActionsRef.current.insertCoin(slot, count),
        // Default placement targets the platform center (config-derived so it
        // tracks the same value the tuning HUD exposes, not a copied literal).
        triggerAbility: (name, x = 0, z = SCENE_CONFIG.PLATFORM.POSITION.z) =>
          debugActionsRef.current.triggerAbility(name, x, z),
      },
    });
    // Collider wireframes (R3) track the same authoritative poses as dump().
    sceneManager.setDebugPoseProvider(
      () => gameClientRef.current?.getLatestAuthoritativeState() ?? null,
    );

    // Tuning HUD (R4): only when the ?debug=1 surface was installed.
    let sceneDebugGui: SceneDebugGUI | null = null;
    if (window.__coinpusher_debug) {
      sceneDebugGui = new SceneDebugGUI(sceneManager.getScene(), (on) =>
        window.__coinpusher_debug?.wireframe?.(on),
      );
    }

    // Handle auth failure (WS closed with 4401/4403)
    gameClient.onAuthFailure(onAuthFailure);

    // Set FPS callback
    sceneManager.setFpsCallback((fps) => {
      setFps(fps);
    });

    // Set connection status callback
    gameClient.onConnectionStatus((status) => {
      setConnectionStatus(status);
    });

    // Set ping callback
    gameClient.onPing((ping) => {
      setPing(ping);
    });

    // Set slot machine callbacks
    gameClient.onSlotSpin((reels, jackpot) => {
      sceneManager.playSlotSpin(reels, jackpot);
    });

    gameClient.onSlotCounter((counter) => {
      sceneManager.updateSlotCounter(counter);
      setSlotCounter(counter);
    });

    // Set jackpot wheel callbacks
    gameClient.onWheelSpin((segment, reward) => {
      sceneManager.spinJackpotWheel(segment, reward);
    });

    gameClient.onWheelCounter((counter) => {
      sceneManager.updateWheelCounter(counter);
      setWheelCounter(counter);
    });

    // Set ability event callback — plays VFX/sound + syncs cooldown for ALL clients
    gameClient.onAbilityEvent((ability, x, z, username) => {
      if (username) {
        abilityToastIdRef.current++;
        setAbilityToasts((prev) => [...prev, { id: abilityToastIdRef.current, username, ability }].slice(-3));
      }
      const platformY = 0.25 + 0.05 / 2;
      switch (ability) {
        case "shock":
          sceneManager.playShockEffect();
          sceneManager.getSoundManager().playShock();
          setShockCooldown(true);
          setTimeout(() => setShockCooldown(false), RATE_LIMIT_CONFIG.SHOCK_COOLDOWN);
          break;
        case "tornado":
          if (x !== undefined && z !== undefined) {
            sceneManager.playTornadoEffect(new Vector3(x, platformY, z));
          }
          setTornadoCooldown(true);
          setTimeout(() => setTornadoCooldown(false), RATE_LIMIT_CONFIG.TORNADO_COOLDOWN);
          break;
        case "explosion":
          if (x !== undefined && z !== undefined) {
            sceneManager.playExplosionEffect(new Vector3(x, platformY, z));
          }
          setExplosionCooldown(true);
          setTimeout(() => setExplosionCooldown(false), RATE_LIMIT_CONFIG.EXPLOSION_COOLDOWN);
          break;
        case "lightning":
          sceneManager.playLightningEffect();
          setLightningCooldown(true);
          setTimeout(() => setLightningCooldown(false), RATE_LIMIT_CONFIG.LIGHTNING_COOLDOWN);
          break;
        case "superPush":
          sceneManager.playSuperPushEffect();
          setSuperPushCooldown(true);
          setTimeout(() => setSuperPushCooldown(false), RATE_LIMIT_CONFIG.SUPER_PUSH_COOLDOWN);
          break;
      }
    });

    // Set up heat system callbacks
    gameClient.onCoinSpawn((coins) => {
      const myUserId = gameClient.getUserId();
      for (const coin of coins) {
        const rankIndex = coin.owner_id ? top5MapRef.current.get(coin.owner_id) : undefined;
        if (rankIndex !== undefined) {
          sceneManager.addCoinHighlight(coin.id, rankIndex);
        } else if (coin.owner_id === myUserId) {
          sceneManager.addCoinHighlight(coin.id, RANK_NONE);
        }
        if (coin.is_key_coin) {
          keyCoinIdsRef.current.add(coin.id);
        }
        if (coin.sponsor_id) {
          sponsorCoinIdsRef.current.set(coin.id, coin.sponsor_id);
        }
      }
    });

    gameClient.onHeatUpdate((players) => {
      const myUserId = gameClient.getUserId();
      const sorted = [...players].sort((a, b) => b.share - a.share);
      const top5 = sorted.slice(0, 5).map((p, i) => ({
        user_id: p.user_id,
        username: p.username,
        share: p.share,
        rank: i + 1,
      }));
      setLeaderboard(top5);

      const newMap = new Map<string, number>();
      for (let i = 0; i < top5.length; i++) {
        newMap.set(top5[i].user_id, i);
      }
      top5MapRef.current = newMap;

      const myIdx = sorted.findIndex(p => p.user_id === myUserId);
      if (myIdx >= 0) {
        const p = sorted[myIdx];
        setMyRankEntry({ user_id: p.user_id, username: p.username, share: p.share, rank: myIdx + 1 });
      } else {
        setMyRankEntry(null);
      }
    });

    gameClient.onSlotStatus((counts) => {
      setSlotCounts(counts);
    });

    gameClient.onBatchInsertAck((queued, error, balPlay, balCash) => {
      if (balPlay !== undefined) setBalance(balPlay);
      if (balCash !== undefined) setBalanceCash(balCash);
      if (error === "table_full") {
        setInsertAckMsg("Table is full!");
        setTimeout(() => setInsertAckMsg(null), 2000);
      } else if (error === "slot_full") {
        setInsertAckMsg("Slot is full!");
        setTimeout(() => setInsertAckMsg(null), 2000);
      } else if (error) {
        setInsertAckMsg(error);
        setTimeout(() => setInsertAckMsg(null), 2000);
      } else if (queued < lastRequestedAmount.current && lastRequestedAmount.current > 0) {
        setInsertAckMsg(`Only ${queued}/${lastRequestedAmount.current} accepted`);
        setTimeout(() => setInsertAckMsg(null), 2000);
      }
      lastRequestedAmount.current = 0;
    });

    gameClient.onReward((userId, amount, bal) => {
      const myUserId = gameClient.getUserId();
      if (userId === myUserId) {
        if (bal) {
          setBalanceCash(bal);
        } else {
          setBalanceCash((prev) => (parseFloat(prev) + amount).toFixed(6));
        }
        rewardIdRef.current++;
        setRewardToast({ amount, id: rewardIdRef.current });
      }
    });

    gameClient.onKeyCoinDraw((winnerId, winnerName, count) => {
      const myUserId = gameClient.getUserId();
      keyCoinDrawIdRef.current++;
      setKeyCoinDraw({
        winnerName,
        winnerId,
        count,
        isMe: winnerId === myUserId,
        id: keyCoinDrawIdRef.current,
      });
    });

    gameClient.onInventoryUpdate((inv) => {
      setKeyCoins(inv.key_coins);
      setMegaspeakerCount(inv.megaspeaker);
      setScrollCounts({
        shock: inv.scroll_shock,
        tornado: inv.scroll_tornado,
        explosion: inv.scroll_explosion,
        lightning: inv.scroll_lightning,
        superPush: inv.scroll_super_push,
        megaspeaker: inv.megaspeaker,
      });
    });

    gameClient.onMegaspeaker((speakerName, message, timestamp) => {
      setMegaspeakerMessages((prev) => [...prev.slice(-49), { speakerName, message, timestamp }]);
      if (!megaspeakerOpenRef.current) {
        setMegaspeakerUnread((prev) => prev + 1);
      }
      sceneManager.getSoundManager().playMegaspeaker();
    });

    gameClient.onMegaspeakerError((error) => {
      console.warn("Megaspeaker error:", error);
    });

    gameClient.onIdleWarning(() => {
      setIdleWarning(true);
    });

    gameClient.onIdleTimeout(() => {
      setIdleTimeout(true);
    });

    // Sponsor message handlers
    gameClient.onSponsorConfig((sponsors) => {
      sceneManager.updateSponsorConfig(sponsors);
    });

    const bonusVFX = new BonusDropVFX();
    bonusDropVFXRef.current = bonusVFX;
    gameClient.onBonusDrop((msg) => {
      bonusVFX.showBonusDrop(msg.sponsor_name, msg.token_symbol, "#4ECDC4", msg.coin_count);
    });

    gameClient.onSponsorReward((msg) => {
      setSponsorBalances((prev) => {
        const idx = prev.findIndex(b => b.campaign_id === msg.campaign_id);
        if (idx >= 0) {
          const updated = [...prev];
          updated[idx] = { campaign_id: msg.campaign_id, token_symbol: msg.token_symbol, balance: msg.total_balance };
          return updated;
        }
        return [...prev, { campaign_id: msg.campaign_id, token_symbol: msg.token_symbol, balance: msg.total_balance }];
      });
    });

    // Connect to server
    gameClient.connect();

    // Fetch initial inventory (only when authenticated)
    if (token) {
      const inventoryClient = new InventoryClient(API_URL);
      inventoryClient.getInventory(token).then((inv) => {
        setKeyCoins(inv.key_coins);
        setMegaspeakerCount(inv.megaspeaker);
        setScrollCounts({
          shock: inv.scroll_shock,
          tornado: inv.scroll_tornado,
          explosion: inv.scroll_explosion,
          lightning: inv.scroll_lightning,
          superPush: inv.scroll_super_push,
          megaspeaker: inv.megaspeaker,
        });
      }).catch((err) => {
        console.warn("Failed to fetch inventory:", err);
      });
    }

    // Start render loop with interpolation
    sceneManager.startRenderLoop();

    // Initialize editor manager
    const editorManager = new EditorManager(sceneManager.getScene());
    editorManagerRef.current = editorManager;
    editorManager.setOnChange((objects, selectedId) => {
      setEditorObjects([...objects]);
      setSelectedObjectId(selectedId);
      setGizmoMode(editorManager.getGizmoMode());

      // Sync editor objects to game server for physics
      const netObjects: EditorObjectNet[] = objects.map((obj) => ({
        id: obj.id,
        type: obj.type,
        position: obj.position,
        rotation: obj.rotation,
        scale: obj.scale,
      }));
      gameClient.updateSceneObjects(netObjects);
    });

    // Track known coin IDs
    const knownCoins = new Set<number>();

    // Reusable set for reconciliation — cleared each frame instead of re-allocated
    const currentCoinIds = new Set<number>();

    // Track last reported coin count to avoid unnecessary React re-renders
    let lastReportedCoinCount = 0;

    // Game state update runs inside Babylon's render loop via registerBeforeRender.
    // This eliminates the desync between two independent rAF loops that caused
    // 27% of frames to exceed 20ms (profiled data).
    let lastUpdateTime = performance.now();

    sceneManager.onBeforeRender(() => {
      const currentTime = performance.now();
      const deltaTime = currentTime - lastUpdateTime;
      lastUpdateTime = currentTime;

      // Update game client (check for pings, etc.)
      gameClient.update();

      // Get interpolated state
      const state = gameClient.getInterpolatedState();
      if (state) {
        // Check if this is the first frame after a world_snapshot
        const isSnapshotFrame = gameClient.consumeSnapshotFlag();
        if (isSnapshotFrame) {
          knownCoins.clear();
          sceneManager.clearCoins();
          // Seed key coin IDs from snapshot body types
          const snapshotKeyCoinIds = gameClient.consumeSnapshotKeyCoinIds();
          if (snapshotKeyCoinIds) {
            keyCoinIdsRef.current = snapshotKeyCoinIds;
          }
          // Seed sponsor coin IDs from snapshot body types
          const snapshotSponsorCoinIds = gameClient.consumeSnapshotSponsorCoinIds();
          if (snapshotSponsorCoinIds) {
            for (const [coinId, sponsorId] of snapshotSponsorCoinIds) {
              sponsorCoinIdsRef.current.set(coinId, sponsorId);
            }
          }
        }

        // Update pusher position
        sceneManager.updatePusherPosition(state.pusherZ);

        // Update coins — reuse the Set instead of allocating a new one
        currentCoinIds.clear();
        const coins = state.coins;

        for (let i = 0, len = coins.length; i < len; i++) {
          const coin = coins[i];
          currentCoinIds.add(coin.id);

          if (!knownCoins.has(coin.id)) {
            // New coin — check if it's a key coin or sponsor coin
            const isKeyCoin = keyCoinIdsRef.current.has(coin.id);
            const sponsorId = sponsorCoinIdsRef.current.get(coin.id);
            if (sponsorId) {
              sceneManager.addCoinWithSponsor(coin.id, coin.pos, coin.rot, isKeyCoin, sponsorId);
            } else {
              sceneManager.addCoin(coin.id, coin.pos, coin.rot, isKeyCoin);
            }
            knownCoins.add(coin.id);
            // Skip sound for snapshot coins (bulk load on connect/reconnect)
            if (!isSnapshotFrame) {
              sceneManager.getSoundManager().playCoinLand();
            }
          } else {
            // Update existing coin
            sceneManager.updateCoin(coin.id, coin.pos, coin.rot);
          }
        }

        // Remove despawned coins (coins no longer in interpolated state
        // have been removed by the Interpolator via despawn messages)
        let despawnCount = 0;
        for (const id of knownCoins) {
          if (!currentCoinIds.has(id)) {
            sceneManager.removeCoinWithEffect(id);
            knownCoins.delete(id);
            keyCoinIdsRef.current.delete(id);
            sponsorCoinIdsRef.current.delete(id);
            despawnCount++;
          }
        }
        if (despawnCount > 0) {
          sceneManager.getSoundManager().playCoinDespawn(despawnCount);
        }

        // Batch update coin instances to GPU (pass dt in seconds for animations)
        sceneManager.updateCoinBuffers(deltaTime / 1000);
        sceneManager.updateCoinHighlights();

        // Only trigger React re-render when coin count actually changes
        const size = knownCoins.size;
        if (size !== lastReportedCoinCount) {
          lastReportedCoinCount = size;
          setActiveCoinCount(size);
        }
      }
    });

    // Cleanup on unmount
    return () => {
      if (testIntervalRef.current) {
        clearInterval(testIntervalRef.current);
        testIntervalRef.current = null;
      }
      toonGuiRef.current?.dispose();
      toonGuiRef.current = null;
      sceneDebugGui?.dispose();
      sceneDebugGui = null;
      editorManager.dispose();
      gameClient.dispose();
      sceneManager.dispose();
      bonusDropVFXRef.current?.dispose();
      bonusDropVFXRef.current = null;
    };
  }, []);

  // Handle token transitions:
  //   null→string: spectator→authenticated (reconnect with token, fetch inventory)
  //   string→null: auth failure/logout (fall back to spectator)
  const prevTokenRef = useRef(token);
  useEffect(() => {
    if (!gameClientRef.current) return;

    if (token && !prevTokenRef.current) {
      // Spectator → Authenticated
      gameClientRef.current.reconnectWithToken(token);

      // Sync balance from the fresh account data
      if (account) {
        setBalance(account.balance_play);
        setBalanceCash(account.balance_cash);
      }

      // Fetch inventory now that we're authenticated
      const inventoryClient = new InventoryClient(API_URL);
      inventoryClient.getInventory(token).then((inv) => {
        setKeyCoins(inv.key_coins);
        setMegaspeakerCount(inv.megaspeaker);
        setScrollCounts({
          shock: inv.scroll_shock,
          tornado: inv.scroll_tornado,
          explosion: inv.scroll_explosion,
          lightning: inv.scroll_lightning,
          superPush: inv.scroll_super_push,
          megaspeaker: inv.megaspeaker,
        });
      }).catch((err) => {
        console.warn("Failed to fetch inventory:", err);
      });
    } else if (!token && prevTokenRef.current) {
      // Authenticated → Spectator (auth failure / logout)
      gameClientRef.current.reconnectAsSpectator();
      setMyRankEntry(null);
    }

    prevTokenRef.current = token;
  }, [token]);

  // Toggle editor mode
  const toggleEditor = useCallback(() => {
    const mgr = editorManagerRef.current;
    if (!mgr) return;
    const next = !mgr.isActive();
    mgr.setActive(next);
    setEditorActive(next);
  }, []);

  // Keyboard controls for stack spawning (Dev/Test feature) and editor toggle
  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      // Don't handle shortcuts when typing in an input
      if ((event.target as HTMLElement).tagName === "INPUT") return;

      // ESC cancels targeting
      if (event.key === "Escape") {
        if (tornadoTargeting || explosionTargeting) {
          setTornadoTargeting(false);
          setExplosionTargeting(false);
          sceneManagerRef.current?.hideTargetingReticle();
        }
        return;
      }

      // Editor toggle — admin only
      if ((event.key === "e" || event.key === "E") && account?.role === "admin") {
        toggleEditor();
        return;
      }

      // Delete selected editor object — admin only (editor requires admin)
      if ((event.key === "Delete" || event.key === "Backspace") && editorManagerRef.current?.isActive()) {
        editorManagerRef.current.removeSelected();
        return;
      }

      // Dev/test keyboard shortcuts — admin only
      if (!gameClientRef.current || !gameClientRef.current.isConnected() || account?.role !== "admin")
        return;

      const x = 0; // Center spawn for stacks

      switch (event.key) {
        case "1":
          sceneManagerRef.current?.enableBatchAnimation();
          gameClientRef.current.spawnStack("wall", x);
          break;
        case "2":
          sceneManagerRef.current?.enableBatchAnimation();
          gameClientRef.current.spawnStack("tower", x);
          break;
        case "3":
          sceneManagerRef.current?.enableBatchAnimation();
          gameClientRef.current.spawnStack("pyramid", x);
          break;
        case "4":
          sceneManagerRef.current?.enableBatchAnimation();
          gameClientRef.current.spawnStack("pyramid3bleLayer", x);
          break;
        case "5":
          sceneManagerRef.current?.enableBatchAnimation();
          gameClientRef.current.spawnStack("cylinder", x);
          break;
        case "0":
          gameClientRef.current.clearAll();
          break;
        case "9":
          gameClientRef.current.fillPlatform();
          break;
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => {
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [toggleEditor, tornadoTargeting, explosionTargeting, account?.role]);

  // Latest UI action handlers for debug action injection (R5). The debug API
  // closure is registered once in the init effect; routing through this ref
  // keeps it pointing at the current render's handlers (fresh balance state).
  const debugActionsRef = useRef<{
    insertCoin: (slot: number, count: number) => void;
    triggerAbility: (name: DebugAbilityName, x: number, z: number) => void;
  }>({ insertCoin: () => {}, triggerAbility: () => {} });

  const handleInsertCoin = (slotIndex: number, count: number = 1) => {
    if (!gameClientRef.current || !gameClientRef.current.isConnected()) {
      console.warn("Not connected to server");
      return;
    }

    // Unified wallet: guard against the combined total (play + withdrawable).
    // The server does play-first draw and will only reject if
    // balance_play + balance_cash < count. Checking play alone here would
    // block valid inserts that should fall through to withdrawable balance.
    const total = parseFloat(balance) + parseFloat(balanceCash);
    if (!Number.isFinite(total) || total < count) {
      setInsertAckMsg("Not enough coins!");
      setInsertRejected(true);
      setTimeout(() => { setInsertAckMsg(null); setInsertRejected(false); }, 2000);
      return;
    }

    setIdleWarning(false);
    lastRequestedAmount.current = count;
    gameClientRef.current.batchInsert(slotIndex, count);
    sceneManagerRef.current?.getSoundManager().playCoinInsert();
    sceneManagerRef.current?.playCoinInsertVFX(slotIndex);

    setButtonDisabled(true);
    setTimeout(() => setButtonDisabled(false), 100);
  };

  const handleShock = () => {
    if (!gameClientRef.current || !gameClientRef.current.isConnected() || shockCooldown) {
      return;
    }
    setIdleWarning(false);
    gameClientRef.current.shock();
    // VFX/sound/cooldown now synced via server ability broadcast
  };

  const handleTornadoClick = () => {
    if (!gameClientRef.current || !gameClientRef.current.isConnected() || tornadoCooldown) {
      return;
    }
    if (tornadoTargeting) {
      // Toggle cancel
      setTornadoTargeting(false);
      sceneManagerRef.current?.hideTargetingReticle();
      return;
    }
    // Cancel explosion targeting if active
    if (explosionTargeting) {
      setExplosionTargeting(false);
    }
    setTornadoTargeting(true);
    sceneManagerRef.current?.showTargetingReticle('tornado');
  };

  const handleTornadoPlace = (x: number, z: number) => {
    if (!gameClientRef.current || !gameClientRef.current.isConnected()) return;
    setIdleWarning(false);
    sceneManagerRef.current?.confirmTargetingReticle();
    gameClientRef.current.tornado(x, z);
    // VFX/cooldown now synced via server ability broadcast
    setTornadoTargeting(false);
  };

  const handleExplosionClick = () => {
    if (!gameClientRef.current || !gameClientRef.current.isConnected() || explosionCooldown) {
      return;
    }
    if (explosionTargeting) {
      // Toggle cancel
      setExplosionTargeting(false);
      sceneManagerRef.current?.hideTargetingReticle();
      return;
    }
    // Cancel tornado targeting if active
    if (tornadoTargeting) {
      setTornadoTargeting(false);
    }
    setExplosionTargeting(true);
    sceneManagerRef.current?.showTargetingReticle('explosion');
  };

  const handleExplosionPlace = (x: number, z: number) => {
    if (!gameClientRef.current || !gameClientRef.current.isConnected()) return;
    setIdleWarning(false);
    sceneManagerRef.current?.confirmTargetingReticle();
    gameClientRef.current.explosion(x, z);
    // VFX/cooldown now synced via server ability broadcast
    setExplosionTargeting(false);
  };

  const handleLightning = () => {
    if (!gameClientRef.current || !gameClientRef.current.isConnected() || lightningCooldown) {
      return;
    }
    setIdleWarning(false);
    gameClientRef.current.lightning();
    // VFX/cooldown now synced via server ability broadcast
  };

  const handleSuperPush = () => {
    if (!gameClientRef.current || !gameClientRef.current.isConnected() || superPushCooldown) {
      return;
    }
    setIdleWarning(false);
    gameClientRef.current.superPush();
    // VFX/cooldown now synced via server ability broadcast
  };

  // Refresh debug action injection targets every render (see debugActionsRef).
  debugActionsRef.current = {
    insertCoin: handleInsertCoin,
    triggerAbility: (name, x, z) => {
      switch (name) {
        case "shock":
          handleShock();
          break;
        case "tornado":
          handleTornadoPlace(x, z);
          break;
        case "explosion":
          handleExplosionPlace(x, z);
          break;
        case "lightning":
          handleLightning();
          break;
        case "superPush":
        case "super_push":
          handleSuperPush();
          break;
        default:
          // Surface a mistyped ability name instead of silently no-op'ing —
          // an agent driving this via evaluate_script gets no other signal.
          console.warn(`[debug] triggerAbility: unknown ability "${name}"`);
      }
    },
  };

  const handleCanvasPointerDown = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (!tornadoTargeting && !explosionTargeting) return;

    // On mobile (touch), pointerDown is the first contact — update reticle
    // position so the user can see where it'll land, then drag to adjust.
    // Placement is confirmed on pointerUp.
    const scene = sceneManagerRef.current?.getScene();
    if (!scene) return;

    const pickResult = scene.pick(e.nativeEvent.offsetX, e.nativeEvent.offsetY);
    if (pickResult?.hit && pickResult.pickedPoint) {
      sceneManagerRef.current?.updateTargetingReticle(pickResult.pickedPoint);
      if (!sceneManagerRef.current?.isTargetingReticleVisible()) {
        const type = tornadoTargeting ? 'tornado' : 'explosion';
        sceneManagerRef.current?.showTargetingReticle(type);
      }
    }
  };

  const handleCanvasPointerUp = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (!tornadoTargeting && !explosionTargeting) return;

    const scene = sceneManagerRef.current?.getScene();
    if (!scene) return;

    const pickResult = scene.pick(e.nativeEvent.offsetX, e.nativeEvent.offsetY);
    if (pickResult?.hit && pickResult.pickedPoint) {
      if (tornadoTargeting) {
        handleTornadoPlace(pickResult.pickedPoint.x, pickResult.pickedPoint.z);
      } else if (explosionTargeting) {
        handleExplosionPlace(pickResult.pickedPoint.x, pickResult.pickedPoint.z);
      }
    } else {
      // Cancel targeting if released outside platform
      setTornadoTargeting(false);
      setExplosionTargeting(false);
      sceneManagerRef.current?.hideTargetingReticle();
    }
  };

  const handleCanvasPointerMove = (e: React.PointerEvent<HTMLCanvasElement>) => {
    // Throttle to ~30fps
    const now = performance.now();
    if (now - lastHolePickTime.current < 33) return;
    lastHolePickTime.current = now;

    const scene = sceneManagerRef.current?.getScene();
    if (!scene) return;

    const pickResult = scene.pick(e.nativeEvent.offsetX, e.nativeEvent.offsetY);

    // Update targeting reticle position
    if (tornadoTargeting || explosionTargeting) {
      if (pickResult?.hit && pickResult.pickedPoint) {
        sceneManagerRef.current?.updateTargetingReticle(pickResult.pickedPoint);
        // Show reticle if it was hidden (mouse re-entered platform)
        if (!sceneManagerRef.current?.isTargetingReticleVisible()) {
          const type = tornadoTargeting ? 'tornado' : 'explosion';
          sceneManagerRef.current?.showTargetingReticle(type);
        }
      } else {
        // Mouse off platform — hide reticle
        sceneManagerRef.current?.hideTargetingReticle();
      }
    }

    if (pickResult?.hit && pickResult.pickedMesh?.metadata?.holeId) {
      setHoleTooltip({
        holeId: pickResult.pickedMesh.metadata.holeId,
        x: e.clientX,
        y: e.clientY,
      });
    } else {
      setHoleTooltip(null);
    }
  };

  const handleCycleTheme = () => {
    const label = sceneManagerRef.current?.cycleTheme();
    if (label) setThemeName(label);
  };

  const handleToggleCel = () => {
    const enabled = sceneManagerRef.current?.toggleCelShading();
    if (enabled !== undefined) setCelShading(enabled);
  };

  const handleToggleMute = () => {
    const sm = sceneManagerRef.current?.getSoundManager();
    if (sm) {
      const nowMuted = sm.toggleMute();
      setMuted(nowMuted);
    }
  };

  const testIntervalRef = useRef<number | null>(null);

  const handleTestLoop = () => {
    if (isTesting || !gameClientRef.current?.isConnected()) return;

    setIsTesting(true);
    let count = 0;
    const maxCoins = 200;
    const intervalTime = 60; // ms — must be above COIN_INSERT_COOLDOWN (50ms)

    const interval = window.setInterval(() => {
      if (count >= maxCoins) {
        clearInterval(interval);
        testIntervalRef.current = null;
        setIsTesting(false);
        return;
      }

      // Pick a random slot index (0 to 4)
      const randomSlotIndex = Math.floor(
        Math.random() * SLOT_CONFIG.POSITIONS.length
      );
      handleInsertCoin(randomSlotIndex);

      count++;
    }, intervalTime);
    testIntervalRef.current = interval;
  };

  const handleToggleToonDebug = useCallback(() => {
    if (toonGuiRef.current) {
      toonGuiRef.current.dispose();
      toonGuiRef.current = null;
    } else if (sceneManagerRef.current) {
      toonGuiRef.current = new ToonDebugGUI(sceneManagerRef.current);
    }
  }, []);

  const handleEditorObjectsChange = useCallback(() => {
    const mgr = editorManagerRef.current;
    if (!mgr) return;
    setEditorObjects([...mgr.getObjects()]);
    setSelectedObjectId(mgr.getSelectedId());
    setGizmoMode(mgr.getGizmoMode());
  }, []);

  const handleInventoryChange = useCallback((newKeyCoins: number, newScrollCounts: ScrollCounts) => {
    setKeyCoins(newKeyCoins);
    setScrollCounts(newScrollCounts);
    setMegaspeakerCount(newScrollCounts.megaspeaker);
  }, []);

  const handleMegaspeakerToggle = useCallback(() => {
    setMegaspeakerOpen((prev) => {
      const next = !prev;
      megaspeakerOpenRef.current = next;
      if (next) setMegaspeakerUnread(0);
      return next;
    });
  }, []);

  const handleMegaspeakerSend = useCallback((msg: string) => {
    gameClientRef.current?.sendMegaspeaker(msg);
  }, []);

  const showChestPage = location.pathname === '/chest';
  const showDepositPage = location.pathname === '/deposit';
  const showWithdrawPage = location.pathname === '/withdraw';
  const showProgressPage = location.pathname === '/progress';
  const showProfilePage = location.pathname === '/profile';
  // const showSponsorPage = location.pathname === '/sponsor'; // hidden until deposit gate
  // const showAdminSponsors = location.pathname === '/admin/sponsors'; // hidden until deposit gate

  const handleCashBalanceChange = useCallback((newBalance: string) => {
    setBalanceCash(newBalance);
  }, []);

  return (
    <div id="app-container">
      <ConnectionStatus status={connectionStatus} />

      {/* PlayerInfo (authenticated) or SpectatorBanner */}
      {isSpectator ? (
        <SpectatorBanner onConnectWallet={onRequestLogin} />
      ) : (
        <PlayerInfo balancePlay={balance} balanceCash={balanceCash} displayName={account?.display_name ?? null} address={address} role={account?.role} onLogout={onAuthFailure} />
      )}



      <HUD fps={fps} ping={ping} activeCoin={activeCoinCount} />

      {/* Toolbar — hidden for spectators */}
      {!isSpectator && (
        <Toolbar
          muted={muted}
          onToggleMute={handleToggleMute}
          celShading={celShading}
          onToggleCel={handleToggleCel}
          themeName={themeName}
          onCycleTheme={handleCycleTheme}
          onShock={handleShock}
          shockDisabled={connectionStatus !== "connected"}
          shockCooldown={shockCooldown}
          onTornado={handleTornadoClick}
          tornadoDisabled={connectionStatus !== "connected"}
          tornadoCooldown={tornadoCooldown}
          tornadoTargeting={tornadoTargeting}
          onExplosion={handleExplosionClick}
          explosionDisabled={connectionStatus !== "connected"}
          explosionCooldown={explosionCooldown}
          explosionTargeting={explosionTargeting}
          onLightning={handleLightning}
          lightningDisabled={connectionStatus !== "connected"}
          lightningCooldown={lightningCooldown}
          onSuperPush={handleSuperPush}
          superPushDisabled={connectionStatus !== "connected"}
          superPushCooldown={superPushCooldown}
          scrollCounts={scrollCounts}
        />
      )}

      {account?.role === "admin" && (
        <button
          className={`editor-toggle-btn ${editorActive ? "active" : ""}`}
          onClick={toggleEditor}
        >
          Editor [E]
        </button>
      )}
      {account?.role === "admin" && editorActive && editorManagerRef.current && (
        <EditorPanel
          manager={editorManagerRef.current}
          objects={editorObjects}
          selectedId={selectedObjectId}
          gizmoMode={gizmoMode}
          onObjectsChange={handleEditorObjectsChange}
        />
      )}
      <div id="canvas-container">
        <canvas
          ref={canvasRef}
          id="babylon-canvas"
          onPointerDown={handleCanvasPointerDown}
          onPointerUp={handleCanvasPointerUp}
          onPointerMove={handleCanvasPointerMove}
          onPointerLeave={() => {
            setHoleTooltip(null);
            if (tornadoTargeting || explosionTargeting) {
              sceneManagerRef.current?.hideTargetingReticle();
            }
          }}
          onContextMenu={(e) => {
            if (tornadoTargeting || explosionTargeting) {
              e.preventDefault();
              setTornadoTargeting(false);
              setExplosionTargeting(false);
              sceneManagerRef.current?.hideTargetingReticle();
            }
          }}
          style={tornadoTargeting || explosionTargeting ? { cursor: "crosshair" } : undefined}
        />
      </div>

      <TargetingHint
        visible={tornadoTargeting || explosionTargeting}
        abilityName={tornadoTargeting ? 'Tornado' : 'Explosion'}
        onCancel={() => {
          setTornadoTargeting(false);
          setExplosionTargeting(false);
          sceneManagerRef.current?.hideTargetingReticle();
        }}
      />

      {/* Dev tools — admin only */}
      {account?.role === "admin" && (
        <div className="dev-tools-corner">
          <button
            className="dev-tools-toggle"
            onClick={() => setDevToolsOpen(!devToolsOpen)}
          >
            Dev {devToolsOpen ? "▲" : "▼"}
          </button>
          {devToolsOpen && (
            <div className="dev-tools-panel">
              <button
                onClick={handleTestLoop}
                disabled={isTesting || connectionStatus !== "connected"}
                className="dev-button"
              >
                {isTesting ? "Testing..." : "Insert 200 Coins"}
              </button>
              <button
                onClick={() => gameClientRef.current?.clearAll()}
                disabled={connectionStatus !== "connected"}
                className="dev-button"
              >
                Clear All [0]
              </button>
              <button
                onClick={() => gameClientRef.current?.fillPlatform()}
                disabled={connectionStatus !== "connected"}
                className="dev-button"
              >
                Fill Platform [9]
              </button>
              <button
                onClick={() => sceneManagerRef.current?.playRewardCoinRain()}
                className="dev-button"
              >
                Coin Rain
              </button>
              <button
                onClick={() => sceneManagerRef.current?.playRewardTicketRain()}
                className="dev-button"
              >
                Ticket Rain
              </button>
              <button
                onClick={handleToggleToonDebug}
                className="dev-button"
              >
                Toon Debug
              </button>
            </div>
          )}
        </div>
      )}

      {/* CoinInsertButton — spectators see "Connect Wallet to Play" */}
      {isSpectator ? (
        <div className="spectator-insert-cta">
          <button className="spectator-insert-btn" onClick={onRequestLogin}>
            PUSH!
          </button>
        </div>
      ) : (
        <CoinInsertButton
          onClick={handleInsertCoin}
          disabled={buttonDisabled || connectionStatus !== "connected"}
          slotCounts={slotCounts}
          ackMessage={insertAckMsg}
          rejected={insertRejected}
        />
      )}

      {/* Read-only broadcast components — always visible */}
      {leaderboard.length > 0 && (
        <Leaderboard
          entries={leaderboard}
          myEntry={myRankEntry}
          myUserId={gameClientRef.current?.getUserId() ?? ""}
        />
      )}

      <ComboCounter
        rewardId={rewardToast?.id ?? 0}
        rewardAmount={rewardToast?.amount ?? 0}
      />

      {holeTooltip && (
        <HoleTooltip data={holeTooltip} slotCounter={slotCounter} wheelCounter={wheelCounter} />
      )}

      {/* InventoryBar — hidden for spectators */}
      {!isSpectator && <InventoryBar keyCoins={keyCoins} />}

      <KeyCoinDrawOverlay
        draw={keyCoinDraw}
        players={leaderboard.map(e => ({ user_id: e.user_id, username: e.username }))}
      />

      <AbilityToast
        entries={abilityToasts}
        onRemove={(id) => setAbilityToasts((prev) => prev.filter((e) => e.id !== id))}
      />

      {/* Sub-pages — gated behind auth */}
      {!isSpectator && showChestPage && (
        <ChestPage
          token={token!}
          apiUrl={API_URL}
          keyCoins={keyCoins}
          scrollCounts={scrollCounts}
          onInventoryChange={handleInventoryChange}
          onBalanceChange={setBalance}
          soundManager={sceneManagerRef.current?.getSoundManager() ?? null}
        />
      )}

      {!isSpectator && showDepositPage && (
        <DepositPage
          token={token!}
          apiUrl={API_URL}
        />
      )}

      {!isSpectator && showWithdrawPage && (
        <WithdrawPage
          token={token!}
          apiUrl={API_URL}
          balanceCash={balanceCash}
          onBalanceChange={handleCashBalanceChange}
        />
      )}

      {!isSpectator && showProgressPage && (
        <ProgressPage
          token={token!}
          apiUrl={API_URL}
          onBalanceChange={(play, cash) => {
            setBalance(play);
            setBalanceCash(cash);
          }}
        />
      )}

      {!isSpectator && showProfilePage && (
        <ProfilePage
          token={token!}
          apiUrl={API_URL}
          address={address}
        />
      )}

      {/* Sponsor pages disabled until deposit gate is implemented */}

      {/* MegaspeakerPanel — read-only for spectators (disable send) */}
      <MegaspeakerPanel
        messages={megaspeakerMessages}
        megaspeakerCount={isSpectator ? 0 : megaspeakerCount}
        onSend={handleMegaspeakerSend}
        unreadCount={megaspeakerUnread}
        onToggle={handleMegaspeakerToggle}
        isOpen={megaspeakerOpen}
      />

      {/* Idle / spectator timeout overlays */}
      {!isSpectator && idleWarning && !idleTimeout && <IdleWarningBanner />}
      {!isSpectator && idleTimeout && <IdleTimeoutOverlay />}
      {isSpectator && idleTimeout && (
        <div className="spectator-timeout-overlay">
          <div className="spectator-timeout-card">
            <p className="spectator-timeout-text">Spectator session ended</p>
            <button className="spectator-timeout-btn" onClick={onRequestLogin}>
              Connect Wallet to Keep Playing
            </button>
            <button className="spectator-timeout-reload" onClick={() => window.location.reload()}>
              Continue Watching
            </button>
          </div>
        </div>
      )}

      {/* Tutorial — hidden for spectators */}
      {!isSpectator && showTutorial && connectionStatus === 'connected' && (
        <TutorialOverlay onComplete={() => setShowTutorial(false)} />
      )}
    </div>
  );
}

export default App;
