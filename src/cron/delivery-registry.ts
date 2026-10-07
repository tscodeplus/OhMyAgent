/**
 * Channel-agnostic cron result delivery.
 *
 * Each channel registers a CronDeliveryClient on startup. JobRunner
 * dispatches results through the registry based on job.channel.
 */

import type { FooterConfig } from '../app/types.js';

export interface CronDeliveryClient {
  deliver(params: {
    chatId: string;
    text: string;
    /** Model label in "provider/model-id" format. */
    modelLabel: string;
    /** Agent name (separate from modelLabel for footer config control). */
    agentName?: string;
    /** Footer display config. */
    footer: FooterConfig;
  }): Promise<void>;
  /**
   * Optional plain-text notice path for short system one-liners (judge free-Jev
   * daily privacy notice) — no model label / timestamp footer chrome. When a
   * client omits it, callers fall back to `deliver`.
   */
  deliverNotice?(params: { chatId: string; text: string }): Promise<void>;
}

export class CronDeliveryRegistry {
  private clients = new Map<string, CronDeliveryClient>();

  register(channelId: string, client: CronDeliveryClient): void {
    this.clients.set(channelId, client);
  }

  get(channelId: string): CronDeliveryClient | undefined {
    return this.clients.get(channelId);
  }

  listChannels(): string[] {
    return [...this.clients.keys()];
  }
}
