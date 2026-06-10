// ---------------------------------------------------------------------------
// OhMyAgent 多Agent并行调度集成测试
// 测试目标：验证 OhMyAgent 自身的 Orchestrator 多Agent编排能力
// 包括：主Agent调度子Agent、任务分解分配、Agent间通信、结果收集、Team协作
// ---------------------------------------------------------------------------

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { OrchestratorImpl } from '../../src/orchestrator/orchestrator.js';
import { InMemoryAgentRunStore } from '../../src/orchestrator/agent-run-store.js';
import { InMemoryTaskRunStore } from '../../src/orchestrator/task-run-store.js';
import { DEFAULT_POLICY_SCOPE } from '../../src/policy/types.js';
import type { AgentPolicyScope, ChildAgentPolicyRequest } from '../../src/policy/types.js';
import type { AgentRun, TaskRun, AgentMessage } from '../../src/orchestrator/types.js';

// ---------------------------------------------------------------------------
// 测试工具函数
// ---------------------------------------------------------------------------

function makeLogger() {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    trace: vi.fn(),
    fatal: vi.fn(),
    level: 'info',
    silent: vi.fn(),
    child: vi.fn(() => makeLogger()),
    bindings: vi.fn(() => makeLogger()),
    destination: undefined,
    levels: {},
    log: vi.fn(),
  } as any;
}

function makeMinimalPermissionInheritance() {
  return {
    deriveChildScope: vi.fn((_parent: AgentRun, request: ChildAgentPolicyRequest) => ({
      ...DEFAULT_POLICY_SCOPE,
      toolsProfile: request.requestedToolsProfile ?? 'minimal',
      computerUseEnabled: false,
    })),
  };
}

function makeMinimalApprovalStateSync() {
  return { routeApproval: vi.fn(async () => undefined) };
}

function makeOrchestrator(overrides: Partial<{
  agentRunStore: InMemoryAgentRunStore;
  taskRunStore: InMemoryTaskRunStore;
}> = {}) {
  return new OrchestratorImpl({
    agentRunStore: overrides.agentRunStore ?? new InMemoryAgentRunStore(),
    taskRunStore: overrides.taskRunStore ?? new InMemoryTaskRunStore(),
    permissionInheritance: makeMinimalPermissionInheritance(),
    approvalStateSync: makeMinimalApprovalStateSync(),
    policyCenter: {} as any,
    agentFactory: {} as any,
    agentManager: {} as any,
    pendingApprovals: {} as any,
    logger: makeLogger(),
  });
}

/** 辅助：创建一个 primary agent run */
function seedPrimary(store: InMemoryAgentRunStore, agentId: string, sessionId: string) {
  return store.create({
    agentId,
    rootSessionId: sessionId,
    role: 'primary',
    scope: DEFAULT_POLICY_SCOPE,
    prompt: 'primary task',
  });
}

// ---------------------------------------------------------------------------
// 场景1: 主Agent创建多个子Agent（模拟并行任务分发）
// ---------------------------------------------------------------------------

describe('场景1: 主Agent调度多子Agent并行工作', () => {
  let agentRunStore: InMemoryAgentRunStore;
  let orch: OrchestratorImpl;

  beforeEach(() => {
    agentRunStore = new InMemoryAgentRunStore();
    orch = makeOrchestrator({ agentRunStore });
  });

  it('主Agent spawn 3个子Agent，各自独立运行', async () => {
    const sessionId = 'session-1';
    const primaryId = 'primary-agent';
    seedPrimary(agentRunStore, primaryId, sessionId);

    // 主Agent 同时 spawn 3个子Agent处理不同任务
    const childPromises = ['代码审查', '安全检查', '文档生成'].map((task) =>
      orch.spawnChildAgent({
        parentAgentId: primaryId,
        sessionId,
        prompt: task,
        requestedScope: { requestedToolsProfile: 'minimal' },
      }),
    );

    const children = await Promise.all(childPromises);

    // 验证3个子Agent全部创建成功
    expect(children).toHaveLength(3);
    children.forEach((child, i) => {
      expect(child.role).toBe('child');
      expect(child.parentAgentId).toBe(primaryId);
      expect(child.rootSessionId).toBe(sessionId);
      expect(child.status).toBe('running');
      expect(child.scope.computerUseEnabled).toBe(false);
    });

    // 验证所有子Agent归属于同一个父Agent
    const siblings = agentRunStore.listByParent(primaryId);
    expect(siblings).toHaveLength(3);

    // 验证 session 中共有4个 AgentRun（1个主 + 3个子）
    const allRuns = orch.listAgentRuns(sessionId);
    expect(allRuns).toHaveLength(4);
  });

  it('同一 session 最多容纳多个子Agent', async () => {
    const sessionId = 'session-2';
    const primaryId = 'primary-agent';
    seedPrimary(agentRunStore, primaryId, sessionId);

    // 创建5个子Agent
    for (let i = 0; i < 5; i++) {
      await orch.spawnChildAgent({
        parentAgentId: primaryId,
        sessionId,
        prompt: `task-${i}`,
        requestedScope: {},
      });
    }

    const children = agentRunStore.listByParent(primaryId);
    expect(children).toHaveLength(5);
    // 验证所有子Agent状态均为 running
    children.forEach((c) => expect(c.status).toBe('running'));
  });
});

