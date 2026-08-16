interface Reservation {
  requestId: string;
  reserved: number;
  status: "reserved" | "settled" | "released";
  createdAt: number;
}

export interface ReserveResult {
  success: boolean;
  reason?: "insufficient_credits";
}

export interface SettleResult {
  success: boolean;
  debited?: number;
  released?: number;
  reason?: string;
}

export class CreditSettlement {
  readonly #reservations = new Map<string, Reservation>();
  #balance: number;

  constructor(initialBalance: number = 0) {
    this.#balance = initialBalance;
  }

  public setBalance(balance: number): void {
    this.#balance = balance;
  }

  public getAvailableBalance(): number {
    const reservedTotal = [...this.#reservations.values()]
      .filter((r) => r.status === "reserved")
      .reduce((sum, r) => sum + r.reserved, 0);
    return this.#balance - reservedTotal;
  }

  public tryReserve(amount: number, requestId: string): ReserveResult {
    const available = this.getAvailableBalance();

    if (amount > available) {
      return { success: false, reason: "insufficient_credits" };
    }

    this.#reservations.set(requestId, {
      requestId,
      reserved: amount,
      status: "reserved",
      createdAt: Date.now(),
    });

    return { success: true };
  }

  public settle(requestId: string, actualDebit: number): SettleResult {
    const reservation = this.#reservations.get(requestId);
    if (!reservation || reservation.status !== "reserved") {
      return { success: false, reason: "no_active_reservation" };
    }

    if (actualDebit > reservation.reserved) {
      actualDebit = reservation.reserved;
    }

    reservation.status = "settled";
    this.#balance -= actualDebit;

    return {
      success: true,
      debited: actualDebit,
      released: reservation.reserved - actualDebit,
    };
  }

  public release(requestId: string): boolean {
    const reservation = this.#reservations.get(requestId);
    if (!reservation || reservation.status !== "reserved") {
      return false;
    }
    reservation.status = "released";
    return true;
  }

  public expireStaleReservations(maxAgeMs: number = 5 * 60 * 1000): number {
    const now = Date.now();
    let released = 0;
    for (const [, reservation] of this.#reservations) {
      if (reservation.status === "reserved" && now - reservation.createdAt > maxAgeMs) {
        reservation.status = "released";
        released += reservation.reserved;
      }
    }
    return released;
  }
}
