/**
 * Bot display names per channel, resolved once per request.
 *
 * The WebUI sidebar labels a channel group "<bot> · <channel>" ("小书 · 飞书"),
 * because one inbox can hold several bots posting into the same channel type.
 * The name is asked of the platform, so it may be async, may time out, and may
 * simply be unknown.
 *
 * Shared by the inbox and archive routes: both render the same group labels, and
 * resolving per distinct channel (rather than per row) keeps a slow platform
 * lookup from repeating for every conversation in the page.
 */
export type BotNameResolver = (channel: string) => string | undefined | Promise<string | undefined>;

export async function resolveBotNames(
  getBotName: BotNameResolver | undefined,
  channels: string[],
): Promise<Map<string, string>> {
  const names = new Map<string, string>();
  await Promise.all(
    [...new Set(channels)].map(async (channel) => {
      // One channel failing must not take the other labels down with it.
      const name = await getBotName?.(channel);
      if (name) names.set(channel, name);
    }),
  );
  return names;
}
