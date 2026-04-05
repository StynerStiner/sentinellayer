type LogLevel = "debug" | "info" | "warn" | "error";

const LEVEL_PRIORITY: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

export class Logger {
  private minLevel: number;

  constructor(level: string = "info") {
    this.minLevel = LEVEL_PRIORITY[level as LogLevel] ?? 1;
  }

  private shouldLog(level: LogLevel): boolean {
    return LEVEL_PRIORITY[level] >= this.minLevel;
  }

  private format(level: LogLevel, agent: string, message: string, data?: Record<string, unknown>): string {
    const timestamp = new Date().toISOString();
    const prefix = `[${timestamp}] [${level.toUpperCase()}] [${agent}]`;
    const suffix = data ? ` ${JSON.stringify(data)}` : "";
    return `${prefix} ${message}${suffix}`;
  }

  debug(agent: string, message: string, data?: Record<string, unknown>): void {
    if (this.shouldLog("debug")) {
      console.log(this.format("debug", agent, message, data));
    }
  }

  info(agent: string, message: string, data?: Record<string, unknown>): void {
    if (this.shouldLog("info")) {
      console.log(this.format("info", agent, message, data));
    }
  }

  warn(agent: string, message: string, data?: Record<string, unknown>): void {
    if (this.shouldLog("warn")) {
      console.warn(this.format("warn", agent, message, data));
    }
  }

  error(agent: string, message: string, data?: Record<string, unknown>): void {
    if (this.shouldLog("error")) {
      console.error(this.format("error", agent, message, data));
    }
  }

  banner(agents: { name: string; interval: string }[]): void {
    console.log("\n============================================");
    console.log("  SENTINELLAYER -- Autonomous Operations Layer");
    console.log("  BenefitsSafe AI Agent System");
    console.log("============================================");
    console.log(`  Started: ${new Date().toISOString()}`);
    console.log(`  Active agents:`);
    for (const a of agents) {
      console.log(`    - ${a.name} (every ${a.interval})`);
    }
    console.log("============================================\n");
  }
}
