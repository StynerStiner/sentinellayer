import type { PrismaClient } from "../generated/prisma/client";
import type { AgentConfig, AgentRunResult, BaseAgent } from "../types";
import type { AlertWriter } from "../services/alert-writer";
import type { Logger } from "../utils/logger";

/**
 * Onboarding Coordinator Agent (Phase 4)
 *
 * Will monitor:
 * - Stale pending invites (not accepted within 48 hours)
 * - Incomplete beneficiary profiles (missing required fields)
 * - Pending vendor approvals past SLA
 * - Organizations that connected Stripe but haven't funded
 */
export class OnboardingAgent implements BaseAgent {
  readonly name = "OnboardingCoordinator";
  private logger: Logger;

  constructor(_db: PrismaClient, _config: AgentConfig, _alertWriter: AlertWriter, logger: Logger) {
    this.logger = logger;
  }

  async run(): Promise<AgentRunResult> {
    const startedAt = new Date();
    this.logger.info(this.name, "OnboardingCoordinator not yet implemented -- Phase 4");
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
