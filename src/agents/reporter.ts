import type { PrismaClient } from "../generated/prisma/client";
import type { AgentConfig, AgentRunResult, BaseAgent } from "../types";
import type { AlertWriter } from "../services/alert-writer";
import type { Logger } from "../utils/logger";
import { buildGrantReport } from "../services/report-builder";

/**
 * Grant Reporter Agent — Phase 3
 *
 * Runs every 7 days (configurable). For each organization, for each
 * active grant, assembles a structured disbursement report with:
 *   1. Disbursement summary
 *   2. Spending breakdown by category
 *   3. Beneficiary impact (privacy-safe names)
 *   4. Compliance summary
 *   5. Timeline and burn rate projections
 *
 * Writes to GrantReport table and notifies org admins.
 * READ-ONLY on financial data. Writes only GrantReport + Notification + AuditLog.
 */
export class ReporterAgent implements BaseAgent {
  readonly name = "GrantReporter";
  private db: PrismaClient;
  private config: AgentConfig;
  private alertWriter: AlertWriter;
  private logger: Logger;

  constructor(db: PrismaClient, config: AgentConfig, alertWriter: AlertWriter, logger: Logger) {
    this.db = db;
    this.config = config;
    this.alertWriter = alertWriter;
    this.logger = logger;
  }

  async run(): Promise<AgentRunResult> {
    const startedAt = new Date();
    const errors: string[] = [];
    let grantsProcessed = 0;
    let reportsGenerated = 0;
    let reportsSkipped = 0;

    try {
      const organizations = await this.db.organization.findMany({
        select: { id: true, name: true },
      });

      this.logger.info(this.name, `Scanning ${organizations.length} organizations`);

      for (const org of organizations) {
        try {
          const result = await this.processOrganization(org.id, org.name, startedAt);
          grantsProcessed += result.processed;
          reportsGenerated += result.generated;
          reportsSkipped += result.skipped;
        } catch (err) {
          const msg = `Error processing org ${org.id}: ${err instanceof Error ? err.message : "Unknown"}`;
          errors.push(msg);
          this.logger.error(this.name, msg);
        }
      }
    } catch (err) {
      const msg = `Fatal error: ${err instanceof Error ? err.message : "Unknown"}`;
      errors.push(msg);
      this.logger.error(this.name, msg);
    }

    const completedAt = new Date();
    return {
      agentName: this.name,
      startedAt,
      completedAt,
      durationMs: completedAt.getTime() - startedAt.getTime(),
      beneficiariesScanned: grantsProcessed,
      alertsCreated: reportsGenerated,
      alertsSkipped: reportsSkipped,
      errors,
    };
  }

  private async processOrganization(
    orgId: string,
    orgName: string,
    now: Date,
  ): Promise<{ processed: number; generated: number; skipped: number }> {
    const grants = await this.db.grant.findMany({
      where: {
        organizationId: orgId,
        status: "ACTIVE",
        archivedAt: null,
      },
      select: {
        id: true,
        name: true,
        grantIssuerName: true,
        totalAmount: true,
        spentAmount: true,
        remainingAmount: true,
        startDate: true,
        endDate: true,
        status: true,
      },
    });

    if (grants.length === 0) {
      this.logger.debug(this.name, `Org ${orgName}: 0 active grants`);
      return { processed: 0, generated: 0, skipped: 0 };
    }

    this.logger.info(this.name, `Org ${orgName}: ${grants.length} active grants`);

    let totalGenerated = 0;
    let totalSkipped = 0;

    for (const grant of grants) {
      try {
        const result = await this.processGrant(grant, orgId, now);
        if (result === "generated") totalGenerated++;
        else totalSkipped++;
      } catch (err) {
        this.logger.error(this.name, `Error processing grant ${grant.id}: ${err instanceof Error ? err.message : "Unknown"}`);
      }
    }

    return { processed: grants.length, generated: totalGenerated, skipped: totalSkipped };
  }

