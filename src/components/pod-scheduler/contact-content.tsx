'use client';

import { useQuery } from '@tanstack/react-query';
import { Loader2, Mail, Phone } from '@/lib/icons';
import { apiFetch } from '@/lib/api-client';
import { PageHeader, GlassPanel, UserAvatar } from '@/components/pod-scheduler/ui-primitives';
import { cn } from '@/lib/utils';

interface DevOpsContact {
  id: string;
  name: string;
  designation: string;
  email: string;
  phone: string;
  imageUrl: string | null;
}

function ContactCard({ contact }: { contact: DevOpsContact }) {
  return (
    <GlassPanel className="flex h-full flex-col p-5">
      <div className="flex items-start gap-4">
        {contact.imageUrl ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={contact.imageUrl}
            alt=""
            className="h-16 w-16 shrink-0 rounded-2xl object-cover ring-1 ring-border/60"
          />
        ) : (
          <UserAvatar name={contact.name} size="lg" />
        )}
        <div className="min-w-0 flex-1">
          <p className="text-base font-semibold text-foreground">{contact.name}</p>
          {contact.designation && (
            <p className="mt-0.5 text-sm text-muted-foreground">{contact.designation}</p>
          )}
        </div>
      </div>

      <dl className="mt-5 space-y-3 border-t border-border/60 pt-4 text-sm">
        <div>
          <dt className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
            Email Id
          </dt>
          <dd className="mt-1">
            {contact.email ? (
              <a
                href={`mailto:${contact.email}`}
                className="inline-flex items-center gap-2 text-blue-600 hover:underline dark:text-blue-400"
              >
                <Mail className="h-4 w-4 shrink-0" strokeWidth={1.75} />
                {contact.email}
              </a>
            ) : (
              <span className="text-muted-foreground">—</span>
            )}
          </dd>
        </div>
        <div>
          <dt className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
            Contact No
          </dt>
          <dd className="mt-1">
            {contact.phone ? (
              <a
                href={`tel:${contact.phone.replace(/\s+/g, '')}`}
                className="inline-flex items-center gap-2 text-foreground hover:text-blue-600 dark:hover:text-blue-400"
              >
                <Phone className="h-4 w-4 shrink-0" strokeWidth={1.75} />
                {contact.phone}
              </a>
            ) : (
              <span className="text-muted-foreground">—</span>
            )}
          </dd>
        </div>
      </dl>
    </GlassPanel>
  );
}

export function ContactContent() {
  const { data, isLoading } = useQuery({
    queryKey: ['devops-contacts'],
    queryFn: () =>
      apiFetch<{ title: string; contacts: DevOpsContact[] }>('/api/devops-contacts').catch(
        () => ({ title: 'DevOps Team', contacts: [] })
      ),
    staleTime: 60_000,
    retry: false,
  });

  const teamTitle = data?.title ?? 'DevOps Team';
  const contacts = data?.contacts ?? [];

  return (
    <div className="space-y-5">
      <PageHeader
        title="Contact"
        description="Reach the DevOps team for platform support and infrastructure requests."
      />

      {isLoading ? (
        <div className="flex justify-center py-20">
          <Loader2 className="h-7 w-7 animate-spin text-blue-500/50" />
        </div>
      ) : contacts.length === 0 ? (
        <GlassPanel className="p-8 text-center">
          <p className="text-sm font-medium text-foreground">No contacts configured yet</p>
          <p className="mt-2 text-sm text-muted-foreground">
            Admins can add team members under Admin Panel → Settings → DevOps Contacts.
          </p>
        </GlassPanel>
      ) : (
        <>
          <div className="rounded-xl border border-border/60 bg-secondary/20 px-4 py-3">
            <p className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
              Team
            </p>
            <p className="mt-1 text-lg font-semibold text-foreground">{teamTitle}</p>
          </div>

          <div
            className={cn(
              'grid gap-4',
              contacts.length === 1
                ? 'grid-cols-1 max-w-xl'
                : 'sm:grid-cols-2 xl:grid-cols-3'
            )}
          >
            {contacts.map((contact) => (
              <ContactCard key={contact.id} contact={contact} />
            ))}
          </div>
        </>
      )}
    </div>
  );
}
