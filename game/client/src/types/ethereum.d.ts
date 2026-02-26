interface EthereumProvider {
  request(args: { method: string; params?: unknown[] }): Promise<unknown>;
  isMetaMask?: boolean;
}

interface Window {
  ethereum?: EthereumProvider;
}
