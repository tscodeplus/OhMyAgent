import { HarnessRateLimitConfig, FailurePattern } from './types.js';

export class HarnessRateLimiter {
  private config: HarnessRateLimitConfig;
  private cooldownMap: Map<string, number> = new Map();
  private hourlyTimestamps: number[] = [];
  private dailyTimestamps: number[] = [];
  private autoApplyTimestamps: number[] = [];

  constructor(config: HarnessRateLimitConfig) {
    this.config = config;
  }

  canTrigger(
    skillId: string | undefined,
    agentId: string | undefined,
    pattern: FailurePattern
  ): boolean {
    // 1. Build cooldown key from (skillId ?? "_") + "/" + (agentId ?? "_") + "/" + pattern
    const key = (skillId ?? '_') + '/' + (agentId ?? '_') + '/' + pattern;

    // 2. Check cooldown (config.cooldownMinutes → ms)
    const lastCooldown = this.cooldownMap.get(key);
    if (lastCooldown !== undefined && Date.now() - lastCooldown < this.config.cooldownMinutes * 60000) {
      return false;
    }

    // 3. Prune old hourly timestamps (> 3600000 ms old) and check count < maxPerHour
    this.hourlyTimestamps = this.hourlyTimestamps.filter(ts => Date.now() - ts < 3600000);
    if (this.hourlyTimestamps.length >= this.config.maxPerHour) {
      return false;
    }

    // 4. Prune old daily timestamps (> 86400000 ms old) and check count < maxPerDay
    this.dailyTimestamps = this.dailyTimestamps.filter(ts => Date.now() - ts < 86400000);
    if (this.dailyTimestamps.length >= this.config.maxPerDay) {
      return false;
    }

    // 5. All pass: record now in all maps, return true
    const now = Date.now();
    this.cooldownMap.set(key, now);
    this.hourlyTimestamps.push(now);
    this.dailyTimestamps.push(now);

    return true;
  }

  getHourlyCount(): number {
    this.hourlyTimestamps = this.hourlyTimestamps.filter(ts => Date.now() - ts < 3600000);
    return this.hourlyTimestamps.length;
  }

  getDailyCount(): number {
    this.dailyTimestamps = this.dailyTimestamps.filter(ts => Date.now() - ts < 86400000);
    return this.dailyTimestamps.length;
  }

  getAutoApplyCount(): number {
    this.autoApplyTimestamps = this.autoApplyTimestamps.filter(ts => Date.now() - ts < 86400000);
    return this.autoApplyTimestamps.length;
  }

  recordAutoApply(): void {
    this.autoApplyTimestamps.push(Date.now());
  }

  reset(): void {
    this.cooldownMap.clear();
    this.hourlyTimestamps = [];
    this.dailyTimestamps = [];
    this.autoApplyTimestamps = [];
  }
}
