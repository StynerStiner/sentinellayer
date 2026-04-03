import type { BeneficiaryFinancials, ThresholdResult } from "../types";

// ============================================
// 2025 CALIFORNIA BENEFIT PROGRAM LIMITS
// All values in USD unless noted
// ============================================

// SSI Asset Limits (Social Security Administration)
// Source: https://www.ssa.gov/ssi/text-resources-ussi.htm
// Effective: 2025
const SSI_ASSET_LIMIT_INDIVIDUAL = 2000;
const SSI_ASSET_LIMIT_COUPLE = 3000;

// SSDI Substantial Gainful Activity (SGA) Monthly Limits
// Source: https://www.ssa.gov/oact/cola/sga.html
// Effective: 2025
const SSDI_SGA_MONTHLY_NON_BLIND = 1550;
const SSDI_SGA_MONTHLY_BLIND = 2590;

// Federal Poverty Level (FPL) 2025 -- Continental US
// Source: https://aspe.hhs.gov/poverty-guidelines
// Used by Medi-Cal and CalFresh
const FPL_2025: Record<number, number> = {
  1: 15650,
  2: 21150,
  3: 26650,
  4: 32150,
  5: 37650,
  6: 43150,
  7: 48650,
  8: 54150,
};

// Additional per-person for households >8
const FPL_2025_PER_ADDITIONAL = 5500;

function getFPL(householdSize: number): number {
  if (householdSize <= 0) return FPL_2025[1];
  if (householdSize <= 8) return FPL_2025[householdSize];
  return FPL_2025[8] + (householdSize - 8) * FPL_2025_PER_ADDITIONAL;
}

// Medi-Cal Income Limits (California)
// Source: https://www.dhcs.ca.gov/services/medi-cal/eligibility
// Modified Adjusted Gross Income (MAGI): 138% FPL
const MEDI_CAL_INCOME_PERCENT_FPL = 1.38;

// CalFresh (SNAP in California) Limits
// Source: https://www.cdss.ca.gov/calfresh
// Gross income: 200% FPL
// Net income: 100% FPL
const CALFRESH_GROSS_INCOME_PERCENT_FPL = 2.00;
const CALFRESH_NET_INCOME_PERCENT_FPL = 1.00;

// CalFresh asset limits (for households with elderly/disabled members)
// Most CalFresh households have NO asset test in CA (Broad-Based Categorical Eligibility)
// But households without BBCE: $2,750 general, $4,250 with elderly/disabled
const CALFRESH_ASSET_LIMIT_GENERAL = 2750;
const CALFRESH_ASSET_LIMIT_ELDERLY_DISABLED = 4250;

// IHSS (In-Home Supportive Services) -- income follows Medi-Cal rules
// Source: https://www.cdss.ca.gov/in-home-supportive-services

// ABLE Account (Achieving a Better Life Experience)
// Source: https://www.ablenrc.org
// Annual contribution limit (2025): $18,000
// Total account limit (most states): $100,000 before affecting SSI
const ABLE_ANNUAL_CONTRIBUTION_LIMIT = 18000;
const ABLE_BALANCE_SSI_THRESHOLD = 100000;

/**
 * Calculate threshold proximity for all applicable benefit programs.
 * Returns an array of results -- one per program the beneficiary is enrolled in.
 */
