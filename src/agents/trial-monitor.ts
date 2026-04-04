import type { PrismaClient } from "../generated/prisma/client";
import type { AgentConfig, AgentRunResult, BaseAgent } from "../types";
import type { AlertWriter } from "../services/alert-writer";
import type { Logger } from "../utils/logger";

/**
 * Trial Monitor Agent
 *
 * Runs every 12 hours (configurable via TRIAL_MONITOR_INTERVAL_HOURS).
 *
 * Two responsibilities:
 *
 * 1. EXPIRE TRIALS
 *    Finds organizations where subscriptionStatus = "trial" AND trialEndDate
 *    has already passed. Updates their subscriptionStatus to "expired" and
 *    notifies admins they need to upgrade.
 *
 * 2. WARN BEFORE EXPIRY
 *    Finds organizations whose trial ends in ~3 days. Sends a one-time warning
 *    notification to admins so they can upgrade before losing access.
 *    Dedupes via AlertWriter (checks for existing unread notification of the
 *    same type + entityId before creating a new one).
 */
export class TrialMonitorAgent implements BaseAgent {
  readonly name = "TrialMonitor";
  private db: PrismaClient;
  private alertWriter: AlertWriter;
  private logger: Logger;

  constructor(db: PrismaClient, _config: AgentConfig, alertWriter: AlertWriter, logger: Logger) {
    this.db = db;
    this.alertWriter = alertWriter;
    this.logger = logger;
  }

  async run(): Promise<AgentRunResult> {
    const startedAt = new Date();
    const errors: string[] = [];
    let orgsScanned = 0;
    let expiredCount = 0;
    let warnedCount = 0;

    try {
      const now = new Date();

      // ─────────────────────────────────────────────────────────────────────
      // 1. EXPIRE TRIALS — subscriptionStatus=trial AND trialEndDate <= now
      // ─────────────────────────────────────────────────────────────────────
      const expiredOrgs = await this.db.organization.findMany({
        where: {
          subscriptionStatus: "trial",
          trialEndDate: { lte: now, not: null },
        },
        select: { id: true, name: true, trialEndDate: true },
      });

      this.logger.info(this.name, `Found ${expiredOrgs.length} trial(s) to expire`);

      for (const org of expiredOrgs) {
        try {
          orgsScanned++;

          // Idempotent: only transitions on first expiry
          await this.db.organization.update({
            where: { id: org.id },
            data: { subscriptionStatus: "expired" },
          });

          // Notify every admin in the org
          const admins = await this.db.user.findMany({
            where: {
              organizationId: org.id,
              isActive: true,
              role: { in: ["nonprofit_admin", "platform_admin"] },
            },
            select: { id: true },
          });

          for (const admin of admins) {
            await this.alertWriter.writeAlert({
              userId: admin.id,
              organizationId: org.id,
              type: "trial_expired",
              title: "Your 14-day trial has ended",
              message: "Upgrade to continue using all features of BenefitsSafe.",
              entityType: "organization",
              entityId: org.id,
              href: "/settings/billing",
            });
          }

          expiredCount++;
          this.logger.info(this.name, `Expired trial for org: ${org.name}`);
        } catch (err) {
          const msg = err instanceof Error ? err.message : "Unknown error";
          errors.push(`Expire org ${org.id}: ${msg}`);
          this.logger.error(this.name, `Failed to expire org ${org.id}: ${msg}`);
        }
      }

      // ─────────────────────────────────────────────────────────────────────
      // 2. WARN — trial ends in 3 days
      // Window: trialEndDate BETWEEN (now + 2 days) AND (now + 3 days)
      // This 24-hour window + AlertWriter dedupe ensures one warning per org.
      // ─────────────────────────────────────────────────────────────────────
      const warnStart = new Date(now.getTime() + 2 * 24 * 60 * 60 * 1000);
      const warnEnd = new Date(now.getTime() + 3 * 24 * 60 * 60 * 1000);

      const warnOrgs = await this.db.organization.findMany({
        where: {
          subscriptionStatus: "trial",
          trialEndDate: { gte: warnStart, lte: warnEnd },
        },
        select: { id: true, name: true, trialEndDate: true },
      });

      this.logger.info(this.name, `Found ${warnOrgs.length} trial(s) ending in ~3 days`);

      for (const org of warnOrgs) {
        try {
          orgsScanned++;
          const admins = await this.db.user.findMany({
            where: {
              organizationId: org.id,
              isActive: true,
              role: { in: ["nonprofit_admin", "platform_admin"] },
            },
            select: { id: true },
          });

          let anyCreated = false;
          for (const admin of admins) {
            const created = await this.alertWriter.writeAlert({
              userId: admin.id,
              organizationId: org.id,
              type: "trial_ending_soon",
              title: "Your trial ends in 3 days",
              message: "Upgrade now to avoid losing access to BenefitsSafe.",
              entityType: "organization",
              entityId: org.id,
              href: "/settings/billing",
            });
            if (created) anyCreated = true;
          }
          if (anyCreated) {
            warnedCount++;
            this.logger.info(this.name, `Warned admins of trial ending for org: ${org.name}`);
          }
        } catch (err) {
          const msg = err instanceof Error ? err.message : "Unknown error";
          errors.push(`Warn org ${org.id}: ${msg}`);
          this.logger.error(this.name, `Failed to warn org ${org.id}: ${msg}`);
        }
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Unknown error";
      errors.push(`Run failed: ${msg}`);
      this.logger.error(this.name, `Run failed: ${msg}`);
    }

    const completedAt = new Date();
    const durationMs = completedAt.getTime() - startedAt.getTime();

    this.logger.info(
      this.name,
      `Run complete: scanned=${orgsScanned} expired=${expiredCount} warned=${warnedCount} errors=${errors.length} duration=${durationMs}ms`,
    );

    return {
      agentName: this.name,
      startedAt,
      completedAt,
      durationMs,
      beneficiariesScanned: orgsScanned, // reusing field for orgs scanned
      alertsCreated: expiredCount + warnedCount,
      alertsSkipped: 0,
      errors,
    };
  }
}
