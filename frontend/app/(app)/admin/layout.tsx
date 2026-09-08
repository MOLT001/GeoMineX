'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { RequireRole } from '@/components/RequireRole';

/**
 * The Admin Panel — PRD §5.9.
 *
 * `RequireAuth` has already run in `app/(app)/layout.tsx`, so this adds only
 * the role check. Two guards in two layouts, each doing one thing.
 *
 * Every endpoint beneath this subtree is independently protected by
 * `roleGuard('admin')` on the server. This gate exists so an admin-only page
 * does not render a shell that then fills with 403s — it is not what keeps a
 * non-admin out (§9.1).
 */

const TABS = [
  { href: '/admin/users', label: 'Users' },
  { href: '/admin/subsidiaries', label: 'Subsidiaries' },
  { href: '/admin/templates', label: 'Report templates' },
];

export default function AdminLayout({ children }: { children: React.ReactNode }) {
  return (
    <RequireRole roles={['admin']}>
      <div className="flex flex-col gap-6">
        <AdminTabs />
        {children}
      </div>
    </RequireRole>
  );
}

function AdminTabs() {
  const pathname = usePathname();

  return (
    <nav aria-label="Admin sections" className="border-b border-border">
      <ul className="flex gap-1">
        {TABS.map((tab) => {
          const active = pathname === tab.href || pathname.startsWith(`${tab.href}/`);
          return (
            <li key={tab.href}>
              <Link
                href={tab.href}
                aria-current={active ? 'page' : undefined}
                className={
                  active
                    ? // The active tab is marked by weight and a rule as well as
                      // colour, so the current section is identifiable without it.
                      'inline-block border-b-2 border-sih-blue px-4 py-2.5 text-sm font-semibold text-sih-blue'
                    : 'inline-block border-b-2 border-transparent px-4 py-2.5 text-sm text-text-muted transition-colors hover:text-primary-dark'
                }
              >
                {tab.label}
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
