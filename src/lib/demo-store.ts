import AsyncStorage from '@react-native-async-storage/async-storage';

import { sampleClaims } from '../data/sample-data';
import { Claim } from '../types';

export interface ReminderPolicyStorage {
  mode: 'daily' | 'interval' | 'single';
  time: string;
  everyDays: number;
  date: string;
}

const CLAIMS_KEY = 'warrantyflow.demo.claims.v1';
const SETTINGS_KEY = 'warrantyflow.demo.settings.v1';
const ASSIGNEES_KEY = 'warrantyflow.demo.assignees.v1';

export async function loadDemoClaims(): Promise<Claim[]> {
  const stored = await AsyncStorage.getItem(CLAIMS_KEY);
  if (!stored) return sampleClaims;

  try {
    return JSON.parse(stored) as Claim[];
  } catch {
    return sampleClaims;
  }
}

export async function saveDemoClaims(claims: Claim[]): Promise<void> {
  await AsyncStorage.setItem(CLAIMS_KEY, JSON.stringify(claims));
}

export async function resetDemoClaims(): Promise<void> {
  await AsyncStorage.removeItem(CLAIMS_KEY);
}

export async function loadDemoReminderPolicy(): Promise<ReminderPolicyStorage | null> {
  const value = await AsyncStorage.getItem(SETTINGS_KEY);
  if (!value) return null;

  try {
    return JSON.parse(value) as ReminderPolicyStorage;
  } catch {
    return null;
  }
}

export async function saveDemoReminderPolicy(policy: ReminderPolicyStorage): Promise<void> {
  await AsyncStorage.setItem(SETTINGS_KEY, JSON.stringify(policy));
}

export async function loadDemoBatteryAssignees(): Promise<string[]> {
  const value = await AsyncStorage.getItem(ASSIGNEES_KEY);
  if (!value) return [];

  try {
    const parsed = JSON.parse(value) as string[];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export async function saveDemoBatteryAssignees(assignees: string[]): Promise<void> {
  await AsyncStorage.setItem(ASSIGNEES_KEY, JSON.stringify(assignees));
}