export function calculateThresholds(
  financials: BeneficiaryFinancials,
  warningThreshold: number,
  criticalThreshold: number
): ThresholdResult[] {
  const results: ThresholdResult[] = [];
  const programs = financials.benefitPrograms;
  const householdSize = Math.max(1, financials.householdSize);

  // ---- SSI ----
  if (programs.ssi) {
    const limit = SSI_ASSET_LIMIT_INDIVIDUAL; // Default to individual
    const current = financials.totalAssetsFromCards;
    const percentage = limit > 0 ? current / limit : 0;
    const severity = getSeverity(percentage, warningThreshold, criticalThreshold);

    if (severity !== "ok") {
      results.push({
        program: "SSI",
        limit,
        current,
        percentage: Math.round(percentage * 100),
        severity,
        description: `SSI asset limit: $${current.toLocaleString()} of $${limit.toLocaleString()} (${Math.round(percentage * 100)}%). SSI requires countable resources under $${limit.toLocaleString()} for individuals.`,
        recommendation: severity === "critical"
          ? "URGENT: Review asset levels immediately. Consider spending down countable resources on allowable expenses (rent, utilities, medical). Consult benefits counselor."
          : "Monitor asset levels. Consider scheduling allowable expenses before end of month to stay under limit.",
      });
    }

    // Also check monthly income against SGA for SSI
    const sgaLimit = financials.isBlind ? SSDI_SGA_MONTHLY_BLIND : SSDI_SGA_MONTHLY_NON_BLIND;
    const incomePercentage = sgaLimit > 0 ? financials.monthlyIncomeApprox / sgaLimit : 0;
    const incomeSeverity = getSeverity(incomePercentage, warningThreshold, criticalThreshold);

    if (incomeSeverity !== "ok") {
      results.push({
        program: "SSI (Income)",
        limit: sgaLimit,
        current: financials.monthlyIncomeApprox,
        percentage: Math.round(incomePercentage * 100),
        severity: incomeSeverity,
        description: `SSI/SGA monthly income: $${financials.monthlyIncomeApprox.toLocaleString()} of $${sgaLimit.toLocaleString()} limit (${Math.round(incomePercentage * 100)}%).`,
        recommendation: incomeSeverity === "critical"
          ? "URGENT: Monthly earnings approaching SGA limit. Exceeding $" + sgaLimit + "/month may trigger benefit reduction. Consult benefits counselor immediately."
          : "Monthly income approaching SGA threshold. Review work activity and earned income.",
      });
    }
  }

  // ---- SSDI ----
  if (programs.ssdi) {
    const sgaLimit = financials.isBlind ? SSDI_SGA_MONTHLY_BLIND : SSDI_SGA_MONTHLY_NON_BLIND;
    const current = financials.monthlyIncomeApprox;
    const percentage = sgaLimit > 0 ? current / sgaLimit : 0;
    const severity = getSeverity(percentage, warningThreshold, criticalThreshold);

    if (severity !== "ok") {
      results.push({
        program: "SSDI",
        limit: sgaLimit,
        current,
        percentage: Math.round(percentage * 100),
        severity,
        description: `SSDI SGA limit: $${current.toLocaleString()}/month of $${sgaLimit.toLocaleString()}/month (${Math.round(percentage * 100)}%). Earning above SGA for extended periods may end SSDI benefits.`,
        recommendation: severity === "critical"
          ? "URGENT: Monthly earnings near SGA limit ($" + sgaLimit + "). If exceeded consistently, SSDI benefits may be suspended after Trial Work Period. Consult disability attorney."
          : "Monitor monthly earnings. Consider using PASS (Plan to Achieve Self-Support) or IRWE (Impairment-Related Work Expenses) deductions.",
      });
    }
  }

  // ---- Medi-Cal ----
  if (programs.mediCal || programs.medicaid) {
    const fpl = getFPL(householdSize);
    const annualLimit = Math.round(fpl * MEDI_CAL_INCOME_PERCENT_FPL);
    const monthlyLimit = Math.round(annualLimit / 12);
    const current = financials.monthlyIncomeApprox;
    const percentage = monthlyLimit > 0 ? current / monthlyLimit : 0;
    const severity = getSeverity(percentage, warningThreshold, criticalThreshold);

    if (severity !== "ok") {
      results.push({
        program: "Medi-Cal",
        limit: monthlyLimit,
        current,
        percentage: Math.round(percentage * 100),
        severity,
        description: `Medi-Cal income limit (138% FPL): $${current.toLocaleString()}/month of $${monthlyLimit.toLocaleString()}/month for household of ${householdSize} (${Math.round(percentage * 100)}%).`,
        recommendation: severity === "critical"
          ? "URGENT: Monthly income approaching Medi-Cal eligibility limit. Losing Medi-Cal could mean loss of healthcare coverage. Review income sources and consider MAGI deductions."
          : "Monitor income levels. Medi-Cal uses Modified Adjusted Gross Income (MAGI) -- some deductions may apply.",
      });
    }
  }

  // ---- CalFresh ----
  if (programs.calFresh) {
    const fpl = getFPL(householdSize);

    // Gross income check (200% FPL)
    const grossLimit = Math.round((fpl * CALFRESH_GROSS_INCOME_PERCENT_FPL) / 12);
    const grossPercentage = grossLimit > 0 ? financials.monthlyIncomeApprox / grossLimit : 0;
    const grossSeverity = getSeverity(grossPercentage, warningThreshold, criticalThreshold);

    if (grossSeverity !== "ok") {
      results.push({
        program: "CalFresh (Gross Income)",
        limit: grossLimit,
        current: financials.monthlyIncomeApprox,
        percentage: Math.round(grossPercentage * 100),
        severity: grossSeverity,
        description: `CalFresh gross income limit (200% FPL): $${financials.monthlyIncomeApprox.toLocaleString()}/month of $${grossLimit.toLocaleString()}/month (${Math.round(grossPercentage * 100)}%).`,
        recommendation: grossSeverity === "critical"
          ? "URGENT: Gross income approaching CalFresh limit. Losing CalFresh means loss of food assistance. Review all income sources."
          : "Monitor gross income. CalFresh allows certain deductions (shelter, dependent care) that may reduce countable income.",
      });
    }

    // Net income check (100% FPL)
    const netLimit = Math.round((fpl * CALFRESH_NET_INCOME_PERCENT_FPL) / 12);
    const netPercentage = netLimit > 0 ? financials.monthlyIncomeApprox / netLimit : 0;
    const netSeverity = getSeverity(netPercentage, warningThreshold, criticalThreshold);

    if (netSeverity !== "ok" && netSeverity !== grossSeverity) {
      results.push({
        program: "CalFresh (Net Income)",
        limit: netLimit,
        current: financials.monthlyIncomeApprox,
        percentage: Math.round(netPercentage * 100),
        severity: netSeverity,
        description: `CalFresh net income limit (100% FPL): $${financials.monthlyIncomeApprox.toLocaleString()}/month of $${netLimit.toLocaleString()}/month (${Math.round(netPercentage * 100)}%).`,
        recommendation: "Review eligible deductions: shelter costs, dependent care, medical expenses for elderly/disabled. These reduce net income for CalFresh purposes.",
      });
    }
  }

  return results;
}

