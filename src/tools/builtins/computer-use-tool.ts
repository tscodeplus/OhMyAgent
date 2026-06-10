import { Type } from 'typebox';
import type { AgentTool } from '../../pi-mono/agent/types.js';
import type { ComputerUseHost } from '../../computer-use/computer-host.js';
import type { Ctx, UIElement } from '../../computer-use/types.js';
import type { PolicyCenter } from '../../policy/policy-center.js';
import type { AgentPolicyScope } from '../../policy/types.js';
import type { Logger } from 'pino';
import { canonicalComputerUseAppTarget } from '../../computer-use/app-approval-subject.js';

const MAX_ELEMENTS_IN_TEXT = 100;
const MAX_FIELD_LENGTH = 200;

type ScreenState = Awaited<ReturnType<ComputerUseHost['getAppState']>>;

function truncateField(value: string | undefined): string {
  if (!value) return '';
  return value.length > MAX_FIELD_LENGTH
    ? `${value.slice(0, MAX_FIELD_LENGTH)}...(truncated)`
    : value;
}

function isSensitiveElement(el: UIElement): boolean {
  const haystack = `${el.role} ${el.label ?? ''} ${el.description ?? ''}`.toLowerCase();
  return haystack.includes('password') || haystack.includes('secret') || haystack.includes('token');
}

export interface ComputerUseToolOptions {
  sendImage?: (image: { data: string; mimeType: string }) => Promise<string>;
  policyCenter?: PolicyCenter;
  policyScope?: AgentPolicyScope;
  approvalAlreadyHandled?: boolean;
  logger?: Logger;
}

async function getStateOrCreateDesktopLease(
  computerUseHost: ComputerUseHost,
  ctx: Ctx,
): Promise<ScreenState> {
  try {
    return await computerUseHost.getAppState(ctx, null);
  } catch (err: unknown) {
    const typedErr = err as { code?: string; message?: string; stack?: string };
    if (typedErr?.code !== 'LEASE_NOT_FOUND') {
      console.error('[CU:getStateOrCreateDesktopLease]', {
        code: typedErr?.code,
        message: typedErr?.message,
        stack: typedErr?.stack,
      });
      throw err;
    }
    await computerUseHost.createLease(ctx, { appId: 'desktop' });
    return computerUseHost.getAppState(ctx, null);
  }
}

function formatScreenState(state: ScreenState): string {
  const lines: string[] = [
    `Screen: ${state.display.width}x${state.display.height}`,
    `Lease: ${state.leaseId} | Provider: ${state.providerId}`,
  ];
  if (state.windowTitle) {
    lines.push(`Window: ${state.windowTitle}`);
  }
  lines.push(`Snapshot: ${state.snapshotId}`);
  if (state.elements.length > 0) {
    const shownElements = state.elements.slice(0, MAX_ELEMENTS_IN_TEXT);
    const total = state.elements.length;
    const showing = shownElements.length;
    if (total > MAX_ELEMENTS_IN_TEXT) {
      lines.push('', `Elements (${total}, showing first ${showing} — use element search or paging for more):`);
    } else {
      lines.push('', `Elements (${total}):`);
    }
    for (const el of shownElements) {
      const labelText = truncateField(el.label);
      const valueText = isSensitiveElement(el) ? '' : truncateField(el.value);
      const label = labelText ? ` "${labelText}"` : '';
      const value = valueText ? ` value="${valueText}"` : '';
      const status = el.enabled ? '' : ' [disabled]';
      lines.push(
        `  #${el.elementId}: ${el.role}${label}${value} at (${el.bounds.x},${el.bounds.y},${el.bounds.width},${el.bounds.height})${status}`,
      );
    }
  } else {
    lines.push('', 'Elements: (none)');
  }
  return lines.join('\n');
}

/**
 * Format any error into a tool result text block — never re-throw to the
 * agent framework, so unhandled errors don't break the agent loop.
 */
function formatError(err: unknown): { type: 'text'; text: string } {
  const typedErr = err as { code?: string; message?: string; detail?: Record<string, unknown> };
  if (typedErr && typeof typedErr.code === 'string') {
    const detail = typedErr.detail ? ` ${JSON.stringify(typedErr.detail)}` : '';
    return {
      type: 'text',
      text: `[Computer Use Error] ${typedErr.code}: ${typedErr.message ?? 'Unknown error'}${detail}`,
    };
  }
  const message = err instanceof Error ? err.message : String(err);
  return {
    type: 'text',
    text: `[Computer Use Error] unknown: ${message}`,
  };
}

