import dotenv from "dotenv";
import type { AgentConfig } from "./types";

dotenv.config();

export const config: AgentConfig = {
  watchdogIntervalHours: parseInt(process.env.WATCHDOG_INTERVAL_HOURS || "24", 10),
  complianceIntervalHours: parseInt(process.env.COMPLIANCE_INTERVAL_HOURS || "6", 10),
  reporterIntervalDays: parseInt(process.env.REPORTER_INTERVAL_DAYS || "7", 10),
  onboardingIntervalHours: parseInt(process.env.ONBOARDING_INTERVAL_HOURS || "12", 10),
  alertThresholdWarning: parseFloat(process.env.ALERT_THRESHOLD_WARNING || "0.80"),
  alertThresholdCritical: parseFloat(process.env.ALERT_THRESHOLD_CRITICAL || "0.90"),
  logLevel: process.env.LOG_LEVEL || "info",
};

export const DATABASE_URL = process.env.DATABASE_URL;

if (!DATABASE_URL) {
  throw new Error("DATABASE_URL is required. Paperclip connects to the same Aurora instance as BenefitsSafe.");
}
