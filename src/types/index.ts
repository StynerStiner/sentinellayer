// Paperclip Agent Types

export interface AgentConfig {
  watchdogIntervalHours: number;
  complianceIntervalHours: number;
  reporterIntervalDays: number;
  onboardingIntervalHours: number;
  trialMonitorIntervalHours: number;
  alertThresholdWarning: number;
  alertThresholdCritical: number;
  logLevel: string;
}

export interface ThresholdResult {
  program: string;
  limit: number;
  current: number;
  percentage: number;
  severity: "ok" | "warning" | "critical";
  description: string;
  recommendation: string;
}

export interface BeneficiaryFinancials {
  beneficiaryId: string;
  firstName: string;
  lastName: string;
  email: string;
  organizationId: string;
  orgName: string;
  benefitPrograms: {
    ssi?: boolean;
    ssdi?: boolean;
    mediCal?: boolean;
    medicaid?: boolean;
    calFresh?: boolean;
    ihss?: boolean;
    able?: boolean;
  };
  totalAssetsFromCards: number;
  monthlyIncomeApprox: number;
  last30DaysSpending: number;
  householdSize: number;
  isBlind: boolean;
}

export interface AgentRunResult {
  agentName: string;
  startedAt: Date;
  completedAt: Date;
  durationMs: number;
  beneficiariesScanned: number;
  alertsCreated: number;
  alertsSkipped: number;
  errors: string[];
}

export interface BaseAgent {
  name: string;
  run(): Promise<AgentRunResult>;
}