// ---------------------------------------------------------------------------
// 场景2: 任务分解与分配（主Agent拆解任务 -> 分配给子Agent）
// ---------------------------------------------------------------------------

describe('场景2: 任务分解与分配', () => {
  let orch: OrchestratorImpl;
  const sessionId = 'session-task-1';
  const primaryId = 'primary-agent';

  beforeEach(() => {
    const agentRunStore = new InMemoryAgentRunStore();
    seedPrimary(agentRunStore, primaryId, sessionId);
    orch = makeOrchestrator({ agentRunStore });
  });

  it('主Agent创建父子任务层级结构', async () => {
    // 父任务
    const parentTask = await orch.createTask({
      sessionId,
      ownerAgentId: primaryId,
      title: '实现用户认证功能',
      description: '包括登录、注册、密码重置',
    });
    expect(parentTask.status).toBe('pending');
    expect(parentTask.taskId).toMatch(/^task-/);

    // 拆分为3个子任务
    const subTasks = await Promise.all([
      orch.createTask({
        sessionId,
        ownerAgentId: primaryId,
        title: '实现登录接口',
        description: 'POST /api/auth/login',
        parentTaskId: parentTask.taskId,
      }),
      orch.createTask({
        sessionId,
        ownerAgentId: primaryId,
        title: '实现注册接口',
        description: 'POST /api/auth/register',
        parentTaskId: parentTask.taskId,
      }),
      orch.createTask({
        sessionId,
        ownerAgentId: primaryId,
        title: '实现密码重置',
        description: 'POST /api/auth/reset-password',
        parentTaskId: parentTask.taskId,
      }),
    ]);

    expect(subTasks).toHaveLength(3);
    subTasks.forEach((st) => {
      expect(st.parentTaskId).toBe(parentTask.taskId);
      expect(st.sessionId).toBe(sessionId);
    });

    // 验证session中所有任务
    const allTasks = await orch.listTasks(sessionId);
    expect(allTasks).toHaveLength(4); // 1父 + 3子
  });

  it('将子任务分配给不同的子Agent执行', async () => {
    // 创建任务
    const task = await orch.createTask({
      sessionId,
      ownerAgentId: primaryId,
      title: '代码审查任务',
      description: '审查 PR #42',
    });

    // 分配给子Agent
    await orch.updateTask(task.taskId, {
      ownerAgentId: 'child-coder-1',
      status: 'running',
    });

    const updated = await orch.getTask(task.taskId);
    expect(updated!.ownerAgentId).toBe('child-coder-1');
    expect(updated!.status).toBe('running');
  });

  it('子Agent完成后更新任务状态并填写结果摘要', async () => {
    const task = await orch.createTask({
      sessionId,
      ownerAgentId: 'child-agent-1',
      title: '分析日志错误',
      description: '分析 /var/log/app.log 中的错误',
    });

    // 子Agent开始执行
    await orch.updateTask(task.taskId, { status: 'running' });

    // 子Agent完成，填写结果
    const completed = await orch.updateTask(task.taskId, {
      status: 'completed',
      resultSummary: '发现3个错误：连接超时(x5)、空指针(x2)、权限拒绝(x1)',
    });

    expect(completed!.status).toBe('completed');
    expect(completed!.resultSummary).toContain('连接超时');
    expect(completed!.resultSummary).toContain('空指针');
  });
});

