/**
 * Tests for the webhook delivery system.
 *
 * Covers:
 *   - HMAC signature generation and verification
 *   - Filter evaluation (contract, from, to, min_amount)
 *   - REST endpoints (POST/GET/DELETE /webhooks, GET /webhooks/:id/deliveries)
 *     with the DB layer mocked
 */

import crypto from "crypto";
import supertest from "supertest";
import { createApp } from "../api";
import { signPayload, matchesFilter } from "../workers/webhooks";
import type { TransferEvent } from "../events";
import { prisma } from "../db";

// ─── Mock DB + dependencies ───────────────────────────────────────────────────
vi.mock("../db", async (importOriginal) => {
  const mod = await importOriginal();
  return {
    ...mod,
    prisma: {
      webhookSubscription: {
        create:   vi.fn(),
        findMany: vi.fn().mockResolvedValue([]),
        findUnique: vi.fn(),
        delete:   vi.fn(),
      },
      webhookDelivery: {
        findMany: vi.fn().mockResolvedValue([]),
        count:    vi.fn().mockResolvedValue(0),
      },
      $transaction: vi.fn(async (ops: Promise<unknown>[]) => Promise.all(ops)),
      $queryRaw: vi.fn().mockResolvedValue([{ "?column?": 1 }]),
      tokenTransfer: {
        count:    vi.fn().mockResolvedValue(0),
        findMany: vi.fn().mockResolvedValue([]),
      },
      indexerState: { findUnique: vi.fn().mockResolvedValue(null) },
    },
    getLastIndexedLedger: vi.fn().mockResolvedValue(1000),
    queryTransfers:    vi.fn().mockResolvedValue({ total: 0, transfers: [] }),
    queryAllTransfers: vi.fn().mockResolvedValue({ total: 0, transfers: [] }),
    queryByTxHash:     vi.fn().mockResolvedValue([]),
    querySummary:      vi.fn().mockResolvedValue([]),
  };
});

vi.mock("../rpc", () => ({
  getLatestLedger:      vi.fn().mockResolvedValue(1002),
  validateNetworkConfig: vi.fn(),
}));

vi.mock("../indexer", () => ({
  getIndexerStats: vi.fn().mockReturnValue({
    startedAt: "2024-01-01T00:00:00Z",
    uptimeSeconds: 0,
    totalIndexed: 0,
  }),
}));

// Prevent the webhook worker from starting during API tests
vi.mock("../workers/webhooks", async (importOriginal) => {
  const mod = await importOriginal();
  return { ...mod, startWebhookWorker: vi.fn() };
});

// ─── Helpers ─────────────────────────────────────────────────────────────────
const makeTransfer = (overrides: Partial<TransferEvent> = {}): TransferEvent => ({
  contractId:     "CBC42KFZO33TYVFDOUXFRWXYYXHFGH7W5GM4IJQSXKGFINKL2XPP4XTE",
  eventType:      "transfer",
  fromAddress:    "GDWCO35QUYQLGO6P7OLW4BZWNMMGGUWNPLRVPLCBVG7YNVDZKUDIW4KN",
  toAddress:      "GCXOO7OIJZ2HEOZODLOEISNVO6CBPK4PISRJCZYRFT37H7XGHDLB3C7O",
  amount:         "1000000000",
  ledger:         100,
  ledgerClosedAt: new Date("2024-01-01T00:00:00Z"),
  txHash:         "abc123",
  eventId:        "0001-0001",
  ...overrides,
});

// ─── signPayload ──────────────────────────────────────────────────────────────
describe("signPayload", () => {
  it("produces a sha256= prefixed hex string", () => {
    const sig = signPayload("mysecret", '{"hello":"world"}');
    expect(sig).toMatch(/^sha256=[0-9a-f]{64}$/);
  });

  it("is verifiable with Node crypto", () => {
    const secret = "supersecret";
    const body   = '{"test":true}';
    const sig    = signPayload(secret, body);
    const expected = "sha256=" + crypto.createHmac("sha256", secret).update(body).digest("hex");
    expect(sig).toBe(expected);
  });

  it("different secrets produce different signatures", () => {
    const body = '{"x":1}';
    expect(signPayload("secret-a", body)).not.toBe(signPayload("secret-b", body));
  });
});

