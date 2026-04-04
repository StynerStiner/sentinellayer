import type { Decimal } from "../generated/prisma/client";

/**
 * Report Builder Service
 *
 * Takes raw grant + expense + ledger + beneficiary data and assembles
 * a structured report JSON with 5 sections:
 *   1. Disbursement Summary
 *   2. Spending Breakdown by Category
 *   3. Beneficiary Impact Summary
 *   4. Compliance Summary
 *   5. Timeline & Projections
 */

// ── Input types ──────────────────────────────────────────

interface GrantInput {
  id: string;
  name: string;
  grantIssuerName: string | null;
  totalAmount: Decimal | number;
  spentAmount: Decimal | number;
  remainingAmount: Decimal | number;
  startDate: Date;
  endDate: Date | null;
  status: string;
}

interface CategoryInput {
  id: string;
  name: string;
  allocatedAmount: Decimal | number;
  spentAmount: Decimal | number;
}

interface ExpenseInput {
  id: string;
  amount: Decimal | number;
  status: string;
  riskClassification: string | null;
  requestedById: string;
  categoryId: string;
  createdAt: Date;
}

interface BeneficiaryInput {
  id: string;
  firstName: string;
  lastName: string;
  hasActiveCard: boolean;
  hasFrozenCard: boolean;
}

interface LedgerInput {
  type: string;
  amount: Decimal | number;
  createdAt: Date;
}

interface ComplianceAlertInput {
  type: string;
  title: string;
  entityId: string | null;
}

// ── Output types ─────────────────────────────────────────

export interface DisbursementSummary {
  totalGrantAmount: number;
  totalDisbursed: number;
  totalRemaining: number;
  percentageUtilized: number;
  uniqueBeneficiariesServed: number;
  expenseRequests: {
    total: number;
    approved: number;
    rejected: number;
    pending: number;
    paid: number;
  };
  averageExpenseAmount: number;
  periodStart: string;
  periodEnd: string;
}

export interface CategoryBreakdown {
  categoryName: string;
  budgetedAmount: number;
  spentAmount: number;
  remainingAmount: number;
  percentageUsed: number;
  status: "on_track" | "warning" | "overspent";
}

export interface BeneficiaryImpact {
  name: string; // First name + last initial only
  expenseCount: number;
  totalDisbursed: number;
  cardStatus: "active" | "frozen" | "none";
}

export interface ComplianceSummarySection {
  riskBreakdown: {
    likelySafe: number;
    needsReview: number;
    likelyRisky: number;
    blocked: number;
    pending: number;
  };
  mccViolations: number;
  thresholdWarnings: number;
}

export interface TimelineSection {
  startDate: string;
  endDate: string | null;
  daysElapsed: number;
  daysRemaining: number | null;
  totalDurationDays: number | null;
  burnRateWeekly: number;
  projectedExhaustionDate: string | null;
  healthStatus: "on_track" | "ahead_of_schedule" | "at_risk";
  healthReason: string;
}

export interface GrantReportData {
  grantId: string;
  grantName: string;
  grantIssuer: string | null;
  generatedAt: string;
  disbursement: DisbursementSummary;
  categories: CategoryBreakdown[];
  beneficiaries: BeneficiaryImpact[];
  compliance: ComplianceSummarySection;
  timeline: TimelineSection;
}

// ── Builder ──────────────────────────────────────────────