// ---------------------------------------------------------------------------
// 场景3: Agent间消息通信
// ---------------------------------------------------------------------------

describe('场景3: Agent间消息通信', () => {
  let agentRunStore: InMemoryAgentRunStore;
  let orch: OrchestratorImpl;
  const sessionId = 'session-msg-1';

  beforeEach(() => {
    agentRunStore = new InMemoryAgentRunStore();
    orch = makeOrchestrator({ agentRunStore });
  });

  it('主Agent向子Agent发送指令消息', async () => {
    // 注册主Agent和子Agent
    seedPrimary(agentRunStore, 'primary', sessionId);
    agentRunStore.create({
      agentId: 'child-1',
      parentAgentId: 'primary',
      rootSessionId: sessionId,
      role: 'child',
      scope: DEFAULT_POLICY_SCOPE,
      prompt: '',
    });

    await orch.sendMessage({
      fromAgentId: 'primary',
      toAgentId: 'child-1',
      sessionId,
      kind: 'instruction',
      content: '请优先处理登录模块的安全审计',
    });

    const msgs = orch.getMessages('child-1');
    expect(msgs).toHaveLength(1);
    expect(msgs[0].kind).toBe('instruction');
    expect(msgs[0].fromAgentId).toBe('primary');
    expect(msgs[0].toAgentId).toBe('child-1');
    expect(msgs[0].content).toContain('安全审计');
  });

  it('子Agent向主Agent报告状态和结果', async () => {
    seedPrimary(agentRunStore, 'primary', sessionId);
    agentRunStore.create({
      agentId: 'child-2',
      parentAgentId: 'primary',
      rootSessionId: sessionId,
      role: 'child',
      scope: DEFAULT_POLICY_SCOPE,
      prompt: '',
    });

    // 子Agent报告进度
    await orch.sendMessage({
      fromAgentId: 'child-2',
      toAgentId: 'primary',
      sessionId,
      kind: 'status',
      content: '已完成 60%，正在处理数据库迁移',
    });

    // 子Agent报告完成
    await orch.sendMessage({
      fromAgentId: 'child-2',
      toAgentId: 'primary',
      sessionId,
      kind: 'result',
      content: '安全审计完成，未发现高危漏洞',
    });

    const primaryMsgs = orch.getMessages('primary');
    expect(primaryMsgs).toHaveLength(2);
    expect(primaryMsgs[0].kind).toBe('status');
    expect(primaryMsgs[1].kind).toBe('result');
  });

  it('消息类型支持 instruction/status/result/question 四种', async () => {
    seedPrimary(agentRunStore, 'primary', sessionId);
    agentRunStore.create({
      agentId: 'child-3',
      parentAgentId: 'primary',
      rootSessionId: sessionId,
      role: 'child',
      scope: DEFAULT_POLICY_SCOPE,
      prompt: '',
    });

    const kinds: Array<AgentMessage['kind']> = ['instruction', 'status', 'result', 'question'];

    for (const kind of kinds) {
      await orch.sendMessage({
        fromAgentId: 'primary',
        toAgentId: 'child-3',
        sessionId,
        kind,
        content: `消息类型: ${kind}`,
      });
    }

    const allMsgs = orch.getMessages();
    expect(allMsgs).toHaveLength(4);
    kinds.forEach((k) => {
      expect(allMsgs.some((m) => m.kind === k)).toBe(true);
    });
  });

  it('跨 session 消息被拒绝', async () => {
    agentRunStore.create({
      agentId: 'target',
      rootSessionId: 'session-b',
      role: 'child',
      scope: DEFAULT_POLICY_SCOPE,
      prompt: '',
    });

    await expect(
      orch.sendMessage({
        fromAgentId: 'primary',
        toAgentId: 'target',
        sessionId: 'session-a',
        kind: 'instruction',
        content: 'hello',
      }),
    ).rejects.toThrow('Cross-session messaging is not allowed');
  });
});

// ---------------------------------------------------------------------------
// 场景4: 结果收集与汇总
// ---------------------------------------------------------------------------

