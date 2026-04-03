import type { PrismaClient } from "../generated/prisma/client";
import type { AgentConfig, AgentRunResult, BaseAgent, BeneficiaryFinancials } from "../types";
import type { AlertWriter } from "../services/alert-writer";
import type { Logger } from "../utils/logger";
import { calculateThresholds } from "../services/threshold-calculator";
import { highestSeverity } from "../services/risk-scorer";

/**
 * Benefits Threshold Watchdog
 *
 * Runs every 24 hours (configurable). Scans all active beneficiaries,
 * calculates proximity to SSI/SSDI/Medi-Cal/CalFresh program limits,
 * and creates alerts for case managers and org admins when thresholds
 * are approached.
 *
 * The humans never see this agent. They just see smarter dashboards.
 */
export class WatchdogAgent implements BaseAgent {
  readonly name = "Watchdog";
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
    let beneficiariesScanned = 0;
    let alertsCreated = 0;
    let alertsSkipped = 0;

    try {
      // Get all organizations with active beneficiaries
      const organizations = await this.db.organization.findMany({
        where: {
          users: {
            some: {
              role: "beneficiary",
              isActive: true,
            },
          },
        },
        select: {
          id: true,
          name: true,
        },
      });

      this.logger.info(this.name, `Scanning ${organizations.length} organizations`);

      for (const org of organizations) {
        try {
          const result = await this.scanOrganization(org.id, org.name);
          beneficiariesScanned += result.scanned;
          alertsCreated += result.created;
          alertsSkipped += result.skipped;
        } catch (err) {
          const msg = `Error scanning org ${org.id}: ${err instanceof Error ? err.message : "Unknown"}`;
          errors.push(msg);
          this.logger.error(this.name, msg);
        }
      }
    } catch (err) {
      const msg = `Fatal query error: ${err instanceof Error ? err.message : "Unknown"}`;
      errors.push(msg);
      this.logger.error(this.name, msg);
    }