export function buildGrantReport(
  grant: GrantInput,
  categories: CategoryInput[],
  expenses: ExpenseInput[],
  beneficiaries: BeneficiaryInput[],
  ledgerEntries: LedgerInput[],
  complianceAlerts: ComplianceAlertInput[],
  periodStart: Date,
  periodEnd: Date,
): GrantReportData {
  const now = periodEnd;

  // ── Section 1: Disbursement Summary ────────────────────
  const totalGrantAmount = toNum(grant.totalAmount);
  const totalDisbursed = ledgerEntries
    .filter((l) => l.type === "DEBIT")
    .reduce((sum, l) => sum + Math.abs(toNum(l.amount)), 0);

  // Fall back to grant.spentAmount if no ledger entries
  const effectiveDisbursed = totalDisbursed > 0 ? totalDisbursed : toNum(grant.spentAmount);
  const totalRemaining = totalGrantAmount - effectiveDisbursed;
  const percentageUtilized = totalGrantAmount > 0
    ? Math.round((effectiveDisbursed / totalGrantAmount) * 100)
    : 0;

  const uniqueBeneficiaryIds = new Set(expenses.map((e) => e.requestedById));

  const expenseCounts = {
    total: expenses.length,
    approved: expenses.filter((e) => e.status === "APPROVED").length,
    rejected: expenses.filter((e) => e.status === "REJECTED").length,
    pending: expenses.filter((e) => e.status === "PENDING").length,
    paid: expenses.filter((e) => e.status === "PAID").length,
  };

  const totalExpenseAmount = expenses.reduce((sum, e) => sum + toNum(e.amount), 0);
  const averageExpenseAmount = expenses.length > 0
    ? Math.round((totalExpenseAmount / expenses.length) * 100) / 100
    : 0;

  const disbursement: DisbursementSummary = {
    totalGrantAmount,
    totalDisbursed: effectiveDisbursed,
    totalRemaining: Math.max(0, totalRemaining),
    percentageUtilized,
    uniqueBeneficiariesServed: uniqueBeneficiaryIds.size,
    expenseRequests: expenseCounts,
    averageExpenseAmount,
    periodStart: grant.startDate.toISOString(),
    periodEnd: (grant.endDate || now).toISOString(),
  };

  // ── Section 2: Spending by Category ────────────────────
  const categoryBreakdowns: CategoryBreakdown[] = categories.map((cat) => {
    const budgeted = toNum(cat.allocatedAmount);
    const spent = toNum(cat.spentAmount);
    const remaining = budgeted - spent;
    const percentUsed = budgeted > 0 ? Math.round((spent / budgeted) * 100) : 0;

    let status: "on_track" | "warning" | "overspent" = "on_track";
    if (spent > budgeted) status = "overspent";
    else if (percentUsed >= 90) status = "warning";

    return {
      categoryName: cat.name,
      budgetedAmount: budgeted,
      spentAmount: spent,
      remainingAmount: Math.max(0, remaining),
      percentageUsed: percentUsed,
      status,
    };
  });

  // ── Section 3: Beneficiary Impact ──────────────────────
  const beneficiaryImpacts: BeneficiaryImpact[] = beneficiaries.map((ben) => {
    const benExpenses = expenses.filter((e) => e.requestedById === ben.id);
    const benTotal = benExpenses.reduce((sum, e) => sum + toNum(e.amount), 0);

    let cardStatus: "active" | "frozen" | "none" = "none";
    if (ben.hasActiveCard) cardStatus = "active";
    else if (ben.hasFrozenCard) cardStatus = "frozen";

    return {
      name: `${ben.firstName} ${ben.lastName.charAt(0)}.`,
      expenseCount: benExpenses.length,
      totalDisbursed: Math.round(benTotal * 100) / 100,
      cardStatus,
    };
  });

  // ── Section 4: Compliance Summary ──────────────────────
  const riskBreakdown = {
    likelySafe: expenses.filter((e) => e.riskClassification === "LIKELY_SAFE").length,
    needsReview: expenses.filter((e) => e.riskClassification === "NEEDS_REVIEW").length,
    likelyRisky: expenses.filter((e) => e.riskClassification === "LIKELY_RISKY").length,
    blocked: expenses.filter((e) => e.riskClassification === "BLOCKED").length,
    pending: expenses.filter((e) => e.riskClassification === "PENDING" || !e.riskClassification).length,
  };

  const mccViolations = complianceAlerts.filter((a) =>
    a.type === "compliance_alert" && a.title.toLowerCase().includes("mcc")
  ).length;

  const thresholdWarnings = complianceAlerts.filter((a) =>
    a.type === "threshold_warning" || a.type === "threshold_critical"
  ).length;

  const compliance: ComplianceSummarySection = {
    riskBreakdown,
    mccViolations,
    thresholdWarnings,
  };

  // ── Section 5: Timeline & Projections ──────────────────
  const startDate = grant.startDate;
  const endDate = grant.endDate;

  const daysElapsed = Math.max(1, Math.floor((now.getTime() - startDate.getTime()) / 86400000));
  const daysRemaining = endDate
    ? Math.max(0, Math.floor((endDate.getTime() - now.getTime()) / 86400000))
    : null;
  const totalDurationDays = endDate
    ? Math.floor((endDate.getTime() - startDate.getTime()) / 86400000)
    : null;

  const weeksElapsed = Math.max(1, daysElapsed / 7);
  const burnRateWeekly = Math.round((effectiveDisbursed / weeksElapsed) * 100) / 100;

  // Project exhaustion date
  let projectedExhaustionDate: string | null = null;
  if (burnRateWeekly > 0 && totalRemaining > 0) {
    const weeksRemaining = totalRemaining / burnRateWeekly;
    const exhaustionDate = new Date(now.getTime() + weeksRemaining * 7 * 86400000);
    projectedExhaustionDate = exhaustionDate.toISOString().split("T")[0];
  }

  // Determine health status
  let healthStatus: "on_track" | "ahead_of_schedule" | "at_risk" = "on_track";
  let healthReason = "Spending is within expected pace.";

  // Check for overspent categories
  const hasOverspent = categoryBreakdowns.some((c) => c.status === "overspent");

  if (hasOverspent) {
    healthStatus = "at_risk";
    healthReason = "One or more budget categories are overspent.";
  } else if (endDate && projectedExhaustionDate) {
    const exhaustion = new Date(projectedExhaustionDate);
    if (exhaustion < endDate) {
      healthStatus = "at_risk";
      healthReason = `At current burn rate ($${burnRateWeekly.toLocaleString()}/week), funds will be exhausted before the grant end date.`;
    }
  }

  // Check pace vs expected
  if (healthStatus === "on_track" && totalDurationDays && totalDurationDays > 0) {
    const expectedPace = daysElapsed / totalDurationDays;
    const actualPace = percentageUtilized / 100;
    const paceRatio = expectedPace > 0 ? actualPace / expectedPace : 1;

    if (paceRatio > 1.1) {
      healthStatus = "at_risk";
      healthReason = `Spending is ${Math.round((paceRatio - 1) * 100)}% ahead of the expected pace. Risk of early exhaustion.`;
    } else if (paceRatio < 0.9) {
      healthStatus = "ahead_of_schedule";
      healthReason = `Spending is ${Math.round((1 - paceRatio) * 100)}% below expected pace. Grant funds are being conserved.`;
    }
  }

  const timeline: TimelineSection = {
    startDate: startDate.toISOString().split("T")[0],
    endDate: endDate ? endDate.toISOString().split("T")[0] : null,
    daysElapsed,
    daysRemaining,
    totalDurationDays,
    burnRateWeekly,
    projectedExhaustionDate,
    healthStatus,
    healthReason,
  };

  return {
    grantId: grant.id,
    grantName: grant.name,
    grantIssuer: grant.grantIssuerName,
    generatedAt: now.toISOString(),
    disbursement,
    categories: categoryBreakdowns,
    beneficiaries: beneficiaryImpacts,
    compliance,
    timeline,
  };
}

// ── Utility ──────────────────────────────────────────────

function toNum(val: Decimal | number | string): number {
  if (typeof val === "number") return val;
  return parseFloat(String(val));
}