describe('场景4: 子Agent结果收集与汇总', () => {
  let agentRunStore: InMemoryAgentRunStore;
  let orch: OrchestratorImpl;
  const sessionId = 'session-collect-1';
  const primaryId = 'primary-agent';

  beforeEach(() => {
    agentRunStore = new InMemoryAgentRunStore();
    seedPrimary(agentRunStore, primaryId, sessionId);
    orch = makeOrchestrator({ agentRunStore });
  });

  it('主Agent收集所有子Agent完成结果', async () => {
    // 创建3个子Agent
    const children: AgentRun[] = [];
    for (const task of ['前端审计', '后端审计', '数据库审计']) {
      const child = await orch.spawnChildAgent({
        parentAgentId: primaryId,
        sessionId,
        prompt: task,
        requestedScope: {},
      });
      children.push(child);
    }

    // 所有子Agent完成工作
    await orch.finishAgent(children[0].agentId, 'completed', '前端: 发现2个XSS漏洞');
    await orch.finishAgent(children[1].agentId, 'completed', '后端: 发现1个SQL注入风险');
    await orch.finishAgent(children[2].agentId, 'failed', '数据库: 连接超时');

    // 主Agent收集结果
    const results = await orch.collectResults(primaryId);
    expect(results).toHaveLength(3);

    // 验证结果状态
    const completedResults = results.filter((r) => r.status === 'completed');
    const failedResults = results.filter((r) => r.status === 'failed');
    expect(completedResults).toHaveLength(2);
    expect(failedResults).toHaveLength(1);

    // 验证结果摘要内容
    const frontendResult = results.find((r) => r.summary?.includes('XSS'));
    const backendResult = results.find((r) => r.summary?.includes('SQL注入'));
    const dbResult = results.find((r) => r.summary?.includes('连接超时'));
    expect(frontendResult).toBeDefined();
    expect(backendResult).toBeDefined();
    expect(dbResult).toBeDefined();
  });

  it('无子Agent时 collectResults 返回空数组', async () => {
    const results = await orch.collectResults(primaryId);
    expect(results).toHaveLength(0);
  });

  it('只收集直接子Agent的结果，不包含孙子Agent', async () => {
    // 创建直接子Agent
    const child = await orch.spawnChildAgent({
      parentAgentId: primaryId,
      sessionId,
      prompt: 'task',
      requestedScope: {},
    });

    // 以子Agent为parent再创建孙子Agent（模拟嵌套 - 虽然当前系统主要支持两层）
    agentRunStore.create({
      agentId: 'grandchild-1',
      parentAgentId: child.agentId,
      rootSessionId: sessionId,
      role: 'child',
      scope: DEFAULT_POLICY_SCOPE,
      prompt: '',
    });

    // collectResults(primary) 应该只返回直接子Agent
    const results = await orch.collectResults(primaryId);
    expect(results).toHaveLength(1);
    expect(results[0].agentId).toBe(child.agentId);
  });
});

// ---------------------------------------------------------------------------
// 场景5: 完整多Agent工作流
// ---------------------------------------------------------------------------

