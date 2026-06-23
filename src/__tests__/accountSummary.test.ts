/**
 * Unit tests for the account-summary aggregate logic.
 *
 * We test the in-memory accumulation logic directly by importing a helper,
 * and the API route using supertest with the DB layer mocked.
 */

import { createApp } from "../api";
import supertest from "supertest";
import { getAccountSummary } from "../db";

vi.mock("../db", async (importOriginal) => {
  const mod = await importOriginal();
  return {
    ...mod,
    getAccountSummary: vi.fn(),
    queryTransfers: vi.fn().mockResolvedValue({ total: 0, transfers: [] }),
    queryAllTransfers: vi.fn().mockResolvedValue({ total: 0, transfers: [] }),
    queryByTxHash: vi.fn().mockResolvedValue([]),
    querySummary: vi.fn().mockResolvedValue([]),
    getLastIndexedLedger: vi.fn().mockResolvedValue(1000),
    prisma: { $queryRaw: vi.fn().mockResolvedValue([{ "?column?": 1 }]) },
  };
});

vi.mock("../rpc", () => ({
  getLatestLedger: vi.fn().mockResolvedValue(1002),
  validateNetworkConfig: vi.fn(),
}));

vi.mock("../indexer", () => ({
  getIndexerStats: vi.fn().mockReturnValue({ startedAt: "2024-01-01T00:00:00Z", uptimeSeconds: 0, totalIndexed: 0 }),
}));

const ALICE = "GDWCO35QUYQLGO6P7OLW4BZWNMMGGUWNPLRVPLCBVG7YNVDZKUDIW4KN";
const CONTRACT = "CBC42KFZO33TYVFDOUXFRWXYYXHFGH7W5GM4IJQSXKGFINKL2XPP4XTE";

describe("GET /accounts/:address/summary", () => {
  const app = createApp();

  it("returns 200 with one asset row per contract", async () => {
    getAccountSummary.mockResolvedValueOnce([
      {
        contractId:     CONTRACT,
        totalSent:      "5000000000",
        totalReceived:  "10000000000",
        net:            "5000000000",
        txCount:        3,
        lastActivityAt: new Date("2024-06-01T00:00:00Z"),
      },
    ]);

    const res = await supertest(app).get(`/accounts/${ALICE}/summary`);

    expect(res.status).toBe(200);
    expect(res.body.address).toBe(ALICE);
    expect(res.body.assets).toHaveLength(1);

    const asset = res.body.assets[0];
    expect(asset.contractId).toBe(CONTRACT);
    expect(asset.totalSent).toBe("5000000000");
    expect(asset.totalReceived).toBe("10000000000");
    expect(asset.net).toBe("5000000000");
    expect(asset.txCount).toBe(3);
    // Display amounts should be formatted with 7 decimals
    expect(asset.displayTotalSent).toBe("500.0000000");
    expect(asset.displayTotalReceived).toBe("1000.0000000");
  });

  it("returns empty assets array when address has no transfers", async () => {
    getAccountSummary.mockResolvedValueOnce([]);

    const res = await supertest(app).get(`/accounts/${ALICE}/summary`);

    expect(res.status).toBe(200);
    expect(res.body.assets).toHaveLength(0);
  });

  it("passes contractId query param to DB layer", async () => {
    getAccountSummary.mockResolvedValueOnce([]);

    await supertest(app).get(`/accounts/${ALICE}/summary?contractId=${CONTRACT}`);

    expect(getAccountSummary).toHaveBeenCalledWith(ALICE, CONTRACT);
  });

  it("returns multiple asset rows for multi-token accounts", async () => {
    const CONTRACT2 = "CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC";
    getAccountSummary.mockResolvedValueOnce([
      { contractId: CONTRACT,  totalSent: "1000", totalReceived: "2000", net: "1000",  txCount: 1, lastActivityAt: new Date() },
      { contractId: CONTRACT2, totalSent: "500",  totalReceived: "0",    net: "-500",  txCount: 1, lastActivityAt: new Date() },
    ]);

    const res = await supertest(app).get(`/accounts/${ALICE}/summary`);

    expect(res.status).toBe(200);
    expect(res.body.assets).toHaveLength(2);
  });
});
