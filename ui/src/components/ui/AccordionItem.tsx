import { useState, type ReactNode } from 'react';
import { ChevronDown, ChevronRight } from 'lucide-react';

interface AccordionItemProps {
  title: string;
  defaultOpen?: boolean;
  children: ReactNode;
}

export default function AccordionItem({
  title,
  defaultOpen = false,
  children,
}: AccordionItemProps) {
  const [open, setOpen] = useState(defaultOpen);
  // overflow-hidden only while collapsed: when open it would clip the
  // absolutely-positioned Select / ModelPicker dropdown panels rendered
  // inside the content.
  return (
    <div
      className={`border border-neutral-200 dark:border-neutral-800 rounded-lg bg-white dark:bg-neutral-900 ${
        open ? '' : 'overflow-hidden'
      }`}
    >
      <button
        onClick={() => setOpen(!open)}
        className="flex items-center gap-2 w-full px-4 py-2.5 text-sm font-medium text-neutral-700 dark:text-neutral-200 hover:bg-neutral-100 dark:hover:bg-neutral-700/60 transition-colors rounded-t-lg"
      >
        {open ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
        {title}
      </button>
      {open && (
        <div className="px-4 py-3 space-y-3 border-t border-neutral-200 dark:border-neutral-800 bg-white dark:bg-neutral-900 rounded-b-lg">
          {children}
        </div>
      )}
    </div>
  );
}
