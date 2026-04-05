import type { PrismaClient } from "../generated/prisma/client";
import type { Logger } from "../utils/logger";

interface AlertParams {
  userId: string;
  organizationId: string;
  type: string;
  title: string;
  message: string;
  entityType?: string;
  entityId?: string;
  href?: string;
}

export class AlertWriter {
  private db: PrismaClient;
  private logger: Logger;

  constructor(db: PrismaClient, logger: Logger) {
    this.db = db;
    this.logger = logger;
  }

  /**
   * Check for existing unread alert with same type + entity before creating.
   * Returns true if alert was created, false if skipped (duplicate).
   */
  async writeAlert(params: AlertParams): Promise<boolean> {
    // Deduplication: check for existing unread alert of same type for same entity
    if (params.entityId) {
      const existing = await this.db.notification.findFirst({
        where: {
          userId: params.userId,
          organizationId: params.organizationId,
          type: params.type,
          entityId: params.entityId,
          read: false,
        },
        select: { id: true },
      });

      if (existing) {
        this.logger.debug("AlertWriter", `Skipped duplicate alert: ${params.type} for entity ${params.entityId}`);
        return false;
      }
    }

    // Create notification
    await this.db.notification.create({
      data: {
        userId: params.userId,
        organizationId: params.organizationId,
        type: params.type,
        title: params.title,
        message: params.message,
        entityType: params.entityType || null,
        entityId: params.entityId || null,
        href: params.href || null,
      },
    });

    // Create audit log for the alert
    await this.db.auditLog.create({
      data: {
        userId: params.userId,
        organizationId: params.organizationId,
        action: "create",
        entityType: "notification",
        entityId: params.entityId || "sentinellayer",
        newValue: {
          source: "sentinellayer",
          alertType: params.type,
          title: params.title,
        },
      },
    });

    this.logger.info("AlertWriter", `Alert created: ${params.title}`, {
      type: params.type,
      userId: params.userId,
      orgId: params.organizationId,
    });

    return true;
  }

  /**
   * Write multiple alerts efficiently.
   * Returns { created: number, skipped: number }
   */
  async writeBulkAlerts(alerts: AlertParams[]): Promise<{ created: number; skipped: number }> {
    let created = 0;
    let skipped = 0;

    for (const alert of alerts) {
      const wasCreated = await this.writeAlert(alert);
      if (wasCreated) {
        created++;
      } else {
        skipped++;
      }
    }

    return { created, skipped };
  }
}
