import cron from "node-cron";
import type { BaseAgent } from "../types";
import type { Logger } from "./logger";

interface ScheduledAgent {
  agent: BaseAgent;
  cronExpression: string;
  task: cron.ScheduledTask | null;
}

export class Scheduler {
  private agents: ScheduledAgent[] = [];
  private logger: Logger;

  constructor(logger: Logger) {
    this.logger = logger;
  }

  register(agent: BaseAgent, cronExpression: string): void {
    this.agents.push({ agent, cronExpression, task: null });
    this.logger.info("Scheduler", `Registered agent: ${agent.name} (${cronExpression})`);
  }

  start(): void {
    for (const entry of this.agents) {
      entry.task = cron.schedule(cronExpression(entry.cronExpression), async () => {
        await this.runAgent(entry.agent);
      });
      entry.task.start();
    }
    this.logger.info("Scheduler", `Started ${this.agents.length} scheduled agents`);
  }

  async runOnce(agentName: string): Promise<void> {
    const entry = this.agents.find((a) => a.agent.name === agentName);
    if (!entry) {
      this.logger.error("Scheduler", `Agent not found: ${agentName}`);
      return;
    }
    await this.runAgent(entry.agent);
  }

  private async runAgent(agent: BaseAgent): Promise<void> {
    this.logger.info(agent.name, "Starting run...");
    try {
      const result = await agent.run();
      this.logger.info(agent.name, "Run complete", {
        durationMs: result.durationMs,
        scanned: result.beneficiariesScanned,
        alertsCreated: result.alertsCreated,
        alertsSkipped: result.alertsSkipped,
        errors: result.errors.length,
      });
      if (result.errors.length > 0) {
        for (const err of result.errors) {
          this.logger.error(agent.name, `Error during run: ${err}`);
        }
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : "Unknown error";
      this.logger.error(agent.name, `Fatal error: ${message}`);
    }
  }

  stop(): void {
    for (const entry of this.agents) {
      entry.task?.stop();
    }
    this.logger.info("Scheduler", "All agents stopped");
  }
}

// Convert human-readable intervals to cron expressions
function cronExpression(input: string): string {
  // If already a cron expression, return as-is
  if (input.includes(" ") && input.split(" ").length >= 5) {
    return input;
  }
  return input;
}
