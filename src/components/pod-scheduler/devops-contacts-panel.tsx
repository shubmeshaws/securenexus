'use client';

import { useEffect, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Loader2, PenLine, PlusCircle, Trash2, UsersRound } from '@/lib/icons';
import { apiFetch } from '@/lib/api-client';
import { PanelHeader } from '@/components/pod-scheduler/ui-primitives';
import { ConfirmDialog } from '@/components/pod-scheduler/confirm-dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { Badge } from '@/components/ui/badge';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { UserAvatar } from '@/components/pod-scheduler/ui-primitives';
import { cn } from '@/lib/utils';

interface DevOpsContact {
  id: string;
  name: string;
  designation: string;
  email: string;
  phone: string;
  imageUrl: string | null;
  sortOrder: number;
  enabled: boolean;
}

interface ContactFormState {
  name: string;
  designation: string;
  email: string;
  phone: string;
  imageUrl: string;
  enabled: boolean;
}

const emptyForm = (): ContactFormState => ({
  name: '',
  designation: '',
  email: '',
  phone: '',
  imageUrl: '',
  enabled: true,
});

function readImageFile(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result ?? ''));
    reader.onerror = () => reject(new Error('Failed to read image file'));
    reader.readAsDataURL(file);
  });
}

export function DevOpsContactsPanel() {
  const queryClient = useQueryClient();
  const fileInputRef = useRef<HTMLInputElement>(null);

  const { data, isLoading } = useQuery({
    queryKey: ['admin-devops-contacts'],
    queryFn: () =>
      apiFetch<{ title: string; contacts: DevOpsContact[] }>('/api/admin/devops-contacts'),
  });

  const contacts = data?.contacts ?? [];
  const [sectionTitle, setSectionTitle] = useState('DevOps Team');
  const [editingId, setEditingId] = useState<string | null>(null);
  const [formOpen, setFormOpen] = useState(false);
  const [form, setForm] = useState<ContactFormState>(emptyForm);
  const [removeId, setRemoveId] = useState<string | null>(null);
  const [saveFeedback, setSaveFeedback] = useState<{ ok: boolean; message: string } | null>(null);
  const [imageError, setImageError] = useState<string | null>(null);

  useEffect(() => {
    if (data?.title) setSectionTitle(data.title);
  }, [data?.title]);

  const editing = contacts.find((c) => c.id === editingId) ?? null;

  const openCreate = () => {
    setEditingId(null);
    setForm(emptyForm());
    setImageError(null);
    setFormOpen(true);
  };

  const openEdit = (contact: DevOpsContact) => {
    setEditingId(contact.id);
    setForm({
      name: contact.name,
      designation: contact.designation,
      email: contact.email,
      phone: contact.phone,
      imageUrl: contact.imageUrl ?? '',
      enabled: contact.enabled,
    });
    setImageError(null);
    setFormOpen(true);
  };

  const saveTitleMutation = useMutation({
    mutationFn: (title: string) =>
      apiFetch('/api/admin/devops-contacts', {
        method: 'PUT',
        body: JSON.stringify({ title }),
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['admin-devops-contacts'] });
      queryClient.invalidateQueries({ queryKey: ['devops-contacts'] });
    },
  });

  const saveContactMutation = useMutation({
    mutationFn: async () => {
      const payload = {
        name: form.name.trim(),
        designation: form.designation.trim(),
        email: form.email.trim(),
        phone: form.phone.trim(),
        imageUrl: form.imageUrl.trim() || null,
        enabled: form.enabled,
      };

      if (editingId) {
        return apiFetch<{ contact: DevOpsContact }>(`/api/admin/devops-contacts/${editingId}`, {
          method: 'PUT',
          body: JSON.stringify(payload),
        });
      }

      return apiFetch<{ contact: DevOpsContact }>('/api/admin/devops-contacts', {
        method: 'POST',
        body: JSON.stringify(payload),
      });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['admin-devops-contacts'] });
      queryClient.invalidateQueries({ queryKey: ['devops-contacts'] });
      setFormOpen(false);
      setEditingId(null);
      setSaveFeedback({ ok: true, message: editingId ? 'Contact updated' : 'Contact added' });
      setTimeout(() => setSaveFeedback(null), 3000);
    },
    onError: (err: Error) => {
      setSaveFeedback({ ok: false, message: err.message || 'Failed to save contact' });
    },
  });

  const deleteMutation = useMutation({
    mutationFn: (id: string) =>
      apiFetch(`/api/admin/devops-contacts/${id}`, { method: 'DELETE' }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['admin-devops-contacts'] });
      queryClient.invalidateQueries({ queryKey: ['devops-contacts'] });
      setRemoveId(null);
    },
  });

  const handleImagePick = async (file: File | null) => {
    if (!file) return;
    setImageError(null);
    if (!file.type.startsWith('image/')) {
      setImageError('Please choose an image file');
      return;
    }
    if (file.size > 512_000) {
      setImageError('Image must be 500 KB or smaller');
      return;
    }
    try {
      const dataUrl = await readImageFile(file);
      setForm((prev) => ({ ...prev, imageUrl: dataUrl }));
    } catch {
      setImageError('Failed to read image');
    }
  };

  if (isLoading) {
    return (
      <div className="flex justify-center py-10">
        <Loader2 className="h-6 w-6 animate-spin text-blue-500/50" />
      </div>
    );
  }

  return (
    <div>
      <PanelHeader title="DevOps Contacts" icon={UsersRound} accent="sky" />
      <p className="mt-1 text-xs text-muted-foreground">
        Configure contacts shown in the sidebar Contact section.
      </p>

      <div className="mt-4 space-y-4">
        <div className="grid gap-3 sm:grid-cols-[1fr_auto] sm:items-end">
          <div className="space-y-2">
            <Label>Section title</Label>
            <Input
              value={sectionTitle}
              onChange={(e) => setSectionTitle(e.target.value)}
              placeholder="DevOps Team"
            />
          </div>
          <Button
            type="button"
            variant="outline"
            onClick={() => saveTitleMutation.mutate(sectionTitle.trim())}
            disabled={saveTitleMutation.isPending || !sectionTitle.trim()}
          >
            {saveTitleMutation.isPending ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              'Save title'
            )}
          </Button>
        </div>

        <div className="flex flex-wrap items-center justify-between gap-3">
          <p className="text-xs text-muted-foreground">
            {contacts.length} contact{contacts.length === 1 ? '' : 's'} configured
          </p>
          <Button type="button" size="sm" onClick={openCreate}>
            <PlusCircle className="h-4 w-4" />
            Add contact
          </Button>
        </div>

        {saveFeedback && (
          <p
            className={cn(
              'text-xs',
              saveFeedback.ok ? 'text-emerald-700 dark:text-emerald-400' : 'text-red-700 dark:text-red-400'
            )}
          >
            {saveFeedback.message}
          </p>
        )}

        {contacts.length === 0 ? (
          <div className="rounded-xl border border-dashed border-border/80 px-4 py-8 text-center text-sm text-muted-foreground">
            No contacts yet. Add team members to show them in the sidebar.
          </div>
        ) : (
          <div className="space-y-2">
            {contacts.map((contact) => (
              <div
                key={contact.id}
                className="flex flex-wrap items-center gap-3 rounded-xl border border-border/70 bg-secondary/20 px-3 py-3"
              >
                {contact.imageUrl ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img
                    src={contact.imageUrl}
                    alt=""
                    className="h-10 w-10 shrink-0 rounded-xl object-cover ring-1 ring-border/60"
                  />
                ) : (
                  <UserAvatar name={contact.name} size="lg" />
                )}
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <p className="text-sm font-medium text-foreground">{contact.name}</p>
                    {!contact.enabled && (
                      <Badge variant="secondary" className="text-[10px]">
                        Hidden
                      </Badge>
                    )}
                  </div>
                  {contact.designation && (
                    <p className="text-xs text-muted-foreground">{contact.designation}</p>
                  )}
                  <p className="truncate text-[11px] text-muted-foreground">
                    {[contact.email, contact.phone].filter(Boolean).join(' · ')}
                  </p>
                </div>
                <div className="flex items-center gap-1">
                  <Button type="button" size="icon" variant="ghost" onClick={() => openEdit(contact)}>
                    <PenLine className="h-4 w-4" />
                  </Button>
                  <Button
                    type="button"
                    size="icon"
                    variant="ghost"
                    className="text-red-600 hover:text-red-700 dark:text-red-400"
                    onClick={() => setRemoveId(contact.id)}
                  >
                    <Trash2 className="h-4 w-4" />
                  </Button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      <Dialog open={formOpen} onOpenChange={setFormOpen}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>{editing ? 'Edit contact' : 'Add contact'}</DialogTitle>
            <DialogDescription>
              Details appear in the sidebar Contact section for all signed-in users.
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-3">
            <div className="space-y-2">
              <Label>Name</Label>
              <Input
                value={form.name}
                onChange={(e) => setForm((prev) => ({ ...prev, name: e.target.value }))}
                placeholder="Jane Doe"
              />
            </div>
            <div className="space-y-2">
              <Label>Designation</Label>
              <Input
                value={form.designation}
                onChange={(e) => setForm((prev) => ({ ...prev, designation: e.target.value }))}
                placeholder="Senior DevOps Engineer"
              />
            </div>
            <div className="space-y-2">
              <Label>Email Id</Label>
              <Input
                type="email"
                value={form.email}
                onChange={(e) => setForm((prev) => ({ ...prev, email: e.target.value }))}
                placeholder="jane@company.com"
              />
            </div>
            <div className="space-y-2">
              <Label>Contact No</Label>
              <Input
                value={form.phone}
                onChange={(e) => setForm((prev) => ({ ...prev, phone: e.target.value }))}
                placeholder="+91 98765 43210"
              />
            </div>
            <div className="space-y-2">
              <Label>Image</Label>
              <div className="flex items-center gap-3">
                {form.imageUrl ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img
                    src={form.imageUrl}
                    alt=""
                    className="h-12 w-12 rounded-xl object-cover ring-1 ring-border/60"
                  />
                ) : (
                  <UserAvatar name={form.name || '?'} size="lg" />
                )}
                <div className="flex flex-wrap gap-2">
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={() => fileInputRef.current?.click()}
                  >
                    Upload image
                  </Button>
                  {form.imageUrl && (
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      onClick={() => setForm((prev) => ({ ...prev, imageUrl: '' }))}
                    >
                      Remove
                    </Button>
                  )}
                </div>
                <input
                  ref={fileInputRef}
                  type="file"
                  accept="image/jpeg,image/png,image/webp,image/gif"
                  className="hidden"
                  onChange={(e) => void handleImagePick(e.target.files?.[0] ?? null)}
                />
              </div>
              {imageError && <p className="text-xs text-red-600 dark:text-red-400">{imageError}</p>}
              <p className="text-[11px] text-muted-foreground">JPEG, PNG, WebP, or GIF — max 500 KB.</p>
            </div>
            <div className="flex items-center justify-between rounded-lg border border-border/60 px-3 py-2.5">
              <div>
                <p className="text-sm font-medium">Show in sidebar</p>
                <p className="text-[11px] text-muted-foreground">Disabled contacts stay saved but hidden.</p>
              </div>
              <Switch
                checked={form.enabled}
                onCheckedChange={(checked) => setForm((prev) => ({ ...prev, enabled: checked }))}
              />
            </div>
          </div>

          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setFormOpen(false)}>
              Cancel
            </Button>
            <Button
              type="button"
              onClick={() => saveContactMutation.mutate()}
              disabled={saveContactMutation.isPending || !form.name.trim()}
            >
              {saveContactMutation.isPending ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : editing ? (
                'Save changes'
              ) : (
                'Add contact'
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <ConfirmDialog
        open={Boolean(removeId)}
        onOpenChange={(open) => !open && setRemoveId(null)}
        title="Remove contact?"
        description="This contact will be removed from the sidebar."
        confirmLabel="Remove"
        destructive
        onConfirm={() => removeId && deleteMutation.mutate(removeId)}
        loading={deleteMutation.isPending}
      />
    </div>
  );
}
