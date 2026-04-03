import { config, DATABASE_URL } from "./config";
import { getDb, disconnectDb } from "./db";
import { Logger } from "./utils/logger";
import { Scheduler } from "./utils/scheduler";
import { AlertWriter } from "./services/alert-writer";
import { WatchdogAgent } from "./agents/watchdog";
import { ComplianceAgent } from "./agents/compliance";
import { ReporterAgent } from "./agents/reporter";
import { OnboardingAgent } from "./agents/onboarding";

async function main(): Promise<void> {
  const logger = new Logger(config.logLevel);
  const db = getDb();
  const alertWriter = new AlertWriter(db, logger);

  // Parse CLI args for single-agent runs
  const args = process.argv.slice(2);
  const agentFlag = args.indexOf("--agent");
  const singleAgent = agentFlag >= 0 ? args[agentFlag + 1] : null;
  const runOnce = args.includes("--once");

  // Initialize agents
  const watchdog = new WatchdogAgent(db, config, alertWriter, logger);
  const compliance = new ComplianceAgent(db, config, alertWriter, logger);
  const reporter = new ReporterAgent(db, config, alertWriter, logger);
  const onboarding = new OnboardingAgent(db, config, alertWriter, logger);

  // Build cron expressions from config
  const watchdogCron = `0 */${config.watchdogIntervalHours} * * *`;
  const complianceCron = `0 */${config.complianceIntervalHours} * * *`;
  const reporterCron = `0 0 */${config.reporterIntervalDays} * *`;
  const onboardingCron = `0 */${config.onboardingIntervalHours} * * *`;

  const scheduler = new Scheduler(logger);
  scheduler.register(watchdog, watchdogCron);
  scheduler.register(compliance, complianceCron);
  scheduler.register(reporter, reporterCron);
  scheduler.register(onboarding, onboardingCron);

  // Single agent mode: run once and exit
  if (singleAgent && runOnce) {
    const nameMap: Record<string, string> = {
      watchdog: "Watchdog",
      compliance: "ComplianceMonitor",
      reporter: "GrantReporter",
      onboarding: "OnboardingCoordinator",
    };

    const resolvedName = nameMap[singleAgent.toLowerCase()] || singleAgent;
    logger.info("Paperclip", `Running single agent: ${resolvedName}`);
    await scheduler.runOnce(resolvedName);
    await disconnectDb();
    process.exit(0);
  }

  // Scheduled mode: run all agents on their intervals
  logger.banner([
    { name: watchdog.name, interval: `${config.watchdogIntervalHours}h` },
    { name: compliance.name, interval: `${config.complianceIntervalHours}h` },
    { name: reporter.name, interval: `${config.reporterIntervalDays}d` },
    { name: onboarding.name, interval: `${config.onboardingIntervalHours}h` },
  ]);

  // Run watchdog immediately on startup, then schedule
  logger.info("Paperclip", "Running initial Watchdog scan...");
  await scheduler.runOnce("Watchdog");

  scheduler.start();

  // Graceful shutdown
  const shutdown = async (signal: string): Promise<void> => {
    logger.info("Paperclip", `Received ${signal}. Shutting down gracefully...`);
    scheduler.stop();
    await disconnectDb();
    logger.info("Paperclip", "Shutdown complete.");
    process.exit(0);
  };

  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
}

main().catch((err) => {
  console.error("[FATAL] Paperclip failed to start:", err);
  process.exit(1);
});