    const completedAt = new Date();
    return {
      agentName: this.name,
      startedAt,
      completedAt,
      durationMs: completedAt.getTime() - startedAt.getTime(),
      beneficiariesScanned,
      alertsCreated,
      alertsSkipped,
      errors,
    };
  }

  private async scanOrganization(orgId: string, orgName: string): Promise<{ scanned: number; created: number; skipped: number }> {
    // Get all active beneficiaries in this org
    const beneficiaries = await this.db.user.findMany({
      where: {
        organizationId: orgId,
        role: "beneficiary",
        isActive: true,
      },
      select: {
        id: true,
        firstName: true,
        lastName: true,
        email: true,
        benefitPrograms: true,
      },
    });

    if (beneficiaries.length === 0) return { scanned: 0, created: 0, skipped: 0 };

    this.logger.debug(this.name, `Org ${orgName}: ${beneficiaries.length} beneficiaries`);

    // Get transactions from last 30 days for this org's cards
    const thirtyDaysAgo = new Date();
    thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);

    let totalCreated = 0;
    let totalSkipped = 0;

    for (const ben of beneficiaries) {
      try {
        const financials = await this.buildFinancials(ben, orgId, orgName, thirtyDaysAgo);
        if (!financials) continue;

        const thresholds = calculateThresholds(
          financials,
          this.config.alertThresholdWarning,
          this.config.alertThresholdCritical
        );

        if (thresholds.length === 0) continue;

        // Find the case manager (admin who invited this beneficiary) or fall back to any org admin
        const caseManager = await this.findCaseManager(ben.id, orgId);

        for (const threshold of thresholds) {
          // Use the correct notification type based on severity
          const alertType = threshold.severity === "critical" ? "threshold_critical" : "threshold_warning";
          const titlePrefix = threshold.severity === "critical" ? "CRITICAL: " : "";

          // Create alert for case manager / org admin
          const alertCreated = await this.alertWriter.writeAlert({
            userId: caseManager.id,
            organizationId: orgId,
            type: alertType,
            title: `${titlePrefix}${ben.firstName} ${ben.lastName} ${threshold.severity === "critical" ? "at" : "approaching"} ${threshold.program} limit (${threshold.percentage}%)`,
            message: `${threshold.description}\n\nRecommended action: ${threshold.recommendation}`,
            entityType: "user",
            entityId: ben.id,
            href: `/beneficiaries/${ben.id}`,
          });

          if (alertCreated) {
            totalCreated++;
          } else {
            totalSkipped++;
          }

          // If critical (90%+), also notify org admins separately
          if (threshold.severity === "critical") {
            const admins = await this.db.user.findMany({
              where: {
                organizationId: orgId,
                role: { in: ["nonprofit_admin", "platform_admin"] },
                isActive: true,
                id: { not: caseManager.id }, // Don't double-notify the case manager
              },
              select: { id: true },
            });

            for (const admin of admins) {
              const adminAlertCreated = await this.alertWriter.writeAlert({
                userId: admin.id,
                organizationId: orgId,
                type: "threshold_critical",
                title: `CRITICAL: ${ben.firstName} ${ben.lastName} at ${threshold.percentage}% of ${threshold.program} limit`,
                message: `${threshold.description}\n\n${threshold.recommendation}`,
                entityType: "user",
                entityId: ben.id,
                href: `/beneficiaries/${ben.id}`,
              });

              if (adminAlertCreated) totalCreated++;
              else totalSkipped++;
            }
          }
        }
      } catch (err) {
        this.logger.error(this.name, `Error processing beneficiary ${ben.id}: ${err instanceof Error ? err.message : "Unknown"}`);
      }
    }

    return { scanned: beneficiaries.length, created: totalCreated, skipped: totalSkipped };
  }

  private async buildFinancials(
    ben: { id: string; firstName: string; lastName: string; email: string; benefitPrograms: unknown },
    orgId: string,
    orgName: string,
    since: Date
  ): Promise<BeneficiaryFinancials | null> {
    const programs = (ben.benefitPrograms || {}) as Record<string, boolean>;

    // Skip if no benefit programs enrolled
    const hasPrograms = Object.values(programs).some((v) => v === true);
    if (!hasPrograms) return null;

    // Get card transactions from last 30 days
    const transactions = await this.db.transaction.findMany({
      where: {
        card: {
          organizationId: orgId,
          beneficiaryId: ben.id,
        },
        createdAt: { gte: since },
      },
      select: {
        amount: true,
        status: true,
        createdAt: true,
      },
    });

    // Calculate totals
    const totalSpending = transactions.reduce(
      (sum, t) => sum + Math.abs(parseFloat(String(t.amount))),
      0
    );

    // Approximate monthly income from transaction patterns
    // In a real system, this would integrate with bank data or manual input
    // For now, use card spending as a proxy for asset accumulation
    const monthlyIncomeApprox = totalSpending * 0.3; // Conservative estimate

    return {
      beneficiaryId: ben.id,
      firstName: ben.firstName,
      lastName: ben.lastName,
      email: ben.email,
      organizationId: orgId,
      orgName,
      benefitPrograms: {
        ssi: programs.ssi || false,
        ssdi: programs.ssdi || false,
        mediCal: programs.mediCal || false,
        medicaid: programs.medicaid || false,
        calFresh: programs.calFresh || false,
        ihss: programs.ihss || false,
        able: programs.able || false,
      },
      totalAssetsFromCards: totalSpending, // Card spending as asset proxy
      monthlyIncomeApprox,
      last30DaysSpending: totalSpending,
      householdSize: 1, // Default; future: pull from beneficiary profile
      isBlind: false, // Default; future: pull from beneficiary profile
    };
  }

  private async findCaseManager(
    beneficiaryId: string,
    orgId: string
  ): Promise<{ id: string }> {
    // Try to find who invited this beneficiary
    const membership = await this.db.organizationMembership.findFirst({
      where: {
        userId: beneficiaryId,
        organizationId: orgId,
      },
      select: { invitedBy: true },
    });

    if (membership?.invitedBy) {
      return { id: membership.invitedBy };
    }

    // Fall back to first org admin
    const admin = await this.db.user.findFirst({
      where: {
        organizationId: orgId,
        role: "nonprofit_admin",
        isActive: true,
      },
      select: { id: true },
    });

    if (admin) return admin;

    // Last resort: platform admin
    const platformAdmin = await this.db.user.findFirst({
      where: {
        role: "platform_admin",
        isActive: true,
      },
      select: { id: true },
    });

    return platformAdmin || { id: "system" };
  }
}
