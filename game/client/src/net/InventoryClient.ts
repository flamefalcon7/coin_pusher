// REST client for inventory / chest endpoints

export interface InventoryResponse {
  key_coins: number;
  scroll_shock: number;
  scroll_tornado: number;
  scroll_explosion: number;
  scroll_lightning: number;
  scroll_super_push: number;
  megaspeaker: number;
}

export interface ChestOpenResponse {
  scroll_type: string;
  scroll_count: number;
  balance_play?: string;
}

export class InventoryClient {
  private baseUrl: string;

  constructor(baseUrl: string) {
    this.baseUrl = baseUrl;
  }

  async getInventory(token: string): Promise<InventoryResponse> {
    const res = await fetch(`${this.baseUrl}/v1/inventory`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) {
      throw new Error(`Failed to fetch inventory: ${res.status}`);
    }
    return res.json();
  }

  async openChest(token: string): Promise<ChestOpenResponse> {
    const res = await fetch(`${this.baseUrl}/v1/chest/open`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) {
      throw new Error(`Failed to open chest: ${res.status}`);
    }
    return res.json();
  }
}
