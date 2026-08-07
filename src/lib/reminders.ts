import { Claim } from '../types';
import { daysBetween } from './serial';

export interface ReminderSummary {
  overdueCount: number;
  upcomingReminders: Claim[];
  averageTurnaroundDays: number;
}

export function getReminderSummary(claims: Claim[]): ReminderSummary {
  const openClaims = claims.filter((claim) => claim.status !== 'delivered_to_customer');
  const overdue = openClaims.filter((claim) => new Date(claim.reminderDueAt).getTime() < Date.now());
  const upcomingReminders = [...openClaims]
    .sort((a, b) => new Date(a.reminderDueAt).getTime() - new Date(b.reminderDueAt).getTime())
    .slice(0, 5);

  const deliveredClaims = claims.filter((claim) => claim.status === 'delivered_to_customer' && claim.deliveredAt);
  const averageTurnaroundDays = deliveredClaims.length
    ? Math.round(
        deliveredClaims.reduce((total, claim) => total + daysBetween(claim.receivedAt, claim.deliveredAt || claim.updatedAt), 0) / deliveredClaims.length,
      )
    : 0;

  return {
    overdueCount: overdue.length,
    upcomingReminders,
    averageTurnaroundDays,
  };
}
