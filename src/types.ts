export type ProductType = 'battery' | 'ups';

export type ClaimStatus =
  | 'with_us'
  | 'gone_for_warranty_claim'
  | 'delivered_to_customer';

export type UserRole = 'admin' | 'staff';

export type SyncState = 'synced' | 'pending' | 'failed' | 'disabled';

export interface AppUser {
  id: string;
  name: string;
  email: string;
  role: UserRole;
}

export interface BatteryDetails {
  voltage: string;
  capacity: string;
  chemistry: string;
  warrantyMonths: string;
}

export interface UpsDetails {
  rating: string;
  batteryCount: string;
  batteryCapacity: string;
  warrantyMonths: string;
  repairPrice?: string;
  sellingPrice?: string;
}

export interface UpsModel {
  id: string;
  model_name: string;
  repair_price: number;
  selling_price: number;
  updated_at?: string;
}

export interface ClaimAttachment {
  id: string;
  uri: string;
  name?: string;
}

export interface Claim {
  id: string;
  caseNumber: string;
  productType: ProductType;
  productSerial: string;
  scanPayload?: string;
  productName: string;
  customerName: string;
  mobileNumber: string;
  slipNumber: string;
  complaint: string;
  status: ClaimStatus;
  cleared: boolean;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
  receivedAt: string;
  deliveredAt?: string;
  reminderDueAt: string;
  reminderEveryDays: number;
  assigneeName?: string;
  previousClaimId?: string;
  replacementSerial?: string;
  replacementProductName?: string;
  battery?: BatteryDetails;
  ups?: UpsDetails;
  attachments?: ClaimAttachment[];
  syncState: SyncState;
}

export interface IntakeDraft {
  productType: ProductType;
  productSerial: string;
  scanPayload: string;
  productName: string;
  customerName: string;
  mobileNumber: string;
  slipNumber: string;
  complaint: string;
  reminderEveryDays: string;
  battery: BatteryDetails;
  ups: UpsDetails;
  attachments: ClaimAttachment[];
}

export const STATUS_LABELS: Record<ClaimStatus, string> = {
  with_us: 'With us',
  gone_for_warranty_claim: 'Warranty claim',
  delivered_to_customer: 'Delivered',
};

export const TYPE_LABELS: Record<ProductType, string> = {
  battery: 'Battery',
  ups: 'UPS',
};
