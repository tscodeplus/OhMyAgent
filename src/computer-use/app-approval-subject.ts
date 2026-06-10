const COMPUTER_USE_APP_ALIASES: Record<string, string[]> = {
  notepad: ['notepad', 'notepad.exe', '记事本'],
};

const COMPUTER_USE_APP_CANONICAL = new Map<string, string>();

for (const [canonical, aliases] of Object.entries(COMPUTER_USE_APP_ALIASES)) {
  for (const alias of aliases) {
    COMPUTER_USE_APP_CANONICAL.set(normalizeAliasKey(alias), canonical);
  }
}

export function canonicalComputerUseAppTarget(target: string): string {
  const trimmed = target.trim();
  return COMPUTER_USE_APP_CANONICAL.get(normalizeAliasKey(trimmed)) ?? trimmed;
}

export function computerUseApprovalSubject(action: string, target: string): string {
  return `computer_use ${action} ${canonicalComputerUseAppTarget(target)}`;
}

export function computerUseApprovalSubjectCandidates(action: string, target: string): string[] {
  const trimmed = target.trim();
  const canonical = canonicalComputerUseAppTarget(trimmed);
  const aliases = COMPUTER_USE_APP_ALIASES[canonical] ?? [canonical];
  const candidates = [
    trimmed,
    canonical,
    ...aliases,
  ]
    .map(alias => `computer_use ${action} ${alias}`)
    .filter((subject, index, all) => all.indexOf(subject) === index);

  return candidates;
}

function normalizeAliasKey(value: string): string {
  return value.trim().toLowerCase();
}