describe('场景5: 完整多Agent工作流（端到端）', () => {
  it('模拟真实的"主Agent拆分任务 -> 子Agent并行执行 -> 汇总结果"流程', async () => {
    const sessionId = 'session-e2e-1';
    const primaryId = 'orchestrator-1';
    const agentRunStore = new InMemoryAgentRunStore();
    const taskRunStore = new InMemoryTaskRunStore();
    const orch = makeOrchestrator({ agentRunStore, taskRunStore });

    // ----- 阶段1: 初始化 -----
    seedPrimary(agentRunStore, primaryId, sessionId);

    // ----- 阶段2: 主Agent分析需求，创建任务树 -----
    const rootTask = await orch.createTask({
      sessionId,
      ownerAgentId: primaryId,
      title: '新功能上线安全检查',
      description: '对即将上线的支付模块进行全面的代码审查和安全检查',
    });

    const subTaskDefs = [
      { title: '代码规范审查', desc: '检查代码是否符合团队规范' },
      { title: '安全漏洞扫描', desc: '扫描SQL注入、XSS、CSRF等常见漏洞' },
      { title: '依赖项审计', desc: '检查第三方依赖是否有已知CVE漏洞' },
      { title: '性能评估', desc: '评估关键路径的性能瓶颈' },
    ];

    const subTasks = await Promise.all(
      subTaskDefs.map((t) =>
        orch.createTask({
          sessionId,
          ownerAgentId: primaryId,
          title: t.title,
          description: t.desc,
          parentTaskId: rootTask.taskId,
        }),
      ),
    );
    expect(subTasks).toHaveLength(4);

    // ----- 阶段3: 主Agent spawn 4个子Agent，各负责一个子任务 -----
    const childAgents = await Promise.all(
      subTasks.map((task, i) =>
        orch.spawnChildAgent({
          parentAgentId: primaryId,
          sessionId,
          prompt: `${task.title}: ${task.description}`,
          requestedScope: { requestedToolsProfile: 'standard' },
        }).then(async (child) => {
          // 将任务分配给子Agent
          await orch.updateTask(task.taskId, {
            ownerAgentId: child.agentId,
            status: 'running',
          });
          return child;
        }),
      ),
    );
    expect(childAgents).toHaveLength(4);

    // ----- 阶段4: 子Agent之间通信协调 -----
    // 子Agent 1 向 子Agent 3 询问依赖项信息
    await orch.sendMessage({
      fromAgentId: childAgents[0].agentId,
      toAgentId: childAgents[2].agentId,
      sessionId,
      kind: 'question',
      content: '你那边扫描到哪些依赖有高危漏洞？我需要交叉验证',
    });

    // 子Agent 3 回复
    await orch.sendMessage({
      fromAgentId: childAgents[2].agentId,
      toAgentId: childAgents[0].agentId,
      sessionId,
      kind: 'status',
      content: '发现 lodash 4.17.15 有原型污染漏洞(CVE-2019-10744)，建议升级到 4.17.21',
    });

    // 验证消息通信
    const child0Msgs = orch.getMessages(childAgents[0].agentId);
    expect(child0Msgs).toHaveLength(2);

    // ----- 阶段5: 子Agent逐步完成并报告 -----
    const results = [
      { agentId: childAgents[0].agentId, status: 'completed' as const, detail: '代码规范审查通过，发现3处命名不规范' },
      { agentId: childAgents[1].agentId, status: 'completed' as const, detail: '安全扫描完成：高危0，中危2，低危5' },
      { agentId: childAgents[2].agentId, status: 'completed' as const, detail: '依赖审计：1个高危(lodash)，3个中危，建议立即升级' },
      { agentId: childAgents[3].agentId, status: 'failed' as const, detail: '性能评估超时，profiler无法连接到生产环境' },
    ];

    // 并行完成所有子Agent
    await Promise.all(
      results.map((r) => orch.finishAgent(r.agentId, r.status, r.detail)),
    );

    // 更新对应的任务状态
    for (let i = 0; i < subTasks.length; i++) {
      await orch.updateTask(subTasks[i].taskId, {
        status: results[i].status,
        resultSummary: results[i].detail,
      });
    }

    // ----- 阶段6: 主Agent收集并汇总结果 -----
    const collectedResults = await orch.collectResults(primaryId);
    expect(collectedResults).toHaveLength(4);

    const completedCount = collectedResults.filter((r) => r.status === 'completed').length;
    const failedCount = collectedResults.filter((r) => r.status === 'failed').length;
    expect(completedCount).toBe(3);
    expect(failedCount).toBe(1);

    // 验证最终任务状态
    const finalTasks = await orch.listTasks(sessionId);
    expect(finalTasks).toHaveLength(5); // 1根 + 4子
    const completedTasks = finalTasks.filter((t) => t.status === 'completed');
    const failedTasks = finalTasks.filter((t) => t.status === 'failed');
    expect(completedTasks).toHaveLength(3);
    expect(failedTasks).toHaveLength(1);

    // 验证 session 所有 AgentRun 状态
    const allRuns = orch.listAgentRuns(sessionId);
    expect(allRuns).toHaveLength(5); // 1主 + 4子
    const completedRuns = allRuns.filter((r) => r.status === 'completed');
    const failedRuns = allRuns.filter((r) => r.status === 'failed');
    expect(completedRuns).toHaveLength(3);
    expect(failedRuns).toHaveLength(1);
    // 主Agent 仍然存活 (status 应该是 pending 或 running)
    const primaryRun = allRuns.find((r) => r.agentId === primaryId);
    expect(primaryRun).toBeDefined();
    expect(['pending', 'running']).toContain(primaryRun!.status);
  });
});

// ---------------------------------------------------------------------------
// 场景6: Agent 生命周期管理（停止、超时、状态转换）
// ---------------------------------------------------------------------------