/** @deprecated Use `createComputerUseToolDefinition` from `./computer-use/definition.js` instead. */
export function createComputerUseTool(
  computerUseHost: ComputerUseHost,
  getCtx?: () => Ctx,
  options: ComputerUseToolOptions = {},
): AgentTool<any> {
  /** Track the active leaseId so subsequent actions reuse it. */
  let activeLeaseId: string | null = null;

  return {
    name: 'computer_use',
    label: 'Computer Use',
	    description: 'GUI automation: open/close apps, view screen, click, type, press keys, scroll. Use process names(e.g. firefox).',
	    parameters: Type.Object({
	      action: Type.Union([
	        Type.Literal('open_app'),
	        Type.Literal('focus_app'),
	        Type.Literal('close_app'),
	        Type.Literal('view_screen'),
	        Type.Literal('send_screenshot'),
	        Type.Literal('click'),
	        Type.Literal('click_point'),
	        Type.Literal('double_click'),
	        Type.Literal('type_text'),
	        Type.Literal('press_key'),
	        Type.Literal('scroll'),
	        Type.Literal('release_control'),
	      ], { description: "Action to perform" }),
	      target: Type.Optional(Type.String({ description: "App process name (open/focus/close). e.g. firefox, msedge.exe." })),
	      lease_id: Type.Optional(Type.String({ description: "Lease ID from open_app or view_screen. Defaults to most recent." })),
	      element_id: Type.Optional(Type.String({ description: "Element ID for click/double_click" })),
	      x: Type.Optional(Type.Number({ description: "X coordinate for click_point" })),
	      y: Type.Optional(Type.Number({ description: "Y coordinate for click_point" })),
	      text: Type.Optional(Type.String({ description: "Text for type_text" })),
	      key: Type.Optional(Type.String({ description: "Key to press. e.g. Enter, Escape, Tab." })),
	      direction: Type.Optional(Type.Union([
	        Type.Literal('up'),
	        Type.Literal('down'),
	        Type.Literal('left'),
	        Type.Literal('right'),
	      ], { description: "Scroll direction" })),
	      amount: Type.Optional(Type.Number({ description: "Scroll pixels" })),
	    }),
    execute: async (
      _toolCallId: string,
      params: {
        action: string;
        target?: string;
        lease_id?: string;
        refresh?: boolean;
        element_id?: string;
        x?: number;
        y?: number;
        text?: string;
        key?: string;
        direction?: 'up' | 'down' | 'left' | 'right';
        amount?: number;
      },
      _signal?: AbortSignal,
    ) => {
      try {
        const ctx: Ctx = getCtx?.() ?? {};
        options.logger?.debug({
          action: params.action,
          target: params.target,
          canonicalTarget: params.target ? canonicalComputerUseAppTarget(params.target) : undefined,
          activeLeaseId,
          sessionPath: ctx.sessionPath,
          agentId: ctx.agentId,
        }, 'computer_use tool invoked');

        // v4: PolicyCenter tool-level gate
        if (options.policyCenter) {
          const COMPUTER_USE_CAPABILITY = {
            category: 'computer_use' as const,
            readOnly: false,
            writesFiles: false,
            readsFiles: false,
            usesShell: false,
            usesNetwork: false,
            usesComputerUse: true,
            pathAccess: 'none' as const,
            approvalDefault: 'high_risk' as const,
          };

          const decision = await options.policyCenter.evaluateToolCall({
            toolName: 'computer_use',
            capability: COMPUTER_USE_CAPABILITY,
            args: params,
            sessionId: undefined,
            agentId: ctx?.agentId,
            policyScope: options.policyScope ?? {
              toolsProfile: 'full',
              readRoots: [],
              writeRoots: [],
              deniedPatterns: [],
              shellExecMode: 'balanced',
              sessionApprovals: [],
              appApprovals: [],
              readOnly: false,
              computerUseEnabled: true,
            },
          });

          if (!decision.allowed && !decision.requiresApproval) {
            return {
              content: [{ type: 'text', text: `computer_use denied: ${decision.reason ?? 'PolicyCenter rejected'}` }],
              isError: true,
            };
          }
          if (decision.requiresApproval && !options.approvalAlreadyHandled) {
            return {
              content: [{ type: 'text', text: 'computer_use requires approval before execution' }],
              isError: true,
            };
          }
        }

        // Resolve lease ID: explicit param → tracked active → null (host resolves by session)
        const resolvedLeaseId = params.lease_id ?? activeLeaseId;

        switch (params.action) {
          case 'open_app': {
            if (!params.target) {
              return { content: [{ type: 'text', text: 'Error: "target" is required for open_app action' }] };
            }
            const appName = canonicalComputerUseAppTarget(params.target);
            const leaseStart = Date.now();
            options.logger?.info({
              requestedTarget: params.target,
              appName,
              sessionPath: ctx.sessionPath,
            }, 'computer_use open_app creating lease');
            const lease = await computerUseHost.createLease(ctx, { appName });
            activeLeaseId = lease.leaseId;
            options.logger?.info({
              requestedTarget: params.target,
              appName,
              leaseId: lease.leaseId,
              appId: lease.appId,
              providerId: lease.providerId,
              elapsedMs: Date.now() - leaseStart,
            }, 'computer_use open_app created lease');
            const contextParts: string[] = [
              `Connected to app "${lease.appId}"`,
              `Lease: ${lease.leaseId}`,
            ];
            if (lease.windowId) {
              contextParts.push(`Window: ${lease.windowId}`);
            }
            return { content: [{ type: 'text', text: contextParts.join(' | ') }] };
          }

          case 'focus_app': {
            if (!params.target) {
              return { content: [{ type: 'text', text: 'Error: "target" is required for focus_app action' }] };
            }
            const appName = canonicalComputerUseAppTarget(params.target);
            const focusLease = await computerUseHost.createLease(ctx, { appName, activateOnly: true });
            activeLeaseId = focusLease.leaseId;
            options.logger?.info({
              requestedTarget: params.target,
              appName,
              leaseId: focusLease.leaseId,
              appId: focusLease.appId,
              providerId: focusLease.providerId,
            }, 'computer_use focus_app created lease');
            return { content: [{ type: 'text', text: `Focused app "${focusLease.appId}" | Lease: ${focusLease.leaseId}` }] };
          }

          case 'close_app': {
            if (!params.target) {
              return { content: [{ type: 'text', text: 'Error: "target" is required for close_app action (e.g. "notepad++.exe")' }] };
            }
            const appName = canonicalComputerUseAppTarget(params.target);
            await computerUseHost.closeApp(ctx, appName);
            if (activeLeaseId) {
              await computerUseHost.releaseLease(ctx, activeLeaseId).catch(() => {});
              activeLeaseId = null;
            }
            return { content: [{ type: 'text', text: `Closed app "${appName}"` }] };
          }

          case 'view_screen': {
            const viewStart = Date.now();
            const state = await getStateOrCreateDesktopLease(computerUseHost, ctx);
            activeLeaseId = state.leaseId;
            options.logger?.info({
              leaseId: state.leaseId,
              providerId: state.providerId,
              elementCount: state.elements.length,
              hasScreenshot: !!state.screenshot,
              elapsedMs: Date.now() - viewStart,
            }, 'computer_use view_screen done');
            return {
              content: [
                { type: 'text', text: formatScreenState(state) },
              ],
              details: {
                snapshotId: state.snapshotId,
                leaseId: state.leaseId,
                providerId: state.providerId,
                elementCount: state.elements.length,
              },
            };
          }

          case 'send_screenshot': {
            const ssStart = Date.now();
            const state = await getStateOrCreateDesktopLease(computerUseHost, ctx);
            activeLeaseId = state.leaseId;
            options.logger?.info({
              leaseId: state.leaseId,
              providerId: state.providerId,
              hasScreenshot: !!state.screenshot,
              elapsedMs: Date.now() - ssStart,
            }, 'computer_use send_screenshot state fetched');
            if (!state.screenshot) {
              return {
                content: [{
                  type: 'text',
                  text: `Screenshot unavailable for ${state.display.width}x${state.display.height} screen`,
                }],
              };
            }
            if (!options.sendImage) {
              return {
                content: [
                  { type: 'text', text: 'Screenshot captured, but this channel cannot send images directly.' },
                  {
                    type: 'image' as const,
                    data: state.screenshot.data,
                    mimeType: state.screenshot.mimeType,
                  },
                ],
                details: {
                  snapshotId: state.snapshotId,
                  leaseId: state.leaseId,
                  providerId: state.providerId,
                  elementCount: state.elements.length,
                },
              };
            }

            const delivery = await options.sendImage({
              data: state.screenshot.data,
              mimeType: state.screenshot.mimeType,
            });
            return {
              content: [{
                type: 'text',
                text: [
                  `Screenshot sent. ${delivery}`,
                  `Screen: ${state.display.width}x${state.display.height}`,
                  `Lease: ${state.leaseId} | Provider: ${state.providerId}`,
                  `Snapshot: ${state.snapshotId}`,
                ].join('\n'),
              }],
              details: {
                snapshotId: state.snapshotId,
                leaseId: state.leaseId,
                providerId: state.providerId,
                elementCount: state.elements.length,
                sent: true,
              },
            };
          }

          case 'click': {
            if (!params.element_id) {
              return { content: [{ type: 'text', text: 'Error: "element_id" is required for click action' }] };
            }
            const result = await computerUseHost.performAction(ctx, resolvedLeaseId, {
              type: 'click_element',
              elementId: params.element_id,
            });
            if (result.ok) {
              return { content: [{ type: 'text', text: `Clicked element "${params.element_id}"` }] };
            }
            return {
              content: [{
                type: 'text',
                text: `Failed to click element "${params.element_id}": ${result.error ?? 'unknown error'}`,
              }],
            };
          }

          case 'click_point': {
            if (params.x === undefined || params.y === undefined) {
              return { content: [{ type: 'text', text: 'Error: "x" and "y" coordinates are required for click_point action' }] };
            }
            const ptResult = await computerUseHost.performAction(ctx, resolvedLeaseId, {
              type: 'click_point',
              x: params.x,
              y: params.y,
            });
            if (ptResult.ok) {
              return { content: [{ type: 'text', text: `Clicked at (${params.x}, ${params.y})` }] };
            }
            return {
              content: [{
                type: 'text',
                text: `Failed to click at (${params.x}, ${params.y}): ${ptResult.error ?? 'unknown error'}`,
              }],
            };
          }

          case 'double_click': {
            if (!params.element_id) {
              return { content: [{ type: 'text', text: 'Error: "element_id" is required for double_click action' }] };
            }
            const dblResult = await computerUseHost.performAction(ctx, resolvedLeaseId, {
              type: 'double_click',
              elementId: params.element_id,
            });
            if (dblResult.ok) {
              return { content: [{ type: 'text', text: `Double-clicked element "${params.element_id}"` }] };
            }
            return {
              content: [{
                type: 'text',
                text: `Failed to double-click element "${params.element_id}": ${dblResult.error ?? 'unknown error'}`,
              }],
            };
          }

          case 'type_text': {
            if (!params.text) {
              return { content: [{ type: 'text', text: 'Error: "text" is required for type_text action' }] };
            }
            const result = await computerUseHost.performAction(ctx, resolvedLeaseId, {
              type: 'type_text',
              text: params.text,
            });
            if (result.ok) {
              return { content: [{ type: 'text', text: `Typed text: "${params.text}"` }] };
            }
            return {
              content: [{
                type: 'text',
                text: `Failed to type text: ${result.error ?? 'unknown error'}`,
              }],
            };
          }

          case 'press_key': {
            if (!params.key) {
              return { content: [{ type: 'text', text: 'Error: "key" is required for press_key action' }] };
            }
            const result = await computerUseHost.performAction(ctx, resolvedLeaseId, {
              type: 'press_key',
              key: params.key,
            });
            if (result.ok) {
              return { content: [{ type: 'text', text: `Pressed key "${params.key}"` }] };
            }
            return {
              content: [{
                type: 'text',
                text: `Failed to press key "${params.key}": ${result.error ?? 'unknown error'}`,
              }],
            };
          }

          case 'scroll': {
            if (!params.direction) {
              return { content: [{ type: 'text', text: 'Error: "direction" is required for scroll action' }] };
            }
            const result = await computerUseHost.performAction(ctx, resolvedLeaseId, {
              type: 'scroll',
              direction: params.direction,
              amount: params.amount,
            });
            if (result.ok) {
              const detail = params.amount != null ? ` by ${params.amount}px` : '';
              return { content: [{ type: 'text', text: `Scrolled ${params.direction}${detail}` }] };
            }
            return {
              content: [{
                type: 'text',
                text: `Failed to scroll: ${result.error ?? 'unknown error'}`,
              }],
            };
          }

          case 'release_control': {
            await computerUseHost.stop(ctx, resolvedLeaseId);
            activeLeaseId = null;
            return { content: [{ type: 'text', text: 'Control released' }] };
          }

          default:
            return { content: [{ type: 'text', text: `Unknown computer_use action: "${params.action}"` }] };
        }
      } catch (err: unknown) {
        const typedErr = err as { code?: string; message?: string; stack?: string; detail?: Record<string, unknown> };
        options.logger?.warn({
          action: params.action,
          target: params.target,
          canonicalTarget: params.target ? canonicalComputerUseAppTarget(params.target) : undefined,
          activeLeaseId,
          code: typedErr?.code,
          message: typedErr?.message,
          stack: typedErr?.stack,
        }, 'computer_use tool failed');
        console.error('[CU:execute]', {
          action: params.action,
          code: typedErr?.code,
          message: typedErr?.message,
          stack: typedErr?.stack,
        });

        // APP_APPROVAL_REQUIRED: return a model-friendly message so the model
        // tells the user to approve the app instead of trying shell workarounds.
        if (typedErr?.code === 'APP_APPROVAL_REQUIRED') {
          const appId = (typedErr.detail as any)?.appId ?? params.target ?? 'this app';
          return {
            content: [{
              type: 'text',
              text: [
                `App "${appId}" is not in your allowed list and requires approval before it can be controlled.`,
                'Please ask the user to approve this app or add it to allowed_apps in config.yaml.',
                'Do NOT try to work around this by using shell commands — only computer_use can interact with desktop apps.',
              ].join(' '),
            }],
          };
        }

        return { content: [formatError(err)] };
      }
    },
  } as AgentTool<any>;
}
