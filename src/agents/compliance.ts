import type { PrismaClient, Decimal } from "../generated/prisma/client";
import type { AgentConfig, AgentRunResult, BaseAgent } from "../types";
import type { AlertWriter } from "../services/alert-writer";
import type { Logger } from "../utils/logger";

/**
 * Compliance Monitor Agent — Phase 2
 *
 * Runs every 6 hours (configurable). Scans all transactions since
 * the last run window. Checks for:
 *   a. MCC violations against grant restrictions
 *   b. Unusual spending velocity (3+ txns in 1 hour)
 *   c. Duplicate merchant charges (same merchant + amount in 24h)
 *   d. Single large transactions (50%+ of grant budget)
 *   e. Grant overspend (disbursed > totalAmount)
 *
 * READ-ONLY on financial data. Only writes to Notification + AuditLog.
 */
export class ComplianceAgent implements BaseAgent {
  readonly name = "ComplianceMonitor";
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
    let transactionsScanned = 0;
    let alertsCreated = 0;
    let alertsSkipped = 0;

    try {
      const windowHours = this.config.complianceIntervalHours;
      const since = new Date(startedAt.getTime() - windowHours * 3600000);

      this.logger.info(this.name, `Scanning transactions from last ${windowHours} hours (since ${since.toISOString()})`);

      const organizations = await this.db.organization.findMany({
        select: { id: true, name: true },
      });

      this.logger.info(this.name, `Scanning ${organizations.length} organizations`);

      for (const org of organizations) {
        try {
          const result = await this.scanOrganization(org.id, org.name, since);
          transactionsScanned += result.scanned;
          alertsCreated += result.created;
          alertsSkipped += result.skipped;
        } catch (err) {
          const msg = `Error scanning org ${org.id}: ${err instanceof Error ? err.message : "Unknown"}`;
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
      beneficiariesScanned: transactionsScanned,
      alertsCreated,
      alertsSkipped,
      errors,
    };
  }

  private async scanOrganization(
    orgId: string,
    orgName: string,
    since: Date,
  ): Promise<{ scanned: number; created: number; skipped: number }> {
    // Fetch all transactions in the window for this org
    const transactions = await this.db.transaction.findMany({
      where: {
        organizationId: orgId,
        createdAt: { gte: since },
      },
      select: {
        id: true,
        amount: true,
        merchantName: true,
        merchantCategory: true,
        status: true,
        grantId: true,
        expenseId: true,
        cardId: true,
        createdAt: true,
        card: {
          select: {
            beneficiaryId: true,
          },
        },
      },
      orderBy: { createdAt: "desc" },
    });

    if (transactions.length === 0) {
      this.logger.debug(this.name, `Org ${orgName}: 0 transactions in window`);
      return { scanned: 0, created: 0, skipped: 0 };
    }

    this.logger.info(this.name, `Org ${orgName}: ${transactions.length} transactions to check`);

    // Find the org admin for alert routing
    const orgAdmin = await this.findOrgAdmin(orgId);

    let totalCreated = 0;
    let totalSkipped = 0;

    // ── Check A: MCC Violations ─────────────────────────────
    for (const txn of transactions) {
      try {
        const result = await this.checkMCCViolation(txn, orgId, orgAdmin.id);
        totalCreated += result.created;
        totalSkipped += result.skipped;
      } catch (err) {
        this.logger.error(this.name, `MCC check error for txn ${txn.id}: ${err instanceof Error ? err.message : "Unknown"}`);
      }
    }

    // ── Check B: Spending Velocity ──────────────────────────
    try {
      const result = await this.checkSpendingVelocity(orgId, orgAdmin.id);
      totalCreated += result.created;
      totalSkipped += result.skipped;
    } catch (err) {
      this.logger.error(this.name, `Velocity check error for org ${orgId}: ${err instanceof Error ? err.message : "Unknown"}`);
    }

    // ── Check C: Duplicate Charges ──────────────────────────
    try {
      const result = await this.checkDuplicateCharges(orgId, orgAdmin.id);
      totalCreated += result.created;
      totalSkipped += result.skipped;
    } catch (err) {
      this.logger.error(this.name, `Duplicate check error for org ${orgId}: ${err instanceof Error ? err.message : "Unknown"}`);
    }

    // ── Check D: Large Single Transactions ──────────────────
    for (const txn of transactions) {
      try {
        const result = await this.checkLargeTransaction(txn, orgId, orgAdmin.id);
        totalCreated += result.created;
        totalSkipped += result.skipped;
      } catch (err) {
        this.logger.error(this.name, `Large txn check error for txn ${txn.id}: ${err instanceof Error ? err.message : "Unknown"}`);
      }
    }

    // ── Check E: Grant Overspend ────────────────────────────
    try {
      const result = await this.checkGrantOverspend(orgId, orgAdmin.id);
      totalCreated += result.created;
      totalSkipped += result.skipped;
    } catch (err) {
      this.logger.error(this.name, `Overspend check error for org ${orgId}: ${err instanceof Error ? err.message : "Unknown"}`);
    }

    return { scanned: transactions.length, created: totalCreated, skipped: totalSkipped };
  }

  // ═══════════════════════════════════════════════════════════
  // CHECK A: MCC Violations
  // ═══════════════════════════════════════════════════════════
  private async checkMCCViolation(
    txn: TransactionRow,
    orgId: string,
    adminId: string,
  ): Promise<{ created: number; skipped: number }> {
    if (!txn.grantId || !txn.merchantCategory) return { created: 0, skipped: 0 };

    const grant = await this.db.grant.findUnique({
      where: { id: txn.grantId },
      select: {
        name: true,
        approvedMCCs: true,
        blockedMCCs: true,
      },
    });
    if (!grant) return { created: 0, skipped: 0 };

    const mcc = txn.merchantCategory;
    const blockedMCCs = Array.isArray(grant.blockedMCCs) ? grant.blockedMCCs as string[] : [];
    const approvedMCCs = Array.isArray(grant.approvedMCCs) ? grant.approvedMCCs as string[] : [];

    let created = 0;
    let skipped = 0;

    // Check blocked MCCs
    if (blockedMCCs.length > 0 && blockedMCCs.includes(mcc)) {
      const wrote = await this.alertWriter.writeAlert({
        userId: adminId,
        organizationId: orgId,
        type: "compliance_alert",
        title: `MCC Violation: Blocked category "${mcc}" at ${txn.merchantName}`,
        message: `Transaction at ${txn.merchantName} used MCC ${mcc} which is explicitly blocked for grant "${grant.name}". Amount: $${toNum(txn.amount).toFixed(2)}. This may indicate a Stripe authorization gap or manual override.\n\nRecommended action: Review transaction immediately. Verify card controls are active. Contact beneficiary if needed.`,
        entityType: "transaction",
        entityId: txn.id,
        href: "/ledger",
      });
      wrote ? created++ : skipped++;
    }

    // Check approved MCCs (if list exists and MCC is not in it)
    if (approvedMCCs.length > 0 && !approvedMCCs.includes(mcc) && !blockedMCCs.includes(mcc)) {
      const wrote = await this.alertWriter.writeAlert({
        userId: adminId,
        organizationId: orgId,
        type: "compliance_alert",
        title: `MCC Warning: Unapproved category "${mcc}" at ${txn.merchantName}`,
        message: `Transaction at ${txn.merchantName} used MCC ${mcc} which is not in the approved list for grant "${grant.name}". Amount: $${toNum(txn.amount).toFixed(2)}. The grant only allows MCCs: ${approvedMCCs.join(", ")}.\n\nRecommended action: Review whether this merchant category is appropriate for the grant's purpose.`,
        entityType: "transaction",
        entityId: txn.id,
        href: "/ledger",
      });
      wrote ? created++ : skipped++;
    }

    return { created, skipped };
  }

  // ═══════════════════════════════════════════════════════════
  // CHECK B: Spending Velocity
  // ═══════════════════════════════════════════════════════════
  private async checkSpendingVelocity(
    orgId: string,
    adminId: string,
  ): Promise<{ created: number; skipped: number }> {
    let created = 0;
    let skipped = 0;

    // Get all beneficiaries with cards in this org
    const cards = await this.db.virtualCard.findMany({
      where: { organizationId: orgId, beneficiaryId: { not: null } },
      select: { id: true, beneficiaryId: true },
    });

    // Group cards by beneficiary
    const benCardIds = new Map<string, string[]>();
    for (const c of cards) {
      if (!c.beneficiaryId) continue;
      const existing = benCardIds.get(c.beneficiaryId) || [];
      existing.push(c.id);
      benCardIds.set(c.beneficiaryId, existing);
    }

    const oneHourAgo = new Date(Date.now() - 3600000);

    for (const [beneficiaryId, cardIds] of benCardIds) {
      const recentTxns = await this.db.transaction.findMany({
        where: {
          cardId: { in: cardIds },
          createdAt: { gte: oneHourAgo },
          status: "completed",
        },
        select: { id: true, merchantName: true, amount: true, createdAt: true },
      });

      if (recentTxns.length >= 5) {
        // Critical: 5+ transactions in 1 hour
        const wrote = await this.alertWriter.writeAlert({
          userId: adminId,
          organizationId: orgId,
          type: "compliance_alert",
          title: `CRITICAL: High-frequency spending (${recentTxns.length} txns in 1 hour)`,
          message: `Beneficiary has ${recentTxns.length} transactions in the last hour. This pattern may indicate card misuse, unauthorized sharing, or a compromised card. Merchants: ${recentTxns.map(t => t.merchantName).join(", ")}. Total: $${recentTxns.reduce((s, t) => s + toNum(t.amount), 0).toFixed(2)}.\n\nRecommended action: Consider freezing the card immediately and contacting the beneficiary.`,
          entityType: "user",
          entityId: beneficiaryId,
          href: "/beneficiaries",
        });
        wrote ? created++ : skipped++;
      } else if (recentTxns.length >= 3) {
        // Warning: 3-4 transactions in 1 hour
        const wrote = await this.alertWriter.writeAlert({
          userId: adminId,
          organizationId: orgId,
          type: "compliance_alert",
          title: `Unusual spending velocity (${recentTxns.length} txns in 1 hour)`,
          message: `Beneficiary has ${recentTxns.length} transactions in the last hour. This is above normal patterns. Merchants: ${recentTxns.map(t => t.merchantName).join(", ")}. Total: $${recentTxns.reduce((s, t) => s + toNum(t.amount), 0).toFixed(2)}.\n\nRecommended action: Monitor activity. If pattern continues, review card usage with the beneficiary.`,
          entityType: "user",
          entityId: beneficiaryId,
          href: "/beneficiaries",
        });
        wrote ? created++ : skipped++;
      }
    }

    return { created, skipped };
  }

  // ═══════════════════════════════════════════════════════════
  // CHECK C: Duplicate Charges
  // ═══════════════════════════════════════════════════════════
  private async checkDuplicateCharges(
    orgId: string,
    adminId: string,
  ): Promise<{ created: number; skipped: number }> {
    let created = 0;
    let skipped = 0;

    const twentyFourHoursAgo = new Date(Date.now() - 24 * 3600000);

    // Get all transactions from last 24 hours
    const recentTxns = await this.db.transaction.findMany({
      where: {
        organizationId: orgId,
        createdAt: { gte: twentyFourHoursAgo },
        status: "completed",
      },
      select: {
        id: true,
        amount: true,
        merchantName: true,
        createdAt: true,
        card: { select: { beneficiaryId: true } },
      },
      orderBy: { createdAt: "asc" },
    });

    // Group by beneficiary
    const byBeneficiary = new Map<string, typeof recentTxns>();
    for (const txn of recentTxns) {
      const benId = txn.card.beneficiaryId;
      if (!benId) continue;
      const list = byBeneficiary.get(benId) || [];
      list.push(txn);
      byBeneficiary.set(benId, list);
    }

    // For each beneficiary, find same merchant + same amount combos
    for (const [beneficiaryId, txns] of byBeneficiary) {
      const seen = new Map<string, string>(); // key -> first txn id

      for (const txn of txns) {
        const key = `${txn.merchantName.toLowerCase()}|${toNum(txn.amount).toFixed(2)}`;
        const firstId = seen.get(key);

        if (firstId && firstId !== txn.id) {
          // Duplicate found
          const wrote = await this.alertWriter.writeAlert({
            userId: adminId,
            organizationId: orgId,
            type: "compliance_alert",
            title: `Possible duplicate charge at ${txn.merchantName}`,
            message: `Two transactions with the same amount ($${toNum(txn.amount).toFixed(2)}) at ${txn.merchantName} within 24 hours. This may be an accidental double charge or duplicate authorization.\n\nRecommended action: Review both transactions. If duplicate, contact the merchant for a reversal.`,
            entityType: "transaction",
            entityId: txn.id,
            href: "/ledger",
          });
          wrote ? created++ : skipped++;
        } else {
          seen.set(key, txn.id);
        }
      }
    }

    return { created, skipped };
  }

  // ═══════════════════════════════════════════════════════════
  // CHECK D: Large Single Transaction
  // ═══════════════════════════════════════════════════════════
  private async checkLargeTransaction(
    txn: TransactionRow,
    orgId: string,
    adminId: string,
  ): Promise<{ created: number; skipped: number }> {
    if (!txn.grantId) return { created: 0, skipped: 0 };

    const grant = await this.db.grant.findUnique({
      where: { id: txn.grantId },
      select: { name: true, totalAmount: true },
    });
    if (!grant) return { created: 0, skipped: 0 };

    const txnAmount = toNum(txn.amount);
    const grantTotal = toNum(grant.totalAmount);
    if (grantTotal <= 0) return { created: 0, skipped: 0 };

    const percentage = txnAmount / grantTotal;
    let created = 0;
    let skipped = 0;

    if (percentage >= 0.8) {
      const wrote = await this.alertWriter.writeAlert({
        userId: adminId,
        organizationId: orgId,
        type: "compliance_alert",
        title: `CRITICAL: Large transaction — ${Math.round(percentage * 100)}% of grant budget`,
        message: `A single transaction of $${txnAmount.toFixed(2)} at ${txn.merchantName} represents ${Math.round(percentage * 100)}% of the total budget ($${grantTotal.toFixed(2)}) for grant "${grant.name}". This is an unusually large single expenditure.\n\nRecommended action: Verify this transaction was intentional and properly authorized. Review remaining grant balance.`,
        entityType: "transaction",
        entityId: txn.id,
        href: "/ledger",
      });
      wrote ? created++ : skipped++;
    } else if (percentage >= 0.5) {
      const wrote = await this.alertWriter.writeAlert({
        userId: adminId,
        organizationId: orgId,
        type: "compliance_alert",
        title: `Large transaction — ${Math.round(percentage * 100)}% of grant budget`,
        message: `A single transaction of $${txnAmount.toFixed(2)} at ${txn.merchantName} represents ${Math.round(percentage * 100)}% of the total budget ($${grantTotal.toFixed(2)}) for grant "${grant.name}".\n\nRecommended action: Confirm this expenditure aligns with the grant's approved purpose and budget plan.`,
        entityType: "transaction",
        entityId: txn.id,
        href: "/ledger",
      });
      wrote ? created++ : skipped++;
    }

    return { created, skipped };
  }

  // ═══════════════════════════════════════════════════════════
  // CHECK E: Grant Overspend
  // ═══════════════════════════════════════════════════════════
  private async checkGrantOverspend(
    orgId: string,
    adminId: string,
  ): Promise<{ created: number; skipped: number }> {
    let created = 0;
    let skipped = 0;

    const grants = await this.db.grant.findMany({
      where: { organizationId: orgId, status: "ACTIVE", archivedAt: null },
      select: {
        id: true,
        name: true,
        totalAmount: true,
        spentAmount: true,
      },
    });

    for (const grant of grants) {
      const total = toNum(grant.totalAmount);
      const spent = toNum(grant.spentAmount);

      if (spent > total && total > 0) {
        const overspend = spent - total;
        const wrote = await this.alertWriter.writeAlert({
          userId: adminId,
          organizationId: orgId,
          type: "compliance_alert",
          title: `CRITICAL: Grant "${grant.name}" is overspent by $${overspend.toFixed(2)}`,
          message: `Grant "${grant.name}" has $${spent.toFixed(2)} in disbursements against a total budget of $${total.toFixed(2)}. This is $${overspend.toFixed(2)} over budget. This should not happen and may indicate an accounting error, race condition in card authorization, or manual override.\n\nRecommended action: Freeze all cards for this grant immediately. Reconcile transactions against the ledger. Contact finance team.`,
          entityType: "grant",
          entityId: grant.id,
          href: "/grants",
        });
        wrote ? created++ : skipped++;
      }
    }

    return { created, skipped };
  }

  // ═══════════════════════════════════════════════════════════
  // Helpers
  // ═══════════════════════════════════════════════════════════
  private async findOrgAdmin(orgId: string): Promise<{ id: string }> {
    const admin = await this.db.user.findFirst({
      where: { organizationId: orgId, role: "nonprofit_admin", isActive: true },
      select: { id: true },
    });
    if (admin) return admin;

    const platformAdmin = await this.db.user.findFirst({
      where: { role: "platform_admin", isActive: true },
      select: { id: true },
    });
    return platformAdmin || { id: "system" };
  }
}

// ── Utility ──────────────────────────────────────────────────

/** Safely convert Prisma Decimal to number */
function toNum(val: Decimal | number | string): number {
  if (typeof val === "number") return val;
  return parseFloat(String(val));
}

/** Shape of transaction rows used across checks */
interface TransactionRow {
  id: string;
  amount: Decimal;
  merchantName: string;
  merchantCategory: string | null;
  status: string;
  grantId: string | null;
  expenseId: string | null;
  cardId: string;
  createdAt: Date;
  card: { beneficiaryId: string | null };
}
