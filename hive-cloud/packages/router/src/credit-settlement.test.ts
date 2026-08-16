import { describe, it, expect, beforeEach } from "vitest";
import { CreditSettlement } from "./credit-settlement.js";

describe("CreditSettlement", () => {
  let settlement: CreditSettlement;

  beforeEach(() => {
    settlement = new CreditSettlement(100);
  });

  it("reserves credits when balance is sufficient", () => {
    const result = settlement.tryReserve(30, "req-1");
    expect(result.success).toBe(true);
  });

  it("rejects reservation when balance is insufficient", () => {
    const result = settlement.tryReserve(200, "req-1");
    expect(result.success).toBe(false);
    expect(result.reason).toBe("insufficient_credits");
  });

  it("settles reserved credits and debits actual amount", () => {
    settlement.tryReserve(30, "req-1");
    const result = settlement.settle("req-1", 20);
    expect(result.success).toBe(true);
    expect(result.debited).toBe(20);
    expect(result.released).toBe(10);
  });

  it("releases reservation for failed request", () => {
    settlement.tryReserve(30, "req-1");
    expect(settlement.release("req-1")).toBe(true);
    expect(settlement.getAvailableBalance()).toBe(100);
  });

  it("prevents double settlement", () => {
    settlement.tryReserve(30, "req-1");
    settlement.settle("req-1", 20);
    const second = settlement.settle("req-1", 10);
    expect(second.success).toBe(false);
  });

  it("reduces available balance after reservation", () => {
    settlement.tryReserve(30, "req-1");
    expect(settlement.getAvailableBalance()).toBe(70);
  });

  it("setBalance updates the balance", () => {
    settlement.setBalance(200);
    expect(settlement.getAvailableBalance()).toBe(200);
  });

  it("caps debit at reserved amount", () => {
    settlement.tryReserve(30, "req-1");
    const result = settlement.settle("req-1", 50);
    expect(result.debited).toBe(30);
    expect(result.released).toBe(0);
  });
});
