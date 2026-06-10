import type { Logger } from 'pino';
import type { ExtensionManifest, ExtensionAPI, ExtensionHooks, LoadedExtension } from './types.js';
import type { ChannelAdapter } from '../channel/types.js';
import type { ResolvedAgentConfig } from '../agent/config-types.js';
import { ExtensionLoader } from './extension-loader.js';

export class ExtensionManager {
  private extensions: LoadedExtension[] = [];
  private channels: ChannelAdapter[] = [];

  constructor(
    private loader: ExtensionLoader,
    private api: ExtensionAPI,
    private logger: Logger,
  ) {}

  async loadAll(directories: string[]): Promise<void> {
    const seenIds = new Set<string>();

    for (const dir of directories) {
      const manifests = await this.loader.scan(dir);
      for (const manifest of manifests) {
        if (seenIds.has(manifest.id)) {
          this.logger.info({ extId: manifest.id }, 'Extension already loaded from higher-priority directory, skipping');
          continue;
        }
        seenIds.add(manifest.id);

        try {
          await this.loader.load(manifest, dir, this.api);
          this.extensions.push({ manifest, baseDir: dir, status: 'loaded' });
          this.logger.info({ extId: manifest.id, kind: manifest.kind }, 'Extension loaded');
        } catch (err) {
          const errorMsg = err instanceof Error ? err.message : String(err);
          this.logger.error({ extId: manifest.id, err: errorMsg }, 'Extension load failed');
          this.extensions.push({ manifest, baseDir: dir, status: 'error', error: errorMsg });
        }
      }
    }
  }

  list(): LoadedExtension[] {
    return [...this.extensions];
  }

  getForAgent(agent: ResolvedAgentConfig): LoadedExtension[] {
    const disabled = new Set(agent.extensions.disable);
    return this.extensions.filter(ext => {
      if (disabled.has(ext.manifest.id)) return false;
      if (ext.manifest.kind === 'channel') {
        const channelType = ext.manifest.channel_type;
        if (channelType) {
          return agent.channels.some(ch =>
            ch === channelType || ch.startsWith(channelType + ':')
          );
        }
      }
      return true;
    });
  }

  getForChannel(channelType: string): LoadedExtension[] {
    return this.extensions.filter(ext =>
      ext.manifest.kind === 'channel' && ext.manifest.channel_type === channelType
    );
  }

  getChannels(): ChannelAdapter[] {
    return [...this.channels];
  }

  registerChannel(adapter: ChannelAdapter): void {
    this.channels.push(adapter);
    this.logger.info({ channelId: adapter.id }, 'Channel registered');
  }

  getHooks(): ExtensionHooks[] {
    return []; // hooks are collected by ExtensionAPI and stored separately
  }

  async shutdown(): Promise<void> {
    for (const channel of this.channels) {
      try {
        await channel.stop();
      } catch (err) {
        this.logger.error({ channelId: channel.id, err }, 'Error stopping channel');
      }
    }
    this.channels = [];
  }
}
