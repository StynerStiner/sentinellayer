import type { PrismaClient } from "../generated/prisma/client";
import type { AgentConfig, AgentRunResult, BaseAgent } from "../types";
import type { AlertWriter } from "../services/alert-writer";
import type { Logger } from "../utils/logger";

/**
 * Grant Reporter Agent (Phase 3)
 *
 * Will generate:
 * - Weekly grant utilization summaries
 * - Monthly compliance reports for funders
 * - Quarterly spend-down projections
 * - Annual audit preparation reports
 */
export class ReporterAgent implements BaseAgent {
  readonly name = "GrantReporter";
  private logger: Logger;

  constructor(_db: PrismaClient, _config: AgentConfig, _alertWriter: AlertWriter, logger: Logger) {
    this.logger = logger;
  }

  async run(): Promise<AgentRunResult> {
    const startedAt = new Date();
    this.logger.info(this.name, "GrantReporter not yet implemented -- Phase 3");
    const completedAt = new Date();

    return {
      agentName: this.name,
      startedAt,
      completedAt,
      durationMs: completedAt.getTime() - startedAt.getTime(),
      beneficiariesScanned: 0,
      alertsCreated: 0,
      alertsSkipped: 0,
      errors: [],
    };
  }
}
