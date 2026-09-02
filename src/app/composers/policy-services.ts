import type { AppConfig } from '../types.js';
import type { openDatabase } from '../../memory/db.js';
import { ApprovalPolicyRepository } from '../../memory/repositories/approval-policy-repository.js';
import { SQLiteApprovalGate } from '../../tools/approval-gate.js';
import { ReplyApprovalRegistry } from '../../../extensions/channel-feishu/render/reply-approval-registry.js';
import { PathAccessPolicyImpl } from '../../policy/path-policy.js';
import { ShellExecutionPolicyImpl } from '../../policy/shell/evaluator.js';
import { ToolVisibilityPolicyImpl } from '../../policy/tool-visibility.js';
import { ApprovalResolutionPolicyImpl } from '../../policy/approval/resolution.js';
import { AgentInheritancePolicyImpl } from '../../policy/inheritance/scope-merge.js';
import { PolicyCenterImpl } from '../../policy/policy-center.js';
import { getAgentHome, resolveAgentPath } from '../../shared/agent-home.js';
import { configEventBus } from '../config-event-bus.js';

export interface PolicyServices {
  policyRepository: ApprovalPolicyRepository;
  approvalGate: SQLiteApprovalGate;
  replyApprovalRegistry: ReplyApprovalRegistry;
  pathPolicy: PathAccessPolicyImpl;
  approvalResolution: ApprovalResolutionPolicyImpl;
  policyCenter: PolicyCenterImpl;
}

/** Attachment cache dir is a relative config value — anchor it like its writer does. */
function mediaCacheRoot(config: AppConfig): string | undefined {
  const cacheDir = config.multimodal?.attachments?.cacheDir;
  return cacheDir ? resolveAgentPath(cacheDir) : undefined;
}

export function createPolicyServices(
  config: AppConfig,
  db: ReturnType<typeof openDatabase>,
): PolicyServices {
  const policyRepository = new ApprovalPolicyRepository(db);
  const approvalGate = new SQLiteApprovalGate(policyRepository, {
    execMode: config.tools.shellExecMode,
    shellAllowlist: config.tools.shellAllowlist,
    fileReadAllowedRoots: config.tools.fileRead.allowedRoots,
    shellApprovalMode: config.tools.shellApprovalMode,
    shellApprovalWhitelist: config.tools.shellApprovalWhitelist,
  });

  const seedAllowlist =
    (config.tools.shellAllowlist?.length ?? 0) > 0
      ? config.tools.shellAllowlist
      : config.tools.shellApprovalWhitelist;
  approvalGate.createWhitelistPolicies(seedAllowlist);

  const replyApprovalRegistry = new ReplyApprovalRegistry();
  const pathPolicy = new PathAccessPolicyImpl({
    readRoots: config.policy?.path?.readRoots ?? config.tools.fileRead.allowedRoots,
    writeRoots: config.policy?.path?.writeRoots ?? [],
    deniedPatterns: config.policy?.path?.deniedPatterns ?? config.tools.fileRead.deniedPatterns,
    // cwd: readable only (launch dir is not a write boundary). agentHome: the
    // explicit read+write root, from OHMYAGENT_HOME — see src/shared/agent-home.ts.
    autoInjectCwd: true,
    agentHome: getAgentHome(),
    autoInjectMediaCache: mediaCacheRoot(config),
  });

  const shellPolicy = new ShellExecutionPolicyImpl({ approvalGate });
  const toolVisibility = new ToolVisibilityPolicyImpl();
  const approvalResolution = new ApprovalResolutionPolicyImpl({ approvalGate });
  const agentInheritance = new AgentInheritancePolicyImpl();

  const policyCenter = new PolicyCenterImpl({
    mode: config.policy?.mode ?? 'balanced',
    toolVisibility,
    pathAccess: pathPolicy,
    shellExecution: shellPolicy,
    approvalResolution,
    agentInheritance,
  });

  // Register config-reload handlers for approval gate and path policy
  configEventBus.onReload((c) => {
    policyCenter.updateMode(c.policy?.mode ?? 'balanced');
    approvalGate.updateConfig({
      execMode: c.tools.shellExecMode,
      shellAllowlist: c.tools.shellAllowlist,
      fileReadAllowedRoots: c.tools.fileRead.allowedRoots,
      shellApprovalMode: c.tools.shellApprovalMode,
      shellApprovalWhitelist: c.tools.shellApprovalWhitelist,
    });
    approvalGate.createWhitelistPolicies(
      (c.tools.shellAllowlist?.length ?? 0) > 0
        ? c.tools.shellAllowlist
        : c.tools.shellApprovalWhitelist,
    );
  });
  configEventBus.onReload((c) => {
    pathPolicy.updateConfig({
      readRoots: c.policy?.path?.readRoots ?? c.tools.fileRead.allowedRoots,
      writeRoots: c.policy?.path?.writeRoots ?? [],
      deniedPatterns: c.policy?.path?.deniedPatterns ?? c.tools.fileRead.deniedPatterns,
      autoInjectCwd: true,
      agentHome: getAgentHome(),
      autoInjectMediaCache: mediaCacheRoot(c),
    });
  });

  return {
    policyRepository,
    approvalGate,
    replyApprovalRegistry,
    pathPolicy,
    approvalResolution,
    policyCenter,
  };
}
