import type { ReactNode } from 'react';

interface SettingsSectionProps {
  title: string;
  children: ReactNode;
}

export function SettingsSection({ title, children }: SettingsSectionProps) {
  return (
    <section>
      <h3 className="text-sm font-semibold text-neutral-900 dark:text-neutral-100 mb-3">{title}</h3>
      {children}
    </section>
  );
}

interface SettingsCardProps {
  children: ReactNode;
  className?: string;
}

export function SettingsCard({ children, className = '' }: SettingsCardProps) {
  return (
    <div
      className={`space-y-3 rounded-lg border border-neutral-200 dark:border-neutral-800 bg-white dark:bg-neutral-900 p-4 ${className}`}
    >
      {children}
    </div>
  );
}
