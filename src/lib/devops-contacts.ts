import prisma from './prisma';
import { invalidateSettingsCache } from './settings';

export const DEVOPS_CONTACTS_TITLE_KEY = 'devops_contacts_title';
export const DEFAULT_DEVOPS_CONTACTS_TITLE = 'DevOps Team';
const MAX_IMAGE_BYTES = 512_000;

export interface DevOpsContactView {
  id: string;
  name: string;
  designation: string;
  email: string;
  phone: string;
  imageUrl: string | null;
  sortOrder: number;
  enabled: boolean;
}

export interface DevOpsContactsPublicView {
  title: string;
  contacts: DevOpsContactView[];
}

function toView(row: {
  id: string;
  name: string;
  designation: string;
  email: string;
  phone: string;
  imageUrl: string | null;
  sortOrder: number;
  enabled: boolean;
}): DevOpsContactView {
  return {
    id: row.id,
    name: row.name,
    designation: row.designation,
    email: row.email,
    phone: row.phone,
    imageUrl: row.imageUrl,
    sortOrder: row.sortOrder,
    enabled: row.enabled,
  };
}

export function validateContactImage(imageUrl: string | null | undefined): string | null {
  if (imageUrl == null || imageUrl === '') return null;
  const trimmed = imageUrl.trim();
  if (!trimmed) return null;

  if (/^https?:\/\//i.test(trimmed)) {
    if (trimmed.length > 2048) throw new Error('Image URL is too long');
    return trimmed;
  }

  if (!trimmed.startsWith('data:image/')) {
    throw new Error('Image must be a URL or uploaded image file');
  }

  const commaIdx = trimmed.indexOf(',');
  if (commaIdx === -1) throw new Error('Invalid image data');

  const header = trimmed.slice(0, commaIdx);
  if (!/^data:image\/(jpeg|jpg|png|webp|gif);base64$/i.test(header)) {
    throw new Error('Image must be JPEG, PNG, WebP, or GIF');
  }

  const payload = trimmed.slice(commaIdx + 1);
  const approxBytes = Math.ceil((payload.length * 3) / 4);
  if (approxBytes > MAX_IMAGE_BYTES) {
    throw new Error('Image must be 500 KB or smaller');
  }

  return trimmed;
}

export async function getDevOpsContactsTitle(): Promise<string> {
  const row = await prisma.systemSetting.findUnique({
    where: { key: DEVOPS_CONTACTS_TITLE_KEY },
  });
  const trimmed = row?.value?.trim();
  return trimmed || DEFAULT_DEVOPS_CONTACTS_TITLE;
}

export async function setDevOpsContactsTitle(title: string): Promise<string> {
  const trimmed = title.trim();
  if (!trimmed) throw new Error('Section title is required');
  if (trimmed.length > 80) throw new Error('Section title must be 80 characters or fewer');
  await prisma.systemSetting.upsert({
    where: { key: DEVOPS_CONTACTS_TITLE_KEY },
    create: { key: DEVOPS_CONTACTS_TITLE_KEY, value: trimmed },
    update: { value: trimmed },
  });
  invalidateSettingsCache();
  return trimmed;
}

export async function listDevOpsContacts(opts?: { includeDisabled?: boolean }): Promise<DevOpsContactView[]> {
  const rows = await prisma.devOpsContact.findMany({
    where: opts?.includeDisabled ? undefined : { enabled: true },
    orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }],
  });
  return rows.map(toView);
}

export async function getDevOpsContactsPublicView(): Promise<DevOpsContactsPublicView> {
  const [title, contacts] = await Promise.all([
    getDevOpsContactsTitle(),
    listDevOpsContacts({ includeDisabled: false }),
  ]);
  return { title, contacts };
}

export async function getDevOpsContactsAdminView(): Promise<DevOpsContactsPublicView> {
  const [title, contacts] = await Promise.all([
    getDevOpsContactsTitle(),
    listDevOpsContacts({ includeDisabled: true }),
  ]);
  return { title, contacts };
}

export async function createDevOpsContact(input: {
  name: string;
  designation?: string;
  email?: string;
  phone?: string;
  imageUrl?: string | null;
  enabled?: boolean;
}): Promise<DevOpsContactView> {
  const name = input.name.trim();
  if (!name) throw new Error('Name is required');

  const maxSort = await prisma.devOpsContact.aggregate({ _max: { sortOrder: true } });
  const sortOrder = (maxSort._max.sortOrder ?? -1) + 1;

  const row = await prisma.devOpsContact.create({
    data: {
      name,
      designation: input.designation?.trim() ?? '',
      email: input.email?.trim() ?? '',
      phone: input.phone?.trim() ?? '',
      imageUrl: validateContactImage(input.imageUrl),
      enabled: input.enabled ?? true,
      sortOrder,
    },
  });

  return toView(row);
}

export async function updateDevOpsContact(
  id: string,
  input: {
    name?: string;
    designation?: string;
    email?: string;
    phone?: string;
    imageUrl?: string | null;
    enabled?: boolean;
    sortOrder?: number;
  }
): Promise<DevOpsContactView> {
  const existing = await prisma.devOpsContact.findUnique({ where: { id } });
  if (!existing) throw new Error('Contact not found');

  const data: {
    name?: string;
    designation?: string;
    email?: string;
    phone?: string;
    imageUrl?: string | null;
    enabled?: boolean;
    sortOrder?: number;
  } = {};

  if (input.name !== undefined) {
    const name = input.name.trim();
    if (!name) throw new Error('Name is required');
    data.name = name;
  }
  if (input.designation !== undefined) data.designation = input.designation.trim();
  if (input.email !== undefined) data.email = input.email.trim();
  if (input.phone !== undefined) data.phone = input.phone.trim();
  if (input.imageUrl !== undefined) data.imageUrl = validateContactImage(input.imageUrl);
  if (input.enabled !== undefined) data.enabled = input.enabled;
  if (input.sortOrder !== undefined) data.sortOrder = input.sortOrder;

  const row = await prisma.devOpsContact.update({ where: { id }, data });
  return toView(row);
}

export async function deleteDevOpsContact(id: string): Promise<void> {
  await prisma.devOpsContact.delete({ where: { id } });
}
