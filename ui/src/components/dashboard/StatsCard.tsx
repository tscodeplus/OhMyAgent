interface StatsCardProps {
  title: string;
  value: string | number;
}

export default function StatsCard({ title, value }: StatsCardProps) {
  return (
    <div className="rounded-xl border border-neutral-200 dark:border-neutral-800 bg-white dark:bg-neutral-900 p-5 hover:shadow-md transition-shadow">
      <p className="text-sm text-neutral-500 dark:text-neutral-400 mb-1">{title}</p>
      <p className="text-3xl font-bold text-neutral-900 dark:text-neutral-100">{value}</p>
    </div>
  );
}
