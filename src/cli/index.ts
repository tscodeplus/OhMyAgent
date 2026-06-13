import 'dotenv/config';

function getHelpText(): string {
  const lang = process.env.UI_LANGUAGE || 'en';
  if (lang === 'zh-CN') {
    return `OhMyAgent CLI

用法:
  ohmyagent start              后台启动服务（CLI 模式）
  ohmyagent stop               停止服务
  ohmyagent restart            重启服务
  ohmyagent status             查看运行状态
  ohmyagent doctor             系统诊断
  ohmyagent service install    安装系统服务（开机自启）
  ohmyagent service uninstall  卸载系统服务

技能管理:
  ohmyagent skill list              列出所有技能
  ohmyagent skill show <id>         显示技能详情
  ohmyagent skill lint <id>         校验技能
  ohmyagent skill test <id> --message "..."  测试技能匹配
  ohmyagent skill create <name>     创建新技能
  ohmyagent skill list-templates    列出可用模板

订阅管理:
  ohmyagent login [provider]   登录 AI 订阅（Anthropic / GitHub Copilot / ChatGPT）
  ohmyagent logout [provider]  登出订阅
  ohmyagent subscription list  列出所有订阅状态
  ohmyagent subscription status <provider>  查看订阅详情

注意: 如果已安装系统服务，应使用平台原生命令管理:
  Linux:   systemctl --user start/stop/status ohmyagent
  macOS:   launchctl load/unload ~/Library/LaunchAgents/com.ohmyagent.plist
  Termux:  sv up/down/status ohmyagent
  Windows: schtasks /Run /End /Query "OhMyAgent"
  ohmyagent status 在所有平台上都可以用来检查服务状态。
`;
  }
  return `OhMyAgent CLI

Usage:
  ohmyagent start              Start service in background (CLI mode)
  ohmyagent stop               Stop service
  ohmyagent restart            Restart service
  ohmyagent status             Show running status
  ohmyagent doctor             System diagnostics
  ohmyagent service install    Install system service (auto-start)
  ohmyagent service uninstall  Remove system service

Subscription:
  ohmyagent login [provider]   Login to AI subscription (Anthropic / GitHub Copilot / ChatGPT)
  ohmyagent logout [provider]  Logout from subscription
  ohmyagent subscription list  List all subscription statuses
  ohmyagent subscription status <provider>  Show subscription details

Note: If a system service is installed, use native commands instead:
  Linux:   systemctl --user start/stop/status ohmyagent
  macOS:   launchctl load/unload ~/Library/LaunchAgents/com.ohmyagent.plist
  Termux:  sv up/down/status ohmyagent
  Windows: schtasks /Run /End /Query "OhMyAgent"
  ohmyagent status works on all platforms to check if the service is running.
`;
}

function printHelp(): void {
  console.log(getHelpText());
}

async function main(): Promise<void> {
  // Parse positional arguments manually for simplicity (Node 18 compatible)
  const args = process.argv.slice(2);

  if (args.length === 0 || args[0] === 'help' || args[0] === '--help' || args[0] === '-h') {
    printHelp();
    return;
  }

  const command = args[0];
  const subAction = args[1];

  switch (command) {
    case 'start': {
      const { startCommand } = await import('./commands/start.js');
      await startCommand();
      break;
    }
    case 'stop': {
      const { stopCommand } = await import('./commands/stop.js');
      await stopCommand();
      break;
    }
    case 'restart': {
      const { restartCommand } = await import('./commands/restart.js');
      await restartCommand();
      break;
    }
    case 'status': {
      const { statusCommand } = await import('./commands/status.js');
      await statusCommand();
      break;
    }
    case 'doctor': {
      const { doctorCommand } = await import('./commands/doctor.js');
      await doctorCommand();
      break;
    }
    case 'service': {
      if (subAction !== 'install' && subAction !== 'uninstall') {
        console.error('用法: ohmyagent service <install|uninstall>');
        process.exit(1);
      }
      const { serviceCommand } = await import('./commands/service.js');
      await serviceCommand(subAction);
      break;
    }
    case 'login': {
      const { loginCommand } = await import('./commands/login.js');
      await loginCommand(subAction);
      break;
    }
    case 'logout': {
      const { logoutCommand } = await import('./commands/logout.js');
      await logoutCommand(subAction);
      break;
    }
    case 'subscription': {
      const { subscriptionCommand } = await import('./commands/subscription.js');
      await subscriptionCommand(subAction ?? 'list', args.slice(2));
      break;
    }
    case 'skill': {
      const { skillCommand } = await import('./commands/skill.js');
      await skillCommand(subAction ?? 'help', args.slice(2));
      break;
    }
    default:
      const lang = process.env.UI_LANGUAGE || 'en';
      if (lang === 'zh-CN') {
        console.error(`未知命令: ${command}`);
        console.error('运行 ohmyagent --help 查看可用命令');
      } else {
        console.error(`Unknown command: ${command}`);
        console.error('Run ohmyagent --help for available commands');
      }
      process.exit(1);
  }
}

main().catch((error) => {
  console.error('CLI 错误:', error.message);
  process.exit(1);
});