function getSeverity(
  percentage: number,
  warningThreshold: number,
  criticalThreshold: number
): "ok" | "warning" | "critical" {
  if (percentage >= criticalThreshold) return "critical";
  if (percentage >= warningThreshold) return "warning";
  return "ok";
}

/**
 * Export limits for reference in other modules
 */
export const BENEFIT_LIMITS = {
  SSI_ASSET_INDIVIDUAL: SSI_ASSET_LIMIT_INDIVIDUAL,
  SSI_ASSET_COUPLE: SSI_ASSET_LIMIT_COUPLE,
  SSDI_SGA_NON_BLIND: SSDI_SGA_MONTHLY_NON_BLIND,
  SSDI_SGA_BLIND: SSDI_SGA_MONTHLY_BLIND,
  MEDI_CAL_PERCENT_FPL: MEDI_CAL_INCOME_PERCENT_FPL,
  CALFRESH_GROSS_PERCENT_FPL: CALFRESH_GROSS_INCOME_PERCENT_FPL,
  CALFRESH_NET_PERCENT_FPL: CALFRESH_NET_INCOME_PERCENT_FPL,
  CALFRESH_ASSET_GENERAL: CALFRESH_ASSET_LIMIT_GENERAL,
  CALFRESH_ASSET_ELDERLY_DISABLED: CALFRESH_ASSET_LIMIT_ELDERLY_DISABLED,
  ABLE_ANNUAL_CONTRIBUTION: ABLE_ANNUAL_CONTRIBUTION_LIMIT,
  ABLE_SSI_THRESHOLD: ABLE_BALANCE_SSI_THRESHOLD,
  FPL_2025: { ...FPL_2025 },
  getFPL,
} as const;