  private async processGrant(
    grant: {
      id: string;
      name: string;
      grantIssuerName: string | null;
      totalAmount: unknown;
      spentAmount: unknown;
      remainingAmount: unknown;
      startDate: Date;
      endDate: Date | null;
      status: string;
    },
    orgId: string,
    now: Date,
  ): Promise<"generated" | "skipped"> {
    // Dedup: check if report already exists for this grant in the current period
    const periodStart = new Date(now);
    periodStart.setDate(periodStart.getDate() - this.config.reporterIntervalDays);

    const existing = await this.db.grantReport.findFirst({
      where: {
        organizationId: orgId,
        grantId: grant.id,
        generatedAt: { gte: periodStart },
      },
      select: { id: true },
    });

    if (existing) {
      this.logger.debug(this.name, `Skipping grant ${grant.name}: report already exists for this period`);
      return "skipped";
    }

    // Fetch all related data
    const [categories, expenses, ledgerEntries, beneficiaryData, complianceAlerts] = await Promise.all([
      // Categories
      this.db.budgetCategory.findMany({
        where: { grantId: grant.id },
        select: { id: true, name: true, allocatedAmount: true, spentAmount: true },
      }),
      // Expenses
      this.db.expenseRequest.findMany({
        where: { grantId: grant.id, archivedAt: null },
        select: {
          id: true,
          amount: true,
          status: true,
          riskClassification: true,
          requestedById: true,
          categoryId: true,
          createdAt: true,
        },
      }),
      // Ledger entries
      this.db.ledgerEntry.findMany({
        where: { grantId: grant.id },
        select: { type: true, amount: true, createdAt: true },
      }),
      // Beneficiaries with card status
      this.getBeneficiariesForGrant(grant.id, orgId),
      // Compliance alerts for beneficiaries on this grant
      this.getComplianceAlerts(grant.id, orgId),
    ]);

    // Build the report
    const reportData = buildGrantReport(
      {
        id: grant.id,
        name: grant.name,
        grantIssuerName: grant.grantIssuerName,
        totalAmount: grant.totalAmount as number,
        spentAmount: grant.spentAmount as number,
        remainingAmount: grant.remainingAmount as number,
        startDate: grant.startDate,
        endDate: grant.endDate,
        status: grant.status,
      },
      categories.map((c) => ({
        id: c.id,
        name: c.name,
        allocatedAmount: c.allocatedAmount as number,
        spentAmount: c.spentAmount as number,
      })),
      expenses.map((e) => ({
        id: e.id,
        amount: e.amount as number,
        status: e.status,
        riskClassification: e.riskClassification,
        requestedById: e.requestedById,
        categoryId: e.categoryId,
        createdAt: e.createdAt,
      })),
      beneficiaryData,
      ledgerEntries.map((l) => ({
        type: l.type,
        amount: l.amount as number,
        createdAt: l.createdAt,
      })),
      complianceAlerts,
      periodStart,
      now,
    );

    // Write to GrantReport table
    await this.db.grantReport.create({
      data: {
        organizationId: orgId,
        grantId: grant.id,
        reportType: "weekly_disbursement",
        reportData: JSON.parse(JSON.stringify(reportData)),
        periodStart,
        periodEnd: now,
        generatedBy: "sentinellayer_reporter",
        status: "draft",
      },
    });

    // Notify org admins
    const admins = await this.db.user.findMany({
      where: {
        organizationId: orgId,
        role: { in: ["nonprofit_admin", "platform_admin"] },
        isActive: true,
      },
      select: { id: true },
    });

    const disbursedFormatted = reportData.disbursement.totalDisbursed.toLocaleString("en-US", {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    });

    for (const admin of admins) {
      await this.alertWriter.writeAlert({
        userId: admin.id,
        organizationId: orgId,
        type: "grant_report",
        title: `Weekly Report: ${grant.name} — ${reportData.disbursement.percentageUtilized}% utilized`,
        message: `Your weekly disbursement report for "${grant.name}" is ready. ${reportData.disbursement.uniqueBeneficiariesServed} beneficiaries served, $${disbursedFormatted} disbursed. Status: ${formatHealth(reportData.timeline.healthStatus)}. View in Reports.`,
        entityType: "grant",
        entityId: grant.id,
        href: "/reports",
      });
    }

    this.logger.info(this.name, `Report generated: ${grant.name} — ${reportData.disbursement.percentageUtilized}% utilized, ${formatHealth(reportData.timeline.healthStatus)}`);

    return "generated";
  }

  private async getBeneficiariesForGrant(
    grantId: string,
    orgId: string,
  ): Promise<{ id: string; firstName: string; lastName: string; hasActiveCard: boolean; hasFrozenCard: boolean }[]> {
    // Get beneficiaries assigned to this grant
    const grant = await this.db.grant.findUnique({
      where: { id: grantId },
      select: { beneficiaryId: true },
    });

    if (!grant?.beneficiaryId) return [];

    // Also get beneficiaries who submitted expenses against this grant
    const expenseBenIds = await this.db.expenseRequest.findMany({
      where: { grantId, archivedAt: null },
      select: { requestedById: true },
      distinct: ["requestedById"],
    });

    const allBenIds = new Set<string>();
    if (grant.beneficiaryId) allBenIds.add(grant.beneficiaryId);
    for (const e of expenseBenIds) allBenIds.add(e.requestedById);

    const beneficiaries = await this.db.user.findMany({
      where: { id: { in: Array.from(allBenIds) }, organizationId: orgId },
      select: { id: true, firstName: true, lastName: true },
    });

    // Check card status for each beneficiary
    const results = [];
    for (const ben of beneficiaries) {
      const activeCard = await this.db.virtualCard.findFirst({
        where: { organizationId: orgId, beneficiaryId: ben.id, status: "ACTIVE" },
        select: { id: true },
      });
      const frozenCard = activeCard ? null : await this.db.virtualCard.findFirst({
        where: { organizationId: orgId, beneficiaryId: ben.id, status: "FROZEN" },
        select: { id: true },
      });

      results.push({
        id: ben.id,
        firstName: ben.firstName,
        lastName: ben.lastName,
        hasActiveCard: !!activeCard,
        hasFrozenCard: !!frozenCard,
      });
    }

    return results;
  }

  private async getComplianceAlerts(
    grantId: string,
    orgId: string,
  ): Promise<{ type: string; title: string; entityId: string | null }[]> {
    // Get compliance alerts related to this grant's beneficiaries
    const grant = await this.db.grant.findUnique({
      where: { id: grantId },
      select: { beneficiaryId: true },
    });

    const expenseBenIds = await this.db.expenseRequest.findMany({
      where: { grantId, archivedAt: null },
      select: { requestedById: true },
      distinct: ["requestedById"],
    });

    const benIds = new Set<string>();
    if (grant?.beneficiaryId) benIds.add(grant.beneficiaryId);
    for (const e of expenseBenIds) benIds.add(e.requestedById);

    if (benIds.size === 0) return [];

    const alerts = await this.db.notification.findMany({
      where: {
        organizationId: orgId,
        type: { in: ["compliance_alert", "threshold_warning", "threshold_critical"] },
        entityId: { in: Array.from(benIds) },
      },
      select: { type: true, title: true, entityId: true },
    });

    return alerts;
  }
}

function formatHealth(status: string): string {
  switch (status) {
    case "on_track": return "On Track";
    case "ahead_of_schedule": return "Ahead of Schedule";
    case "at_risk": return "At Risk";
    default: return status;
  }
}
