import { Claim, ClaimStatus, ProductType, SyncState } from '../types';
import { supabase } from './supabase';

type ClaimRow = Record<string, unknown>;

const statuses: ClaimStatus[] = ['with_us', 'gone_for_warranty_claim', 'delivered_to_customer'];
const productTypes: ProductType[] = ['battery', 'ups'];
const syncStates: SyncState[] = ['synced', 'pending', 'failed', 'disabled'];

function objectOrUndefined(value: unknown): Record<string, string> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  return value as Record<string, string>;
}

function asText(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback;
}

function asNumber(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function arrayOrUndefined(value: unknown): Array<unknown> | undefined {
  return Array.isArray(value) ? value : undefined;
}

export function cloudRowToClaim(row: ClaimRow): Claim {
  const battery = objectOrUndefined(row.battery_details);
  const ups = objectOrUndefined(row.ups_details);
  const attachmentsArray = arrayOrUndefined(row.attachments);
  const status = statuses.includes(row.status as ClaimStatus) ? (row.status as ClaimStatus) : 'with_us';
  const productType = productTypes.includes(row.product_type as ProductType)
    ? (row.product_type as ProductType)
    : 'battery';
  const syncState = syncStates.includes(row.sync_state as SyncState)
    ? (row.sync_state as SyncState)
    : 'pending';

  return {
    id: asText(row.id),
    caseNumber: asText(row.case_number),
    productType,
    productSerial: asText(row.product_serial),
    scanPayload: asText(row.scan_payload) || undefined,
    productName: asText(row.product_name),
    customerName: asText(row.customer_name),
    mobileNumber: asText(row.mobile_number),
    slipNumber: asText(row.slip_number),
    complaint: asText(row.complaint),
    status,
    cleared: Boolean(row.cleared),
    createdBy: asText(row.created_by_name, 'Team member'),
    createdAt: asText(row.created_at, new Date().toISOString()),
    updatedAt: asText(row.updated_at, new Date().toISOString()),
    receivedAt: asText(row.received_at, new Date().toISOString()),
    deliveredAt: asText(row.delivered_at) || undefined,
    reminderDueAt: asText(row.reminder_due_at, new Date().toISOString()),
    reminderEveryDays: asNumber(row.reminder_every_days, 3),
    previousClaimId: asText(row.previous_claim_id) || undefined,
    replacementSerial: asText(row.replacement_serial) || undefined,
    replacementProductName: asText(row.replacement_product_name) || undefined,
    battery: battery
      ? {
          voltage: asText(battery.voltage),
          capacity: asText(battery.capacity),
          chemistry: asText(battery.chemistry),
          warrantyMonths: asText(battery.warrantyMonths),
        }
      : undefined,
    ups: ups
      ? {
          rating: asText(ups.rating),
          batteryCount: asText(ups.batteryCount),
          batteryCapacity: asText(ups.batteryCapacity),
          warrantyMonths: asText(ups.warrantyMonths),
          repairPrice: asText(ups.repairPrice),
          sellingPrice: asText(ups.sellingPrice),
        }
      : undefined,
    attachments: attachmentsArray
      ? attachmentsArray.map((item) => {
          const uri = typeof item === 'object' && item && 'uri' in item ? String((item as any).uri) : '';
          const name = typeof item === 'object' && item && 'name' in item ? String((item as any).name) : undefined;
          const id = typeof item === 'object' && item && 'id' in item ? String((item as any).id) : `${uri}-${name || ''}`;
          return { id, uri, name };
        })
      : undefined,
    syncState,
  };
}

export async function loadCloudClaims(): Promise<Claim[] | null> {
  if (!supabase) return null;
  const { data, error } = await supabase.from('claims').select('*').order('updated_at', { ascending: false });
  if (error) throw error;
  return (data as ClaimRow[]).map(cloudRowToClaim);
}

export async function createCloudClaim(claim: Claim): Promise<void> {
  if (!supabase) return;
  const { error } = await supabase.from('claims').insert({
    id: claim.id,
    case_number: claim.caseNumber,
    product_type: claim.productType,
    product_serial: claim.productSerial,
    scan_payload: claim.scanPayload ?? null,
    product_name: claim.productName,
    customer_name: claim.customerName,
    mobile_number: claim.mobileNumber,
    slip_number: claim.slipNumber,
    complaint: claim.complaint,
    status: claim.status,
    cleared: claim.cleared,
    created_by_name: claim.createdBy,
    created_at: claim.createdAt,
    updated_at: claim.updatedAt,
    received_at: claim.receivedAt,
    delivered_at: claim.deliveredAt ?? null,
    reminder_due_at: claim.reminderDueAt,
    reminder_every_days: claim.reminderEveryDays,
    previous_claim_id: claim.previousClaimId ?? null,
    replacement_serial: claim.replacementSerial ?? null,
    replacement_product_name: claim.replacementProductName ?? null,
    battery_details: claim.battery ?? null,
    ups_details: claim.ups ?? null,
    sync_state: claim.syncState === 'disabled' ? 'pending' : claim.syncState,
  });
  if (error) throw error;
  await syncClaimsToSheets();
}

export async function patchCloudClaim(id: string, updates: Partial<Claim>): Promise<void> {
  if (!supabase) return;
  const patch: Record<string, unknown> = { updated_at: updates.updatedAt ?? new Date().toISOString() };
  if ('status' in updates) patch.status = updates.status;
  if ('cleared' in updates) patch.cleared = updates.cleared;
  if ('deliveredAt' in updates) patch.delivered_at = updates.deliveredAt ?? null;
  if ('reminderDueAt' in updates) patch.reminder_due_at = updates.reminderDueAt;
  if ('reminderEveryDays' in updates) patch.reminder_every_days = updates.reminderEveryDays;
  if ('replacementSerial' in updates) patch.replacement_serial = updates.replacementSerial ?? null;
  if ('replacementProductName' in updates) patch.replacement_product_name = updates.replacementProductName ?? null;
  if ('ups' in updates) patch.ups_details = updates.ups ?? null;
  if ('attachments' in updates) patch.attachments = updates.attachments ?? null;
  if ('syncState' in updates && updates.syncState !== 'disabled') patch.sync_state = updates.syncState;
  const { error } = await supabase.from('claims').update(patch).eq('id', id);
  if (error) throw error;
  await syncClaimsToSheets();
}

export async function createCloudExchange(
  claim: Claim,
  newProductSerial: string,
  newProductName: string,
  deliveredToCustomer: boolean,
): Promise<void> {
  if (!supabase) return;
  const { error } = await supabase.from('warranty_exchanges').insert({
    claim_id: claim.id,
    old_product_serial: claim.productSerial,
    new_product_serial: newProductSerial,
    new_product_name: newProductName,
    delivered_to_customer: deliveredToCustomer,
  });
  if (error) throw error;
  await syncClaimsToSheets();
}

export async function syncClaimsToSheets(): Promise<void> {
  const baseUrl = process.env.EXPO_PUBLIC_API_BASE_URL?.trim();
  if (!baseUrl || !supabase) return;

  const response = await fetch(`${baseUrl.replace(/\/$/, '')}/api/sync-claims`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
  });

  if (!response.ok) {
    const payload = await response.text();
    throw new Error(payload || 'Unable to sync claims');
  }
}
