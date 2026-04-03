import type { ThresholdResult } from "../types";

/**
 * Compute an overall risk score for a beneficiary based on threshold results.
 * Score from 0 (safe) to 100 (critical across all programs).
 */
export function computeRiskScore(thresholds: ThresholdResult[]): number {
  if (thresholds.length === 0) return 0;

  // Weight critical alerts more heavily than warnings
  let totalWeight = 0;
  let weightedSum = 0;

  for (const t of thresholds) {
    const weight = t.severity === "critical" ? 2.0 : 1.0;
    totalWeight += weight;
    weightedSum += t.percentage * weight;
  }

  return totalWeight > 0 ? Math.min(100, Math.round(weightedSum / totalWeight)) : 0;
}

/**
 * Determine the highest severity across all threshold results.
 */
export function highestSeverity(thresholds: ThresholdResult[]): "ok" | "warning" | "critical" {
  if (thresholds.some((t) => t.severity === "critical")) return "critical";
  if (thresholds.some((t) => t.severity === "warning")) return "warning";
  return "ok";
}