// ─── matchesFilter ────────────────────────────────────────────────────────────
describe("matchesFilter", () => {
  const t = makeTransfer();

  it("null filter matches everything", () => {
    expect(matchesFilter(t, null)).toBe(true);
  });

  it("empty filter object matches everything", () => {
    expect(matchesFilter(t, {})).toBe(true);
  });

  it("contract filter: match", () => {
    expect(matchesFilter(t, { contract: t.contractId })).toBe(true);
  });

  it("contract filter: no match", () => {
    expect(matchesFilter(t, { contract: "CDIFFERENT" })).toBe(false);
  });

  it("from filter: match", () => {
    expect(matchesFilter(t, { from: t.fromAddress! })).toBe(true);
  });

  it("from filter: no match", () => {
    expect(matchesFilter(t, { from: "GDIFFERENT" })).toBe(false);
  });

  it("to filter: match", () => {
    expect(matchesFilter(t, { to: t.toAddress! })).toBe(true);
  });

  it("min_amount: passes when amount >= min", () => {
    expect(matchesFilter(t, { min_amount: "500000000" })).toBe(true);
  });

  it("min_amount: blocked when amount < min", () => {
    expect(matchesFilter(t, { min_amount: "2000000000" })).toBe(false);
  });

  it("combined filter: all conditions must match", () => {
    expect(matchesFilter(t, { contract: t.contractId, from: t.fromAddress! })).toBe(true);
    expect(matchesFilter(t, { contract: t.contractId, from: "GDIFF" })).toBe(false);
  });
});

// ─── REST endpoints ───────────────────────────────────────────────────────────
describe("POST /webhooks", () => {
  const app = createApp();

  beforeEach(() => vi.clearAllMocks());

  it("creates a subscription and returns 201", async () => {
    prisma.webhookSubscription.create.mockResolvedValueOnce({
      id: 1, url: "https://example.com/hook", filter: null, active: true,
      createdAt: new Date(),
    });

    const res = await supertest(app).post("/webhooks").send({
      url:    "https://example.com/hook",
      secret: "s3cr3t",
    });

    expect(res.status).toBe(201);
    expect(res.body.id).toBe(1);
    expect(res.body).not.toHaveProperty("secret"); // secret must not leak
  });

  it("returns 400 when url is missing", async () => {
    const res = await supertest(app).post("/webhooks").send({ secret: "x" });
    expect(res.status).toBe(400);
  });

  it("returns 400 when secret is missing", async () => {
    const res = await supertest(app).post("/webhooks").send({ url: "https://x.com" });
    expect(res.status).toBe(400);
  });

  it("returns 400 for unknown filter keys", async () => {
    const res = await supertest(app).post("/webhooks").send({
      url: "https://x.com", secret: "s", filter: { unknown_key: "x" },
    });
    expect(res.status).toBe(400);
  });
});

describe("GET /webhooks", () => {
  const app = createApp();

  it("returns subscription list without secrets", async () => {
    prisma.webhookSubscription.findMany.mockResolvedValueOnce([
      { id: 1, url: "https://a.com", filter: null, active: true, createdAt: new Date(), updatedAt: new Date() },
    ]);

    const res = await supertest(app).get("/webhooks");
    expect(res.status).toBe(200);
    expect(res.body.subscriptions).toHaveLength(1);
    expect(res.body.subscriptions[0]).not.toHaveProperty("secret");
  });
});

describe("DELETE /webhooks/:id", () => {
  const app = createApp();

  it("deletes an existing subscription", async () => {
    prisma.webhookSubscription.findUnique.mockResolvedValueOnce({ id: 1 });
    prisma.webhookSubscription.delete.mockResolvedValueOnce({ id: 1 });

    const res = await supertest(app).delete("/webhooks/1");
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  });

  it("returns 404 when subscription does not exist", async () => {
    prisma.webhookSubscription.findUnique.mockResolvedValueOnce(null);

    const res = await supertest(app).delete("/webhooks/999");
    expect(res.status).toBe(404);
  });
});

describe("GET /webhooks/:id/deliveries", () => {
  const app = createApp();

  it("returns paginated delivery log", async () => {
    prisma.webhookSubscription.findUnique.mockResolvedValueOnce({ id: 1 });
    prisma.$transaction.mockResolvedValueOnce([2, [
      { id: 1, eventId: "evt-1", status: "success", attempts: 1, lastStatusCode: 200, lastError: null, nextRetryAt: null, deliveredAt: new Date(), createdAt: new Date() },
      { id: 2, eventId: "evt-2", status: "failed",  attempts: 5, lastStatusCode: 503, lastError: "timeout", nextRetryAt: null, deliveredAt: null, createdAt: new Date() },
    ]]);

    const res = await supertest(app).get("/webhooks/1/deliveries");
    expect(res.status).toBe(200);
    expect(res.body.total).toBe(2);
    expect(res.body.deliveries).toHaveLength(2);
  });

  it("returns 404 for unknown subscription", async () => {
    prisma.webhookSubscription.findUnique.mockResolvedValueOnce(null);

    const res = await supertest(app).get("/webhooks/999/deliveries");
    expect(res.status).toBe(404);
  });
});
