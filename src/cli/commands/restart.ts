import { stopCommand } from './stop.js';
import { startCommand } from './start.js';
import { t } from '../i18n.js';

export async function restartCommand(): Promise<void> {
  console.log(t('restart.restarting'));
  console.log('');
  await stopCommand();
  console.log('');
  await startCommand();
}
