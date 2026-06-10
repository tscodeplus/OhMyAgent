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

export interface PolicyServices {
  policyRepository: ApprovalPolicyRepository;
  approvalGate: SQLiteApprovalGate;
  replyApprovalRegistry: ReplyApprovalRegistry;
  pathPolicy: PathAccessPolicyImpl;
  approvalResolution: ApprovalResolutionPolicyImpl;
  policyCenter: PolicyCenterImpl;
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

  const seedAllowlist = (config.tools.shellAllowlist?.length ?? 0) > 0
    ? config.tools.shellAllowlist
    : config.tools.shellApprovalWhitelist;
  approvalGate.createWhitelistPolicies(seedAllowlist);

  const replyApprovalRegistry = new ReplyApprovalRegistry();
  const pathPolicy = new PathAccessPolicyImpl({
    readRoots: config.policy?.path?.readRoots ?? config.tools.fileRead.allowedRoots,
    writeRoots: config.policy?.path?.writeRoots ?? [],
    deniedPatterns: config.policy?.path?.deniedPatterns ?? config.tools.fileRead.deniedPatterns,
    autoInjectCwd: true,
    autoInjectMediaCache: config.multimodal?.attachments?.cacheDir,
  });

  const shellPolicy = new ShellExecutionPolicyImpl({ approvalGate });
  const toolVisibility = new ToolVisibilityPolicyImpl();
  const approvalResolution = new ApprovalResolutionPolicyImpl({ approvalGate });
  const agentInheritance = new AgentInheritancePolicyImpl();

  const policyCenter = new PolicyCenterImpl({
    toolVisibility,
    pathAccess: pathPolicy,
    shellExecution: shellPolicy,
    approvalResolution,
    agentInheritance,
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
