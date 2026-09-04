// Unified wallet provider: MetaMask (injected) + WalletConnect via Reown AppKit
import { createAppKit } from "@reown/appkit";
import { EthersAdapter } from "@reown/appkit-adapter-ethers";
import { base } from "@reown/appkit/networks";
import { BrowserProvider } from "ethers";
import UniversalProvider from "@walletconnect/universal-provider";
import { isMobileBrowser, waitForPageFocus } from "./walletFocus";

// --- Configuration ---
// Set VITE_WC_PROJECT_ID in your .env or environment.
// Get a free project ID at https://cloud.walletconnect.com
const PROJECT_ID = import.meta.env.VITE_WC_PROJECT_ID as string | undefined;

let appKit: ReturnType<typeof createAppKit> | null = null;

/** How long to wait for the page to regain focus before sending a sign request anyway. */
const SIGN_FOCUS_TIMEOUT_MS = 60_000;

async function getAppKit() {
  if (appKit) return appKit;
  if (!PROJECT_ID) {
    throw new Error(
      "WalletConnect project ID not configured. Set VITE_WC_PROJECT_ID in your environment."
    );
  }
  const metadata = {
    name: "Coin Pusher",
    description: "Coin Pusher Game",
    url: window.location.origin,
    icons: [],
  };
  // AppKit 1.8 copies only name/description/url/icons into the WalletConnect
  // provider it creates, so `redirect` has to go through our own provider.
  // `redirect` tells a mobile wallet where to send the user back after it
  // approves a session or signs; without it the wallet stays in front and the
  // player has to switch back to the browser by hand.
  const universalProvider = await UniversalProvider.init({
    projectId: PROJECT_ID,
    metadata: { ...metadata, redirect: { universal: window.location.origin } },
  });
  const ethersAdapter = new EthersAdapter();
  appKit = createAppKit({
    adapters: [ethersAdapter],
    networks: [base],
    projectId: PROJECT_ID,
    universalProvider,
    metadata,
    features: {
      analytics: false,
    },
  });
  return appKit;
}

/** Whether WalletConnect is available (projectId configured) */
export function isWalletConnectAvailable(): boolean {
  return !!PROJECT_ID;
}

/** Whether MetaMask (or any injected wallet) is available */
export function isInjectedWalletAvailable(): boolean {
  return !!window.ethereum;
}

/**
 * Connect via injected wallet (MetaMask) and return address + signer-capable provider.
 */
export async function connectInjected(): Promise<{
  address: string;
  sign: (message: string) => Promise<string>;
}> {
  const eth = window.ethereum;
  if (!eth) {
    throw new Error("No wallet found. Please install MetaMask.");
  }
  const accounts = (await eth.request({ method: "eth_requestAccounts" })) as string[];
  if (!accounts.length) {
    throw new Error("No accounts returned from wallet.");
  }
  const address = accounts[0];
  return {
    address,
    sign: async (message: string) => {
      return (await eth.request({
        method: "personal_sign",
        params: [message, address],
      })) as string;
    },
  };
}

/**
 * Connect via WalletConnect (Reown AppKit modal) and return address + signer.
 */
export async function connectWalletConnect(): Promise<{
  address: string;
  sign: (message: string) => Promise<string>;
}> {
  const kit = await getAppKit();

  // Subscribe BEFORE opening to avoid missing state changes
  const connected = await new Promise<boolean>((resolve) => {
    let modalOpened = false;
    const unsub = kit.subscribeState((state) => {
      if (state.open) {
        modalOpened = true;
        return;
      }
      // Only evaluate after modal has been opened at least once
      if (!modalOpened) return;
      // Modal closed — check if we got a connection
      unsub();
      resolve(!!state.selectedNetworkId);
    });
    kit.open();
  });

  if (!connected) {
    throw new Error("Wallet connection cancelled.");
  }

  const address = kit.getAddress();
  if (!address) {
    throw new Error("No address returned from WalletConnect.");
  }

  const walletProvider = kit.getWalletProvider();
  if (!walletProvider) {
    throw new Error("No wallet provider available.");
  }

  const provider = new BrowserProvider(walletProvider as any);
  const signer = await provider.getSigner();

  return {
    address,
    sign: async (message: string) => {
      // Mobile: the wallet app is usually still in front when the session
      // approval lands here. WalletConnect only deep-links the sign request
      // back into the wallet if this page has focus, so wait for the player
      // to return before sending (see walletFocus.ts). The timeout is a
      // safety net: the request still goes out, it just won't auto-open the
      // wallet.
      if (isMobileBrowser()) {
        await waitForPageFocus({ timeoutMs: SIGN_FOCUS_TIMEOUT_MS });
      }
      return await signer.signMessage(message);
    },
  };
}

/** Disconnect WalletConnect session if active */
export async function disconnectWalletConnect(): Promise<void> {
  if (appKit) {
    await appKit.disconnect();
  }
}