describe('场景6: Agent 生命周期管理', () => {
  it('stopAgent 将子Agent状态标记为 stopped', async () => {
    const agentRunStore = new InMemoryAgentRunStore();
    const orch = makeOrchestrator({ agentRunStore });
    const sessionId = 'session-lifecycle-1';
    const primaryId = 'primary-agent';

    seedPrimary(agentRunStore, primaryId, sessionId);
    const child = await orch.spawnChildAgent({
      parentAgentId: primaryId,
      sessionId,
      prompt: '长时间运行的任务',
      requestedScope: {},
    });

    // 主Agent决定终止子Agent
    await orch.stopAgent(child.agentId);

    const stopped = orch.getAgentRun(child.agentId);
    expect(stopped!.status).toBe('stopped');
    expect(stopped!.finishedAt).toBeGreaterThan(0);
  });

  it('finishAgent 支持 completed 和 failed 两种终态', async () => {
    const agentRunStore = new InMemoryAgentRunStore();
    const orch = makeOrchestrator({ agentRunStore });
    const sessionId = 'session-lifecycle-2';

    seedPrimary(agentRunStore, 'primary', sessionId);
    const child1 = await orch.spawnChildAgent({
      parentAgentId: 'primary', sessionId, prompt: 'task1', requestedScope: {},
    });
    const child2 = await orch.spawnChildAgent({
      parentAgentId: 'primary', sessionId, prompt: 'task2', requestedScope: {},
    });

    await orch.finishAgent(child1.agentId, 'completed', '成功');
    await orch.finishAgent(child2.agentId, 'failed', '执行异常');

    expect(orch.getAgentRun(child1.agentId)!.status).toBe('completed');
    expect(orch.getAgentRun(child2.agentId)!.status).toBe('failed');
  });

  it('AgentRun 状态转换 pending -> running -> completed/failed/stopped', async () => {
    const agentRunStore = new InMemoryAgentRunStore();
    const orch = makeOrchestrator({ agentRunStore });

    // pending (初始创建)
    const run = agentRunStore.create({
      agentId: 'test-agent',
      rootSessionId: 's1',
      role: 'child',
      scope: DEFAULT_POLICY_SCOPE,
      prompt: '',
    });
    expect(run.status).toBe('pending');

    // pending -> running
    agentRunStore.update('test-agent', { status: 'running', startedAt: Date.now() });
    expect(orch.getAgentRun('test-agent')!.status).toBe('running');

    // running -> completed
    await orch.finishAgent('test-agent', 'completed', 'done');
    expect(orch.getAgentRun('test-agent')!.status).toBe('completed');
    expect(orch.getAgentRun('test-agent')!.finishedAt).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// 场景7: 多Agent权限继承验证
// ---------------------------------------------------------------------------

describe('场景7: 子Agent权限继承', () => {
  it('所有子Agent的 computerUseEnabled 强制为 false', async () => {
    const agentRunStore = new InMemoryAgentRunStore();
    const orch = makeOrchestrator({ agentRunStore });
    const sessionId = 'session-perm-1';

    seedPrimary(agentRunStore, 'primary', sessionId);

    const children = await Promise.all(
      ['task-a', 'task-b', 'task-c'].map((task) =>
        orch.spawnChildAgent({
          parentAgentId: 'primary',
          sessionId,
          prompt: task,
          requestedScope: {},
        }),
      ),
    );

    children.forEach((child) => {
      expect(child.scope.computerUseEnabled).toBe(false);
    });
  });

  it('子Agent继承父Agent的 toolsProfile（或使用请求的profile）', async () => {
    const agentRunStore = new InMemoryAgentRunStore();
    const orch = makeOrchestrator({ agentRunStore });
    const sessionId = 'session-perm-2';

    seedPrimary(agentRunStore, 'primary', sessionId);

    const child1 = await orch.spawnChildAgent({
      parentAgentId: 'primary', sessionId, prompt: 'task1',
      requestedScope: { requestedToolsProfile: 'minimal' },
    });
    const child2 = await orch.spawnChildAgent({
      parentAgentId: 'primary', sessionId, prompt: 'task2',
      requestedScope: { requestedToolsProfile: 'standard' },
    });

    expect(child1.scope.toolsProfile).toBe('minimal');
    expect(child2.scope.toolsProfile).toBe('standard');
  });
});
