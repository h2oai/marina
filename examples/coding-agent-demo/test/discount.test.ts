import { describe, expect, it } from "bun:test";
import { applyPercentDiscount } from "../src/discount";

describe("applyPercentDiscount", () => {
  it("applies a percentage expressed from 0 to 100", () => {
    expect(applyPercentDiscount(1_000, 20)).toBe(800);
  });

  it("rounds fractional cents", () => {
    expect(applyPercentDiscount(999, 15)).toBe(849);
  });
});
