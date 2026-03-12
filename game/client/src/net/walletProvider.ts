// Unified wallet provider: MetaMask (injected) + WalletConnect via Reown AppKit
import { createAppKit } from "@reown/appkit";
import { EthersAdapter } from "@reown/appkit-adapter-ethers";
import { base } from "@reown/appkit/networks";
import { BrowserProvider } from "ethers";

// --- Configuration ---
// Set VITE_WC_PROJECT_ID in your .env or environment.
// Get a free project ID at https://cloud.walletconnect.com
const PROJECT_ID = import.meta.env.VITE_WC_PROJECT_ID as string | undefined;

let appKit: ReturnType<typeof createAppKit> | null = null;

function getAppKit() {
  if (appKit) return appKit;
  if (!PROJECT_ID) {
    throw new Error(
      "WalletConnect project ID not configured. Set VITE_WC_PROJECT_ID in your environment."
    );
  }
  const ethersAdapter = new EthersAdapter();
  appKit = createAppKit({
    adapters: [ethersAdapter],
    networks: [base],
    projectId: PROJECT_ID,
    metadata: {
      name: "Coin Pusher",
      description: "Coin Pusher Game",
      url: window.location.origin,
      icons: [],
    },
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
  const kit = getAppKit();

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
