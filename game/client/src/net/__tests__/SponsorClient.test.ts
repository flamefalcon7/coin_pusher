import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  listActiveCampaigns,
  listMyCampaigns,
  createCampaign,
  getBalances,
  pauseCampaign,
  resumeCampaign,
  removeCampaign,
} from "../SponsorClient";

const API_URL = "http://localhost:9000";
const TOKEN = "test-jwt-token";

// ---------------------------------------------------------------------------
// fetch mock
// ---------------------------------------------------------------------------

const mockFetch = vi.fn();

beforeEach(() => {
  vi.stubGlobal("fetch", mockFetch);
});

afterEach(() => {
  vi.restoreAllMocks();
});

function jsonResponse(body: unknown, status = 200) {
  return Promise.resolve({
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(body),
  } as Response);
}

function errorResponse(status: number, body?: unknown) {
  return Promise.resolve({
    ok: false,
    status,
    json: () => (body ? Promise.resolve(body) : Promise.reject()),
  } as Response);
}

// ---------------------------------------------------------------------------
// listActiveCampaigns
// ---------------------------------------------------------------------------

describe("listActiveCampaigns", () => {
  it("fetches active campaigns", async () => {
    const camps = [{ campaign_id: "c1", status: "active" }];
    mockFetch.mockReturnValueOnce(jsonResponse(camps));

    const result = await listActiveCampaigns(API_URL);

    expect(mockFetch).toHaveBeenCalledWith(`${API_URL}/v1/sponsor/campaigns`);
    expect(result).toEqual(camps);
  });

  it("throws on non-ok response", async () => {
    mockFetch.mockReturnValueOnce(errorResponse(500));

    await expect(listActiveCampaigns(API_URL)).rejects.toThrow("500");
  });
});

// ---------------------------------------------------------------------------
// listMyCampaigns
// ---------------------------------------------------------------------------

describe("listMyCampaigns", () => {
  it("sends auth header and returns campaigns", async () => {
    const camps = [{ campaign_id: "c1" }];
    mockFetch.mockReturnValueOnce(jsonResponse(camps));

    const result = await listMyCampaigns(API_URL, TOKEN);

    expect(mockFetch).toHaveBeenCalledWith(
      `${API_URL}/v1/sponsor/campaigns/mine`,
      { headers: { Authorization: `Bearer ${TOKEN}` } }
    );
    expect(result).toEqual(camps);
  });

  it("throws on 401", async () => {
    mockFetch.mockReturnValueOnce(errorResponse(401));

    await expect(listMyCampaigns(API_URL, TOKEN)).rejects.toThrow("401");
  });
});

// ---------------------------------------------------------------------------
// createCampaign
// ---------------------------------------------------------------------------

describe("createCampaign", () => {
  const newCamp = {
    chain: "sui",
    token_address: "0xtok",
    token_symbol: "FLAME",
    token_decimals: 9,
    brand_color: "#FF0000",
    brand_name: "TestBrand",
    pool_total: "10000",
    reward_per_coin: "100",
  };

  it("posts campaign and returns result", async () => {
    const created = { campaign_id: "c1", ...newCamp, status: "active" };
    mockFetch.mockReturnValueOnce(jsonResponse(created, 201));

    const result = await createCampaign(API_URL, TOKEN, newCamp);

    expect(mockFetch).toHaveBeenCalledWith(`${API_URL}/v1/sponsor/campaign`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${TOKEN}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(newCamp),
    });
    expect(result.campaign_id).toBe("c1");
  });

  it("throws with server error message", async () => {
    mockFetch.mockReturnValueOnce(
      errorResponse(400, { error: "brand_name is required" })
    );

    await expect(createCampaign(API_URL, TOKEN, newCamp)).rejects.toThrow(
      "brand_name is required"
    );
  });

  it("throws with status code when no error body", async () => {
    mockFetch.mockReturnValueOnce(errorResponse(500));

    await expect(createCampaign(API_URL, TOKEN, newCamp)).rejects.toThrow(
      "500"
    );
  });
});

// ---------------------------------------------------------------------------
// getBalances
// ---------------------------------------------------------------------------

describe("getBalances", () => {
  it("fetches balances with auth", async () => {
    const bals = [{ campaign_id: "c1", balance: "500" }];
    mockFetch.mockReturnValueOnce(jsonResponse(bals));

    const result = await getBalances(API_URL, TOKEN);

    expect(mockFetch).toHaveBeenCalledWith(`${API_URL}/v1/sponsor/balances`, {
      headers: { Authorization: `Bearer ${TOKEN}` },
    });
    expect(result).toEqual(bals);
  });

  it("throws on error", async () => {
    mockFetch.mockReturnValueOnce(errorResponse(403));

    await expect(getBalances(API_URL, TOKEN)).rejects.toThrow("403");
  });
});

// ---------------------------------------------------------------------------
// Admin actions: pause / resume / remove
// ---------------------------------------------------------------------------

describe("pauseCampaign", () => {
  it("sends PUT with auth", async () => {
    mockFetch.mockReturnValueOnce(jsonResponse({ status: "paused" }));

    await pauseCampaign(API_URL, TOKEN, "camp-1");

    expect(mockFetch).toHaveBeenCalledWith(
      `${API_URL}/v1/admin/sponsor/campaign/camp-1/pause`,
      { method: "PUT", headers: { Authorization: `Bearer ${TOKEN}` } }
    );
  });

  it("throws on failure", async () => {
    mockFetch.mockReturnValueOnce(
      errorResponse(403, { error: "admin only" })
    );

    await expect(pauseCampaign(API_URL, TOKEN, "camp-1")).rejects.toThrow(
      "admin only"
    );
  });
});

describe("resumeCampaign", () => {
  it("sends PUT with auth", async () => {
    mockFetch.mockReturnValueOnce(jsonResponse({ status: "active" }));

    await resumeCampaign(API_URL, TOKEN, "camp-1");

    expect(mockFetch).toHaveBeenCalledWith(
      `${API_URL}/v1/admin/sponsor/campaign/camp-1/resume`,
      { method: "PUT", headers: { Authorization: `Bearer ${TOKEN}` } }
    );
  });
});

describe("removeCampaign", () => {
  it("sends DELETE with auth", async () => {
    mockFetch.mockReturnValueOnce(jsonResponse({ status: "expired" }));

    await removeCampaign(API_URL, TOKEN, "camp-1");

    expect(mockFetch).toHaveBeenCalledWith(
      `${API_URL}/v1/admin/sponsor/campaign/camp-1`,
      { method: "DELETE", headers: { Authorization: `Bearer ${TOKEN}` } }
    );
  });

  it("throws on failure", async () => {
    mockFetch.mockReturnValueOnce(errorResponse(500));

    await expect(removeCampaign(API_URL, TOKEN, "camp-1")).rejects.toThrow(
      "500"
    );
  });
});
