import * as Notifications from 'expo-notifications';
import * as Updates from 'expo-updates';
import { CameraView, useCameraPermissions } from 'expo-camera';
import { useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Image,
  Linking,
  Modal,
  Platform,
  Pressable,
  SafeAreaView,
  ScrollView,
  Share,
  StatusBar,
  StyleSheet,
  Text,
  TextInput,
  KeyboardAvoidingView,
  View,
  useWindowDimensions,
} from 'react-native';

import { sampleClaims } from './src/data/sample-data';
import {
  loadDemoBatteryAssignees,
  loadDemoClaims,
  loadDemoReminderPolicy,
  resetDemoClaims,
  saveDemoBatteryAssignees,
  saveDemoClaims,
  saveDemoReminderPolicy,
} from './src/lib/demo-store';
import {
  addDays,
  daysBetween,
  extractSerial,
  formatDate,
  formatDateTime, 
  isLikelyMobile,
  normaliseMobile,
} from './src/lib/serial';
import { cloudRowToClaim, createCloudClaim, createCloudExchange, loadCloudClaims, patchCloudClaim } from './src/lib/cloud-claims';
import { getReminderSummary } from './src/lib/reminders';
import { isSupabaseConfigured, supabase } from './src/lib/supabase';
import { sendNewClaimNotification } from './src/lib/notifications';
import {
  AppUser,
  BatteryDetails,
  Claim,
  ClaimAttachment,
  ClaimStatus,
  IntakeDraft,
  ProductType,
  STATUS_LABELS,
  SyncState,
  TYPE_LABELS,
  UpsDetails,
  UserRole,
  UpsModel,
} from './src/types';

type Screen = 'dashboard' | 'claims' | 'intake' | 'exchange' | 'settings';
type FilterType = 'all' | ProductType;
export type ReminderMode = 'daily' | 'interval' | 'single';
type NotificationFilter = 'overdue_battery' | { type: 'assignee'; assignee: string } | null;

interface ReminderPolicy {
  mode: ReminderMode;
  time: string;
  everyDays: number;
  date: string;
}

interface ProfileRow {
  id: string;
  email: string;
  full_name: string;
  role: UserRole;
  push_token?: string | null;
}

interface UpsReminderPolicy {
  mode: ReminderMode;
  time: string;
  everyDays: number;
  date: string;
}

const emptyUpsModel = (): UpsModel => ({
  id: '',
  model_name: '',
  repair_price: 0,
  selling_price: 0,
});


const defaultReminderPolicy: ReminderPolicy = {
  mode: 'daily',
  time: '10:00',
  everyDays: 3,
  date: new Date().toISOString().slice(0, 10),
};

const defaultUpsReminderPolicy: UpsReminderPolicy = {
  mode: 'daily',
  time: '10:30',
  everyDays: 1,
  date: new Date().toISOString().slice(0, 10),
};

function normalizeReminderPolicy(value?: Partial<ReminderPolicy> | null): ReminderPolicy {
  const nextMode = value?.mode === 'interval' || value?.mode === 'single' ? value.mode : 'daily';
  const nextTime = value?.time?.trim() || defaultReminderPolicy.time;
  const nextEveryDays = Math.max(1, Math.min(30, Number(value?.everyDays) || defaultReminderPolicy.everyDays));
  const nextDate = value?.date?.trim() || defaultReminderPolicy.date;
  return {
    mode: nextMode,
    time: nextTime,
    everyDays: nextEveryDays,
    date: nextDate,
  };
}

function normalizeUpsReminderPolicy(value?: Partial<UpsReminderPolicy> | null): UpsReminderPolicy {
  const nextMode = value?.mode === 'interval' || value?.mode === 'single' ? value.mode : 'daily';
  const nextTime = value?.time?.trim() || defaultUpsReminderPolicy.time;
  const nextEveryDays = Math.max(1, Math.min(30, Number(value?.everyDays) || defaultUpsReminderPolicy.everyDays));
  const nextDate = value?.date?.trim() || defaultUpsReminderPolicy.date;
  return {
    mode: nextMode,
    time: nextTime,
    everyDays: nextEveryDays,
    date: nextDate,
  };
}

function parseReminderTime(value: string): { hour: number; minute: number } | null {
  const match = value.trim().match(/^(\d{1,2}):(\d{2})$/);
  if (!match) return null;
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (hour < 0 || hour > 23 || minute < 0 || minute > 59) return null;
  return { hour, minute };
}

function buildNextReminderDate(policy: ReminderPolicy | UpsReminderPolicy): Date | null {
  const parsed = parseReminderTime(policy.time);
  if (!parsed) return null;

  const now = new Date();
  if (policy.mode === 'daily') {
    const next = new Date(now);
    next.setHours(parsed.hour, parsed.minute, 0, 0);
    if (next.getTime() <= now.getTime()) {
      next.setDate(next.getDate() + 1);
    }
    return next;
  }

  if (policy.mode === 'interval') {
    const next = new Date(now);
    next.setHours(parsed.hour, parsed.minute, 0, 0);
    next.setDate(next.getDate() + Math.max(1, Math.min(30, policy.everyDays || 1)));
    return next;
  }

  const [year, month, day] = policy.date.split('-').map(Number);
  if (!year || !month || !day) return null;
  const next = new Date(year, month - 1, day, parsed.hour, parsed.minute, 0, 0);
  if (next.getTime() <= now.getTime()) {
    next.setDate(next.getDate() + 1);
  }
  return next;
}

const palette = {
  canvas: '#F4F6F2',
  surface: '#FFFFFF',
  ink: '#17211F',
  muted: '#6C7773',
  line: '#E0E6E0',
  forest: '#174E4C',
  forestDark: '#103C3A',
  emerald: '#087766',
  mint: '#DDF3EB',
  aqua: '#E8F6F2',
  amber: '#A76513',
  amberSoft: '#FFF1D9',
  rose: '#B14A53',
  roseSoft: '#FDE9E9',
  blue: '#3267A8',
  blueSoft: '#E9F0FC',
  white: '#FFFFFF',
};

const defaultUser: AppUser = {
  id: 'demo-admin',
  name: 'Riya Mehta',
  email: 'riya@warrantyflow.demo',
  role: 'admin',
};

const emptyDraft = (): IntakeDraft => ({
  productType: 'battery',
  productSerial: '',
  scanPayload: '',
  productName: '',
  customerName: '',
  mobileNumber: '',
  slipNumber: '',
  complaint: '',
  reminderEveryDays: '3',
  battery: { voltage: '', capacity: '', chemistry: '', warrantyMonths: '' },
  ups: { rating: '', batteryCount: '', batteryCapacity: '', warrantyMonths: '', repairPrice: '', sellingPrice: '' },
  attachments: [],
});

const statusTone: Record<ClaimStatus, 'mint' | 'amber' | 'blue'> = {
  with_us: 'mint',
  gone_for_warranty_claim: 'amber',
  delivered_to_customer: 'blue',
};

const syncTone: Record<SyncState, 'mint' | 'amber' | 'rose' | 'neutral'> = {
  synced: 'mint',
  pending: 'amber',
  failed: 'rose',
  disabled: 'neutral',
};

Notifications.setNotificationHandler({
  handleNotification: async () => ({
    shouldShowAlert: true,
    shouldPlaySound: true,
    shouldSetBadge: true,
    shouldShowBanner: true,
    shouldShowList: true,
  }),
});

export default function App() {
  const { width } = useWindowDimensions();
  const isWide = width >= 920;
  const [ready, setReady] = useState(false);
  const [signedIn, setSignedIn] = useState(false);
  const [user, setUser] = useState<AppUser>(defaultUser);
  const [claims, setClaims] = useState<Claim[]>(sampleClaims);
  const [reminderPolicy, setReminderPolicy] = useState<ReminderPolicy>(defaultReminderPolicy);
  const [upsReminderPolicy, setUpsReminderPolicy] = useState<UpsReminderPolicy>(defaultUpsReminderPolicy);
  const [upsAssignees, setUpsAssignees] = useState<string[]>([]);
  const [batteryAssignees, setBatteryAssignees] = useState<string[]>([]);
const [upsModels, setUpsModels] = useState<UpsModel[]>([]);
  const [teamMembers, setTeamMembers] = useState<AppUser[]>([]);
  const [syncingClaims, setSyncingClaims] = useState(false);
  const [syncingUpsPrices, setSyncingUpsPrices] = useState(false);
  const [syncMessage, setSyncMessage] = useState<string | null>(null);
  const [attachmentCameraVisible, setAttachmentCameraVisible] = useState(false);
  const [attachmentCameraTarget, setAttachmentCameraTarget] = useState<((attachment: ClaimAttachment) => void) | null>(null);
  const [screen, setScreen] = useState<Screen>('dashboard');
  const [selectedClaim, setSelectedClaim] = useState<Claim | null>(null);
  const [scannerVisible, setScannerVisible] = useState(false);
  const [scannerTarget, setScannerTarget] = useState<((payload: string) => void) | null>(null);
  const [notificationFilter, setNotificationFilter] = useState<NotificationFilter>(null);

  const { isUpdatePending, checkError, downloadError, currentlyRunning } = Updates.useUpdates();

  useEffect(() => {
    if (checkError) Alert.alert('Update Check Failed', `An error occurred while checking for updates: ${checkError.message}`);
    if (downloadError) Alert.alert('Update Download Failed', `An error occurred while downloading an update: ${downloadError.message}`);
  }, [checkError, downloadError]);

  useEffect(() => {
    let mounted = true;

    async function hydrate() {
      const [storedClaims, storedReminder, storedAssignees] = await Promise.all([
        loadDemoClaims(),
        loadDemoReminderPolicy(),
        loadDemoBatteryAssignees(),
      ]);
      if (!mounted) return;
      setClaims(storedClaims);
      setReminderPolicy(normalizeReminderPolicy(storedReminder));
      setBatteryAssignees(storedAssignees);

if (supabase) {
        const { data } = await supabase.auth.getSession();
        if (data.session?.user && mounted) {
          const sessionUser = toAppUser(data.session.user.id, data.session.user.email, data.session.user.user_metadata);
          setUser(sessionUser);
          setSignedIn(true);
          void upsertProfile(sessionUser);
          void loadTeamMembers().then((members) => { if (mounted && members.length) setTeamMembers(members); });
          try {
            const cloudClaims = await loadCloudClaims();
            if (cloudClaims && mounted) setClaims(cloudClaims);
          } catch {
            // Local data is retained when the configured backend is temporarily unreachable.
          }
        }
      }
      if (mounted) setReady(true);
    }

    void hydrate();
    return () => {
      mounted = false;
    };
  }, []);

  useEffect(() => {
    if (!ready) return;
    void saveDemoClaims(claims);
  }, [claims, ready]);

  useEffect(() => {
    if (signedIn && supabase) {
      registerForPushNotificationsAsync(user.id);
    }
  }, [signedIn, user.id]);

  useEffect(() => {
    async function loadUpsModels() {
      if (!supabase) return;
      try {
        const { data, error } = await supabase.from('ups_models').select('*').order('model_name', { ascending: true });
        if (error) throw error;
        if (data) setUpsModels(data as UpsModel[]);
      } catch (e) {
        console.error('Failed to load UPS Models', e);
      }
    }

    if (signedIn && user.role === 'admin') {
      void loadUpsModels();
    }
  }, [signedIn, user.role]);

  const saveUpsModel = async (model: UpsModel): Promise<void> => {
    if (!supabase) return;

    const modelToSave = {
      ...model, // if id is empty, it's a new model
      id: model.id || makeUuid(), // Ensure new models get an ID
      repair_price: Number(model.repair_price) || 0,
      selling_price: Number(model.selling_price) || 0,
    };

    const { data, error } = await supabase.from('ups_models').upsert(modelToSave).select();
    if (error) {
      Alert.alert('Error', 'Could not save UPS model.');
      console.error(error);
      return;
    }

    if (data?.[0]) {
      const saved = data[0] as UpsModel;
      setUpsModels((current) => {
        const index = current.findIndex((m) => m.id === saved.id);
        if (index > -1) return [...current.slice(0, index), saved, ...current.slice(index + 1)];
        return [...current, saved];
      });
    }
  };

  const deleteUpsModel = async (modelId: string): Promise<void> => {
    if (!supabase) return;
const { error } = await supabase.from('ups_models').delete().eq('id', modelId);
    if (error) {
      Alert.alert('Error', 'Could not delete UPS model.');
      console.error(error);
      return;
    }
    setUpsModels((current) => current.filter((model) => model.id !== modelId));
  };

  const runSyncClaims = async (): Promise<void> => {
    const cronSecret = process.env.EXPO_PUBLIC_CRON_SECRET || '';
    setSyncingClaims(true);
    setSyncMessage('Syncing claims to Google Sheets...');
    const apiUrl = process.env.EXPO_PUBLIC_API_URL;
    try {
      const response = await fetch(`${apiUrl}/api/sync-claims`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${cronSecret}`,
        },
      });
      const result = await response.json();
      if (!response.ok || !result.ok) {
        throw new Error(result?.error || 'Failed to sync claims');
      }
setSyncMessage(`Claims sync complete: ${result.synced} synced.`);
    } catch (error) {
      console.error(error);
      setSyncMessage('Claims sync failed. Check logs and retry.');
      Alert.alert('Sync failed', String(error));
    } finally {
      setSyncingClaims(false);
      setTimeout(() => setSyncMessage(null), 5000);
    }
  };

  const runSyncUpsPrices = async (): Promise<void> => {
    const cronSecret = process.env.EXPO_PUBLIC_CRON_SECRET || '';
    setSyncingUpsPrices(true);
    setSyncMessage('Syncing UPS prices to Google Sheets...');
    const apiUrl = process.env.EXPO_PUBLIC_API_URL;
    try {
      const response = await fetch(`${apiUrl}/api/sync-ups-prices`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${cronSecret}`,
        },
      });
      const result = await response.json();
      if (!response.ok || !result.ok) {
        throw new Error(result?.error || 'Failed to sync UPS prices');
      }
      setSyncMessage(`UPS prices sync complete: ${result.synced} updated.`);
    } catch (error) {
      console.error(error);
      setSyncMessage('UPS prices sync failed.');
      Alert.alert('Sync failed', String(error));
    } finally {
      setSyncingUpsPrices(false);
      setTimeout(() => setSyncMessage(null), 5000);
    }
  };

  async function registerForPushNotificationsAsync(userId: string) {
    if (!supabase) return;
    let token;
    if (Platform.OS === 'android') {
      await Notifications.setNotificationChannelAsync('default', {
        name: 'default',
        importance: Notifications.AndroidImportance.MAX,
        vibrationPattern: [0, 250, 250, 250],
        lightColor: '#FF231F7C',
      });
    }

    const { status: existingStatus } = await Notifications.getPermissionsAsync();
    let finalStatus = existingStatus;
    if (existingStatus !== 'granted') {
      const { status } = await Notifications.requestPermissionsAsync();
      finalStatus = status;
    }
    if (finalStatus !== 'granted') {
      console.log('Failed to get push token for push notification!');
      return;
    }
    token = (await Notifications.getExpoPushTokenAsync()).data;
    await supabase.from('profiles').update({ push_token: token }).eq('id', userId);
  }

  useEffect(() => {
    const responseSubscription = Notifications.addNotificationResponseReceivedListener((response: Notifications.NotificationResponse) => {
      const payload = response.notification.request.content.data as { screen?: string; filter?: string; assignee?: string } | undefined;
      const nextScreen = payload?.screen;
      const nextFilter = payload?.filter;
      if (nextScreen === 'claims') {
        setScreen('claims');
        if (payload?.assignee) {
          setNotificationFilter({ type: 'assignee', assignee: payload.assignee });
        } else if (nextFilter === 'overdue_battery') {
          setNotificationFilter('overdue_battery');
        } else {
          setNotificationFilter(null);
        }
      }
    });
    return () => {
      responseSubscription.remove();
    };
  }, []);

  const reminderSummary = useMemo(() => getReminderSummary(claims), [claims]);
  const overdueClaims = reminderSummary.upcomingReminders.filter(
    (claim) => claim.status !== 'delivered_to_customer' && new Date(claim.reminderDueAt).getTime() < Date.now(),
  );

  const openScanner = (target: (payload: string) => void) => {
    setScannerTarget(() => target);
    setScannerVisible(true);
  };

  const openAttachmentCamera = (target: (attachment: ClaimAttachment) => void) => {
    setAttachmentCameraTarget(() => target);
    setAttachmentCameraVisible(true);
  };

  const closeAttachmentCamera = () => {
    setAttachmentCameraVisible(false);
    setAttachmentCameraTarget(null);
  };

  const createClaim = (claim: Claim) => {
    const nextClaim = {
      ...claim,
      assigneeName: batteryAssignees[0] || claim.assigneeName,
    };
    setClaims((current) => [nextClaim, ...current]);
    void createCloudClaim(nextClaim).catch(() => {
      // Keep the local representation queued; the server-side outbox can be retried later.
    });
    // Notify other users about the new claim
    void sendNewClaimNotification(nextClaim).catch((error: Error) => {
      console.error('Failed to send new claim notification:', error);
    });
    setScreen('claims');
    setSelectedClaim(nextClaim);
  };

  const updateClaim = (id: string, updates: Partial<Claim>) => {
    const cloudUpdates = { ...updates, createdBy: user.name, updatedAt: new Date().toISOString(), syncState: 'pending' as SyncState };
    setClaims((current) =>
      current.map((claim) =>
        claim.id === id
          ? { ...claim, ...updates, createdBy: user.name, updatedAt: cloudUpdates.updatedAt, syncState: cloudUpdates.syncState }
          : claim,
      ),
    );
    setSelectedClaim((current) =>
      current?.id === id
        ? { ...current, ...cloudUpdates }
        : current,
    );
    void patchCloudClaim(id, { ...updates, createdBy: user.name, updatedAt: cloudUpdates.updatedAt, syncState: cloudUpdates.syncState }).catch(() => {
      // The optimistic UI remains usable when a network connection drops.
    });
  };

  const changeStatus = (claim: Claim, status: ClaimStatus) => {
    const delivered = status === 'delivered_to_customer';
    updateClaim(claim.id, {
      status,
      cleared: delivered,
      deliveredAt: delivered ? new Date().toISOString() : undefined,
      // When a claim is re-opened, its reminder is active again.
      reminderDueAt: delivered ? new Date().toISOString() : addDays(new Date(), 1),
    });
  };

  const completeExchange = (
    claim: Claim,
    replacementSerial: string,
    replacementProductName: string,
    deliveredToCustomer: boolean,
  ) => {
    updateClaim(claim.id, {
      replacementSerial,
      replacementProductName,
      status: deliveredToCustomer ? 'delivered_to_customer' : claim.status,
      cleared: deliveredToCustomer,
      deliveredAt: deliveredToCustomer ? new Date().toISOString() : claim.deliveredAt,
      reminderDueAt: deliveredToCustomer ? new Date().toISOString() : addDays(new Date(), 1),
    });
    void createCloudExchange(claim, replacementSerial, replacementProductName, deliveredToCustomer).catch(() => {
      // The claim patch remains queued if an exchange event cannot be posted immediately.
    });
    setScreen('claims');
    setSelectedClaim(null);
  };

  const handleReminderPolicyChange = (policy: ReminderPolicy) => {
    const nextPolicy = normalizeReminderPolicy(policy);
    setReminderPolicy(nextPolicy);
    void saveDemoReminderPolicy(nextPolicy); // This will be saved with the demo data
    void scheduleReminderPolicy(nextPolicy, upsReminderPolicy);
  };
  
  const handleUpsReminderPolicyChange = (policy: UpsReminderPolicy) => {
    const nextPolicy = normalizeUpsReminderPolicy(policy);
    setUpsReminderPolicy(nextPolicy);
    // TODO: Save to storage if needed
    void scheduleReminderPolicy(reminderPolicy, nextPolicy); // Schedule with the latest policies
  };

  useEffect(() => {
    if (!ready) return;
    void scheduleReminderPolicy(reminderPolicy, upsReminderPolicy);
  }, [ready, reminderPolicy, upsReminderPolicy, claims, batteryAssignees, upsAssignees]);

  const scheduleReminderPolicy = async (batteryPolicy: ReminderPolicy, upsPolicy: UpsReminderPolicy) => {
    await Notifications.cancelAllScheduledNotificationsAsync();

    // Schedule Battery Notifications
    const openBatteryClaimsCount = claims.filter(c => c.productType === 'battery' && c.status !== 'delivered_to_customer').length;
    if (openBatteryClaimsCount > 0 && batteryAssignees.length > 0) {
      const parsed = parseReminderTime(batteryPolicy.time);
      if (parsed) {
        const scheduleSingle = async (trigger: Notifications.NotificationTriggerInput, recipient: string) => {
          await Notifications.scheduleNotificationAsync({
            content: {
              title: 'Battery Follow-up Assigned',
              body: `${recipient}: ${openBatteryClaimsCount} open battery claim(s) need attention.`,
              data: { screen: 'claims', filter: 'overdue_battery', assignee: recipient },
            },
            trigger,
          });
        };
        
        for (const recipient of batteryAssignees) {
          if (batteryPolicy.mode === 'daily') {
            await scheduleSingle({
              hour: parsed.hour,
              minute: parsed.minute,
              repeats: true,
            }, recipient);
          } else {
            // Simplified: schedule for next occurrence for interval/single
            const nextDate = buildNextReminderDate(batteryPolicy);
            if (nextDate) await scheduleSingle(nextDate, recipient);
          }
        }
      }
    }

    // Schedule UPS Notifications
    const openUpsClaims = claims.filter(c => c.productType === 'ups' && c.status !== 'delivered_to_customer');
    if (openUpsClaims.length > 0 && upsAssignees.length > 0) {
      const parsed = parseReminderTime(upsPolicy.time);
      if (parsed) {
        const totalRepair = openUpsClaims.reduce((sum, claim) => sum + Number(claim.ups?.repairPrice || 0), 0);
        const totalSelling = openUpsClaims.reduce((sum, claim) => sum + Number(claim.ups?.sellingPrice || 0), 0);

        const scheduleSingle = async (trigger: Notifications.NotificationTriggerInput, recipient: string) => {
          await Notifications.scheduleNotificationAsync({
            content: {
              title: 'UPS Claim Financials',
              body: `${recipient}: ${openUpsClaims.length} open UPS claims. Repair: ₹${totalRepair.toLocaleString('en-IN')}, Selling: ₹${totalSelling.toLocaleString('en-IN')}.`,
              data: { screen: 'claims', filter: 'open_ups', assignee: recipient },
            },
            trigger,
          });
        };

        for (const recipient of upsAssignees) {
          if (upsPolicy.mode === 'daily') {
            await scheduleSingle({
              hour: parsed.hour,
              minute: parsed.minute,
              repeats: true,
            }, recipient);
          } else {
            // Simplified: schedule for next occurrence for interval/single
            const nextDate = buildNextReminderDate(upsPolicy);
            if (nextDate) await scheduleSingle(nextDate, recipient);
          }
        }
      }
    }
  };

  const checkForUpdates = async () => {
    try {
      const { isAvailable } = await Updates.checkForUpdateAsync();
      if (isAvailable) {
        await Updates.fetchUpdateAsync();
        Alert.alert('Update Found!', 'A new update has been downloaded and will be applied on the next app restart.', [
          { text: 'OK' },
          { text: 'Restart Now', onPress: async () => await Updates.reloadAsync() },
        ]);
      } else {
        Alert.alert('No Updates', 'You are already running the latest version.');
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : 'An unknown error occurred';
      Alert.alert('Update Check Failed', `An error occurred while checking for updates: ${message}`);
      console.error(error);
    }
  };

  const handleUpsAssigneeChange = (name: string) => {
    const isSelected = upsAssignees.includes(name);
    const nextAssignees = isSelected ? upsAssignees.filter((n) => n !== name) : [...upsAssignees, name];
    setUpsAssignees(nextAssignees);
    // TODO: Save to storage if needed
  };

  const handleBatteryAssigneeChange = (name: string) => {
    const isSelected = batteryAssignees.includes(name);
    const nextAssignees = isSelected ? batteryAssignees.filter((n) => n !== name) : [...batteryAssignees, name];
    setBatteryAssignees(nextAssignees);
    void saveDemoBatteryAssignees(nextAssignees);
  };

  if (!ready) {
    return <LoadingScreen />;
  }

if (!signedIn) {
    return <AuthScreen onAuthenticated={(nextUser) => { setUser(nextUser); setSignedIn(true); void upsertProfile(nextUser); void loadTeamMembers().then((members) => { if (members.length) setTeamMembers(members); }); void loadCloudClaims().then((remote) => { if (remote) setClaims(remote); }).catch(() => undefined); }} />;
  }

  const content = (() => {
        switch (screen) {
      case 'dashboard':
        return (
          <DashboardScreen
            claims={claims}
            user={user}
            overdueCount={reminderSummary.overdueCount}
            onNavigate={setScreen}
            onOpenClaim={setSelectedClaim}
          />
        );
      case 'claims':
        return (
          <ClaimsScreen
            claims={claims}
            onOpenClaim={setSelectedClaim}
            onOpenScanner={openScanner}
            initialFilter={notificationFilter}
            onFilterApplied={() => setNotificationFilter(null)}
          />
        );
      case 'intake':
        return (
          <IntakeScreen
            user={user}
            reminderPolicy={reminderPolicy}
            onCreate={createClaim}
            onOpenClaim={setSelectedClaim}
            onOpenScanner={openScanner}
            onOpenAttachmentCamera={openAttachmentCamera}
          />
        );
      case 'exchange':
        return (
          <ExchangeScreen
            claims={claims}
            onOpenScanner={openScanner}
            onComplete={completeExchange}
            onOpenClaim={setSelectedClaim}
          />
        );
      case 'settings':
        return (
<SettingsScreen
            user={user}
            claims={claims}
            reminderPolicy={reminderPolicy}
            upsReminderPolicy={upsReminderPolicy}
            batteryAssignees={batteryAssignees}
            upsAssignees={upsAssignees}
            teamMembers={teamMembers}
            onReminderPolicyChange={handleReminderPolicyChange}
            upsModels={upsModels}
            onSaveUpsModel={saveUpsModel}
            onDeleteUpsModel={deleteUpsModel}
            onUpsReminderPolicyChange={handleUpsReminderPolicyChange}
            syncingClaims={syncingClaims}
            runSyncClaims={runSyncClaims}
            syncingUpsPrices={syncingUpsPrices}
            runSyncUpsPrices={runSyncUpsPrices}
            syncMessage={syncMessage}
            onRoleChange={(role) => setUser((current) => ({ ...current, role }))}
            onResetDemo={async () => {
              await resetDemoClaims();
              setClaims(sampleClaims);
            }}
            onSignOut={async () => {
              if (supabase) await supabase.auth.signOut();
              setSignedIn(false);
              setUser(defaultUser);
              setScreen('dashboard');
            }}
            onBatteryAssigneeChange={handleBatteryAssigneeChange}
            onUpsAssigneeChange={handleUpsAssigneeChange}
            onCheckForUpdates={checkForUpdates}
            currentlyRunning={currentlyRunning}
          />
        );
    }
  })();

  return (
    <SafeAreaView style={styles.appShell}>
      <StatusBar barStyle="dark-content" />
      {isUpdatePending && (
        <View style={styles.updateBanner}>
          <Text style={styles.updateBannerText}>A new update is ready.</Text>
          <Pressable onPress={async () => await Updates.reloadAsync()}>
            <Text style={styles.updateBannerAction}>Restart & Apply</Text>
          </Pressable>
        </View>
      )}

      <View style={[styles.appFrame, isWide && styles.appFrameWide]}>
        {isWide ? (
          <Sidebar
            active={screen}
            user={user}
            onNavigate={setScreen}
            onProfile={() => setScreen('settings')}
          />
        ) : null}

        <View style={styles.contentColumn}>
          {!isWide ? (
            <MobileHeader
              user={user}
              title={screenTitle(screen)}
              onProfile={() => setScreen('settings')}
            />
          ) : null}
          <ScrollView
            contentContainerStyle={[styles.scrollContent, isWide && styles.scrollContentWide]}
            showsVerticalScrollIndicator={false}
            keyboardShouldPersistTaps="handled"
          >
            {content}
          </ScrollView>
          {!isWide ? <BottomNavigation active={screen} onNavigate={setScreen} /> : null}
        </View>
      </View>

      <ClaimDetailModal
        claim={selectedClaim}
        user={user}
        onClose={() => setSelectedClaim(null)}
        onChangeStatus={changeStatus}
        onStartExchange={(claim) => {
          setSelectedClaim(null);
          setScreen('exchange');
        }}
      />

      <ScannerModal
        visible={scannerVisible}
        onClose={() => setScannerVisible(false)}
        onScan={(payload) => {
          scannerTarget?.(payload);
          setScannerVisible(false);
        }}
      />

      <AttachmentCameraModal
        visible={attachmentCameraVisible}
        onClose={closeAttachmentCamera}
        onCapture={(attachment) => {
          attachmentCameraTarget?.(attachment);
          closeAttachmentCamera();
        }}
      />
    </SafeAreaView>
  );
}

function LoadingScreen() {
  return (
    <SafeAreaView style={styles.loadingScreen}>
      <View style={styles.loadingMark}><Text style={styles.loadingMarkText}>W</Text></View>
      <ActivityIndicator color={palette.forest} style={styles.loadingSpinner} />
      <Text style={styles.loadingTitle}>Preparing your workspace</Text>
      <Text style={styles.loadingCopy}>Claims, reminders, and your latest activity are being loaded.</Text>
    </SafeAreaView>
  );
}

function AuthScreen({ onAuthenticated }: { onAuthenticated: (user: AppUser) => void }) {
  const [mode, setMode] = useState<'sign_in' | 'sign_up' | 'forgot_password' | 'verify_otp'>('sign_in');
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [otp, setOtp] = useState('');
  const [password, setPassword] = useState('');
  const [demoRole, setDemoRole] = useState<UserRole>('admin');
  const [selectedRole, setSelectedRole] = useState<UserRole>('staff');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [cooldownUntil, setCooldownUntil] = useState(0); 
  const nameInputRef = useRef<TextInput>(null);
  const emailInputRef = useRef<TextInput | null>(null);
  const passwordInputRef = useRef<TextInput | null>(null);

  const submit = async () => {
    const normalizedEmail = email.trim().toLowerCase();
    const normalizedName = name.trim();
    if (mode === 'sign_in' && (!normalizedEmail || !password.trim())) {
      setMessage('Enter your email and password to continue.');
      return;
    }
    if (busy || cooldownUntil > Date.now()) {
      setMessage('Please wait a moment before trying again.');

      return;
    }

    setMessage('');
    setCooldownUntil(Date.now() + 9000);

    try {
      if (supabase) {
        if (mode === 'sign_in') {
          const { data, error } = await supabase.auth.signInWithPassword({ email: normalizedEmail, password });
          if (error) throw error;
          if (data.user) onAuthenticated(toAppUser(data.user.id, data.user.email, data.user.user_metadata));
        } else if (mode === 'sign_up') {
          const { data, error } = await supabase.auth.signUp({
            email: normalizedEmail,
            password,
            options: { data: { full_name: normalizedName || 'New team member', role: selectedRole } },
          });
          if (error) {
            if (error.message.includes('User already registered')) {
              setMessage('This email is already registered. Please sign in instead.');
              return;
            }
            throw error;
          }
          // If no error, assume OTP was sent and proceed to verification mode.
          setMode('verify_otp');
          setMessage(`An OTP has been sent to ${normalizedEmail}. Please check your inbox.`);
        }
      } else {
        onAuthenticated({
          id: `demo-${Date.now()}`,
          name: normalizedName || (demoRole === 'admin' ? 'Riya Mehta' : 'Aarav Singh'),
          email: normalizedEmail,
          role: demoRole,
        });
      }
    } catch (error) {
      const text = error instanceof Error ? error.message.toLowerCase() : '';
      if (text.includes('rate limit') || text.includes('too many requests') || text.includes('email')) {
        setMessage('Too many signup attempts were made too quickly. Please wait a few minutes or try another email address.');
      } else {
        setMessage(error instanceof Error ? error.message : 'Unable to sign in right now.');
      }
    } finally {
      setBusy(false);
    }
  };

  const sendResetLink = async () => {
    const normalizedEmail = email.trim().toLowerCase();
    if (!normalizedEmail) {
      setMessage('Please enter your email address to receive a reset link.');
      return;
    }
    if (busy || cooldownUntil > Date.now()) {
      setMessage('Please wait a moment before trying again.');
      return;
    }

    setBusy(true);
    setMessage('');
    setCooldownUntil(Date.now() + 9000);

    try {
      if (!supabase) throw new Error('Supabase is not configured.');      const authRedirectUrl = Platform.OS === 'web' ? `${typeof window !== 'undefined' ? window.location.origin : 'http://localhost'}/auth/callback` : 'aecomplaintlogs://auth/callback';
      const { error } = await supabase.auth.resetPasswordForEmail(normalizedEmail, { redirectTo: authRedirectUrl });
      if (error) throw error;
      setMessage('If an account exists for this email, a password reset link has been sent.');
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Unable to send reset link.');
    } finally {
      setBusy(false);
    }
  };

  const resendOtp = async () => {
    const normalizedEmail = email.trim().toLowerCase();
    if (busy || cooldownUntil > Date.now()) {
      setMessage('Please wait a moment before trying again.');
      return;
    }

    setBusy(true);
    setMessage('');
    setCooldownUntil(Date.now() + 30000); // 30-second cooldown for resend

    try {
      if (!supabase) throw new Error('Supabase is not configured.');
      const { error } = await supabase.auth.resend({ type: 'signup', email: normalizedEmail });
      if (error) throw error;
      setMessage('A new OTP has been sent to your email.');
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Unable to resend OTP.');
    } finally {
      setBusy(false);
    }
  };

  const verifyOtp = async () => {
    const normalizedEmail = email.trim().toLowerCase();
    if (!otp.trim()) {
      setMessage('Please enter the OTP from your email.');
      return;
    }
    setBusy(true);
    setMessage('');
    try {
      if (!supabase) throw new Error('Supabase not configured.');
      const { data, error } = await supabase.auth.verifyOtp({ email: normalizedEmail, token: otp, type: 'signup' });
      if (error) throw error;
      if (data.session?.user) {
        onAuthenticated(toAppUser(data.session.user.id, data.session.user.email, data.session.user.user_metadata));
      } else {
        setMessage('Could not verify OTP. Please try signing up again.');
        setMode('sign_up');
      }
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Unable to verify OTP.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <SafeAreaView style={styles.authScreenShell}>
      <StatusBar barStyle="dark-content" />
      <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : 'height'} style={styles.authScreenKeyboardAvoiding}>
        <ScrollView contentContainerStyle={styles.authScreenScroll} keyboardShouldPersistTaps="handled"> 
          <View style={styles.authScreenHeader}> 
            <Image source={require('./assets/icon.png')} style={styles.brandMark} />
            <Text style={styles.authTitle}>WarrantyFlow</Text>
            <Text style={styles.authCopy}>
            A focused workspace for your team, your customers, and every warranty hand-off.
          </Text>
          <View style={styles.authFeatureList}>
            <FeatureDot text="Scan, search, and create claims in seconds" /> 
            <FeatureDot text="Keep exchange history and accountability in one place" /> 
            <FeatureDot text="Sync approved records into separate Sheets automatically" />
          </View>
          </View>
          <View style={styles.authFormContainer}>
            <Text style={styles.authCardTitle}>{ 
              mode === 'sign_in' ? 'Welcome back'
              : mode === 'sign_up' ? 'Create your account'
              : mode === 'forgot_password' ? 'Reset your password' 
              : 'Verify your email'
            }</Text>
            <Text style={styles.authCardCopy}>
              {mode === 'verify_otp' ? `An OTP has been sent to ${email}. Please check your inbox.` : isSupabaseConfigured
                ? 'Use your secure team account to continue.'
                : 'Demo mode is ready while you connect Supabase.'}
            </Text>
 
            {mode === 'verify_otp' ? (
              <>
                <Field
                  label="One-Time Password"
                  value={otp}
                  onChangeText={setOtp}
                  placeholder="6-digit code from email"
                  keyboardType="numeric"
                  returnKeyType="done"
                  onSubmitEditing={() => void verifyOtp()}
                />
              </>
            ) : (
              <> 
                {mode !== 'forgot_password' && (
                  <View style={styles.segmented}>
                    <SegmentButton active={mode === 'sign_in'} label="Sign in" onPress={() => setMode('sign_in')} />
                    <SegmentButton active={mode === 'sign_up'} label="Sign up" onPress={() => setMode('sign_up')} />
                  </View>
                )}

                <View style={styles.authFieldGroup}>
                  {mode === 'forgot_password' ? (
                    <Field label="Work email" value={email} onChangeText={setEmail} placeholder="you@business.com" keyboardType="email-address" inputRef={emailInputRef} returnKeyType="done" onSubmitEditing={() => void sendResetLink()} autoCapitalize="none" autoComplete="email" />
                  ) : null}

                  {mode !== 'forgot_password' && (
                    <>
                      {mode === 'sign_up' ? (
                        <Field
                          label="Your name"
                          value={name}
                          onChangeText={setName}
                          placeholder="e.g. Riya Mehta"
                          inputRef={nameInputRef}
                          returnKeyType="next"
                          onSubmitEditing={() => emailInputRef.current?.focus()}
                          autoCapitalize="words"
                        />
                      ) : null}
                      <Field
                        label="Work email"
                        value={email}
                        onChangeText={setEmail}
                        placeholder="you@business.com"
                        keyboardType="email-address"
                        inputRef={emailInputRef}
                        returnKeyType="next"
                        onSubmitEditing={() => passwordInputRef.current?.focus()}
                        autoCapitalize="none"
                        autoComplete="email"
                      />
                      <Field
                        label="Password"
                        value={password}
                        onChangeText={setPassword}
                        placeholder="Your password"
                        secureTextEntry
                        inputRef={passwordInputRef}
                        returnKeyType="done"
                        onSubmitEditing={() => void submit()}
                        autoComplete="password"
                      />
                    </>
                  )}
                </View>
              </>
            )}
 
            {(mode === 'sign_up' || !isSupabaseConfigured) ? (
              <View style={styles.demoRoleBox}>
                <Text style={styles.smallLabel}>{isSupabaseConfigured ? 'TEAM ROLE' : 'DEMO ACCESS LEVEL'}</Text>
                <View style={styles.roleRow}>
                  <RoleChoice role="staff" active={isSupabaseConfigured ? selectedRole === 'staff' : demoRole === 'staff'} onPress={() => isSupabaseConfigured ? setSelectedRole('staff') : setDemoRole('staff')} /> 
                  <RoleChoice role="admin" active={isSupabaseConfigured ? selectedRole === 'admin' : demoRole === 'admin'} onPress={() => isSupabaseConfigured ? setSelectedRole('admin') : setDemoRole('admin')} />
                </View>
                {isSupabaseConfigured ? <Text style={styles.helperText}>Choose Admin to unlock the dashboard and settings experience for your team.</Text> : null}
              </View>
            ) : null}

            {message ? <Text style={styles.formMessage}>{message}</Text> : null}
            <PrimaryButton 
              label={busy ? 'Please wait…' : mode === 'verify_otp' ? 'Verify & Sign In' : mode === 'forgot_password' ? 'Send reset link' : mode === 'sign_in' ? 'Sign in' : 'Create account'}
              onPress={() => mode === 'verify_otp' ? void verifyOtp() : mode === 'forgot_password' ? void sendResetLink() : void submit()}
              
              disabled={busy}
              fullWidth
            />
            {mode === 'verify_otp' && <GhostButton label="Resend OTP" onPress={() => void resendOtp()} fullWidth />}
            {mode === 'verify_otp' && <GhostButton label="‹ Back to sign up" onPress={() => setMode('sign_up')} fullWidth />}
            {mode === 'sign_in' && <GhostButton label="Forgot your password?" onPress={() => setMode('forgot_password')} fullWidth />}
            {mode === 'forgot_password' ? <GhostButton label="‹ Back to sign in" onPress={() => setMode('sign_in')} fullWidth /> : null} 
            {!isSupabaseConfigured ? (
              <Text style={styles.demoHint}>Demo data stays on this device until you connect Supabase.</Text>
            ) : null}
          </View>
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

function Sidebar({
  active,
  user,
  onNavigate,
  onProfile,
}: {
  active: Screen;
  user: AppUser;
  onNavigate: (screen: Screen) => void;
  onProfile: () => void;
}) {
  const items: Array<{ id: Screen; icon: string; label: string; admin?: boolean }> = [
    { id: 'dashboard', icon: '⌂', label: user.role === 'admin' ? 'Overview' : 'My work' },
    { id: 'claims', icon: '◈', label: 'All claims' },
    { id: 'intake', icon: '+', label: 'New complaint' },
    { id: 'exchange', icon: '↔', label: 'Warranty exchange' },
    { id: 'settings', icon: '⋯', label: 'Admin settings', admin: true },
  ];

  return (
    <View style={styles.sidebar}>
      <View style={styles.sidebarBrand}>
        <Image source={require('./assets/icon.png')} style={styles.sidebarMark} />
        <View><Text style={styles.sidebarBrandName}>AE Complaint Logs</Text><Text style={styles.sidebarBrandSub}>Claim desk</Text></View> 
      </View>
      <View style={styles.sidebarNav}>
        {items.filter((item) => !item.admin || user.role === 'admin').map((item) => (
          <Pressable
            key={item.id}
            onPress={() => onNavigate(item.id as Screen)}
            style={({ pressed }) => [styles.sidebarItem, active === item.id && styles.sidebarItemActive, pressed && styles.pressed]}
          >
            <Text style={[styles.sidebarIcon, active === item.id && styles.sidebarIconActive]}>{item.icon}</Text>
            <Text style={[styles.sidebarItemText, active === item.id && styles.sidebarItemTextActive]}>{item.label}</Text>
          </Pressable>
        ))}
      </View>
      <Pressable onPress={onProfile} style={({ pressed }: { pressed: boolean }) => [styles.sidebarUser, pressed && styles.pressed]}>
        <Avatar name={user.name} />
        <View style={styles.sidebarUserCopy}><Text style={styles.sidebarUserName}>{user.name}</Text><Text style={styles.sidebarUserRole}>{user.role === 'admin' ? 'Administrator' : 'Staff member'}</Text></View>
        <Text style={styles.sidebarChevron}>›</Text>
      </Pressable>
    </View>
  );
}

function MobileHeader({ user, title, onProfile }: { user: AppUser; title: string; onProfile: () => void }) {
  return (
    <View style={styles.mobileHeader}>
      <View style={styles.mobileBrandRow}>
        <Image source={require('./assets/icon.png')} style={styles.mobileMark} />
        <View><Text style={styles.mobileHeaderTitle}>{title}</Text><Text style={styles.mobileHeaderSub}>AE Complaint Logs</Text></View> 
      </View>
      <Pressable onPress={onProfile} style={({ pressed }: { pressed: boolean }) => [pressed && styles.pressed]}><Avatar name={user.name} small /></Pressable>
    </View>
  );
}

function BottomNavigation({ active, onNavigate }: { active: Screen; onNavigate: (screen: Screen) => void }) {
  const items: Array<{ id: Screen; icon: string; label: string }> = [
    { id: 'dashboard', icon: '⌂', label: 'Home' },
    { id: 'claims', icon: '◈', label: 'Claims' },
    { id: 'intake', icon: '+', label: 'Add' },
    { id: 'exchange', icon: '↔', label: 'Exchange' },
    { id: 'settings', icon: '⋯', label: 'More' },
  ];
  return (
    <View style={styles.bottomNav}>
      {items.map((item) => (
        <Pressable key={item.id} onPress={() => onNavigate(item.id)} style={styles.bottomNavItem}>
          <View style={[styles.bottomNavIconWrap, active === item.id && styles.bottomNavIconWrapActive]}><Text style={[styles.bottomNavIcon, active === item.id && styles.bottomNavIconActive]}>{item.icon}</Text></View>
          <Text style={[styles.bottomNavLabel, active === item.id && styles.bottomNavLabelActive]}>{item.label}</Text>
        </Pressable>
      ))}
    </View>
  );
}

function DashboardScreen({
  claims,
  user,
  overdueCount,
  onNavigate,
  onOpenClaim,
}: {
  claims: Claim[];
  user: AppUser;
  overdueCount: number;
  onNavigate: (screen: Screen) => void;
  onOpenClaim: (claim: Claim) => void;
}) {
  const reminderSummary = getReminderSummary(claims);
  const openClaims = claims.filter((claim) => claim.status !== 'delivered_to_customer');
  const withUs = claims.filter((claim) => claim.status === 'with_us').length;
  const warranty = claims.filter((claim) => claim.status === 'gone_for_warranty_claim').length;
  const delivered = claims.filter((claim) => claim.status === 'delivered_to_customer');
  const turnaround = reminderSummary.averageTurnaroundDays;
  const recent = [...claims].sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime()).slice(0, 5);
  const typeCount = { battery: claims.filter((claim) => claim.productType === 'battery').length, ups: claims.filter((claim) => claim.productType === 'ups').length };
  const total = Math.max(1, claims.length);

  return (
    <View>
      <View style={styles.desktopPageHeader}>
        <View><Text style={styles.eyebrow}>TODAY’S CLAIM DESK</Text><Text style={styles.pageTitle}>Good morning, {user.name.split(' ')[0]}.</Text><Text style={styles.pageSubtitle}>Here’s a calm view of every item moving through your warranty desk.</Text></View>
        <View style={styles.headerActions}><GhostButton label="View all claims" onPress={() => onNavigate('claims')} /><PrimaryButton label="+ New complaint" onPress={() => onNavigate('intake')} /></View>
      </View>

      <View style={styles.metricGrid}>
        <MetricCard label="Open claims" value={String(openClaims.length)} detail={`${withUs} with you now`} tone="forest" icon="◈" />
        <MetricCard label="At warranty" value={String(warranty)} detail="Awaiting partner update" tone="amber" icon="↗" />
        <MetricCard label="Due follow-ups" value={String(overdueCount)} detail={overdueCount ? 'Needs attention today' : 'Everything is on track'} tone={overdueCount ? 'rose' : 'mint'} icon="◷" />
        <MetricCard label="Avg. turnaround" value={`${turnaround || '—'}d`} detail="Delivered claims" tone="blue" icon="↺" />
      </View>

      <View style={styles.dashboardRow}>
        <View style={[styles.surface, styles.activitySurface]}>
          <View style={styles.surfaceHeader}><View><Text style={styles.sectionTitle}>Keep things moving</Text><Text style={styles.sectionCopy}>The fastest path for today’s desk work.</Text></View><View style={styles.liveDot}><View style={styles.dot} /><Text style={styles.liveText}>LIVE</Text></View></View>
          <View style={styles.quickActions}>
            <QuickAction icon="+" title="New complaint" copy="Scan or enter a product" onPress={() => onNavigate('intake')} />
            <QuickAction icon="⌕" title="Find a claim" copy="Search serial or QR code" onPress={() => onNavigate('claims')} />
            <QuickAction icon="↔" title="Exchange item" copy="Link old & new serials" onPress={() => onNavigate('exchange')} />
          </View>
          {overdueCount ? <View style={styles.attentionStrip}><Text style={styles.attentionIcon}>!</Text><View style={styles.attentionCopy}><Text style={styles.attentionTitle}>{overdueCount} follow-up{overdueCount === 1 ? '' : 's'} overdue</Text><Text style={styles.attentionText}>Open these cases and record the latest warranty update.</Text></View><Pressable onPress={() => onNavigate('claims')}><Text style={styles.attentionAction}>Review ›</Text></Pressable></View> : null}
        </View>

        <View style={[styles.surface, styles.pipelineSurface]}>
          <View style={styles.surfaceHeader}><View><Text style={styles.sectionTitle}>Claim mix</Text><Text style={styles.sectionCopy}>Current workload by product</Text></View><Text style={styles.miniNumber}>{claims.length} total</Text></View>
          <MixBar label="Battery" value={typeCount.battery} total={total} color={palette.emerald} />
          <MixBar label="UPS" value={typeCount.ups} total={total} color={palette.blue} />
          <View style={styles.statusMiniGrid}><MiniStatus label="With us" value={withUs} tone="mint" /><MiniStatus label="At warranty" value={warranty} tone="amber" /><MiniStatus label="Delivered" value={delivered.length} tone="blue" /></View>
        </View>
      </View>

      <View style={[styles.surface, styles.recentSurface]}>
        <View style={styles.surfaceHeader}><View><Text style={styles.sectionTitle}>Recent claim activity</Text><Text style={styles.sectionCopy}>Every status change stays tied to the team member who made it.</Text></View><Pressable onPress={() => onNavigate('claims')}><Text style={styles.textLink}>See all claims ›</Text></Pressable></View>
        <View style={styles.tableHeader}><Text style={[styles.tableHeaderText, styles.tableClaim]}>CLAIM</Text><Text style={[styles.tableHeaderText, styles.tableCustomer]}>CUSTOMER</Text><Text style={[styles.tableHeaderText, styles.tableStatus]}>STATUS</Text><Text style={[styles.tableHeaderText, styles.tableAge]}>AGE</Text></View>
        {recent.map((claim) => <ClaimTableRow key={claim.id} claim={claim} onPress={() => onOpenClaim(claim)} />)}
      </View>

      {user.role === 'admin' ? <View style={styles.syncCallout}><View style={styles.syncCalloutIcon}><Text style={styles.syncCalloutIconText}>↗</Text></View><View style={styles.syncCalloutBody}><Text style={styles.syncCalloutTitle}>Google Sheets sync stays in the background</Text><Text style={styles.syncCalloutCopy}>Battery and UPS claims route to their own sheets. {claims.filter((claim) => claim.syncState === 'pending').length} record(s) are waiting to sync.</Text></View><Pressable onPress={() => onNavigate('settings')}><Text style={styles.textLink}>Review setup ›</Text></Pressable></View> : null}
    </View>
  );
}

function ClaimsScreen({
  claims,
  onOpenClaim,
  onOpenScanner,
  initialFilter,
  onFilterApplied,
}: {
  claims: Claim[];
  onOpenClaim: (claim: Claim) => void;
  onOpenScanner: (target: (payload: string) => void) => void;
  initialFilter: NotificationFilter;
  onFilterApplied: () => void;
}) {
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState<FilterType>('all');
  const normalizedQuery = extractSerial(query).toLowerCase();

  useEffect(() => {
    if (initialFilter === 'overdue_battery') {
      setFilter('battery');
    }
    if (initialFilter && typeof initialFilter === 'object' && initialFilter.type === 'assignee') {
      setFilter('all');
    }
    onFilterApplied();
  }, [initialFilter]);

  const filtered = claims.filter((claim) => {
    const matchesAssignee = !initialFilter || typeof initialFilter !== 'object' || claim.assigneeName === initialFilter.assignee;
    const matchesOverdue = initialFilter !== 'overdue_battery' || (new Date(claim.reminderDueAt).getTime() < Date.now() && claim.status !== 'delivered_to_customer');
    const matchesType = (filter === 'all' || claim.productType === filter) && matchesAssignee && matchesOverdue;
    const haystack = `${claim.productSerial} ${claim.caseNumber} ${claim.customerName} ${claim.mobileNumber} ${claim.slipNumber} ${claim.productName}`.toLowerCase();
    return matchesType && (!normalizedQuery || haystack.includes(normalizedQuery) || haystack.includes(query.toLowerCase()));
  });

  const scanSearch = (payload: string) => setQuery(extractSerial(payload));

  return (
    <View>
      <ScreenHeading eyebrow="CLAIM REGISTER" title="Find exactly what you need." copy="Search a serial, scan a QR code, or browse every claim your team has recorded." />
      <View style={styles.claimSearchSurface}>
        <View style={styles.searchField}><Text style={styles.searchIcon}>⌕</Text><TextInput value={query} onChangeText={setQuery} placeholder="Search serial, customer, mobile, or slip number" placeholderTextColor={palette.muted} style={styles.searchInput} /><Pressable onPress={() => onOpenScanner(scanSearch)} style={styles.scanInlineButton}><Text style={styles.scanInlineIcon}>▣</Text><Text style={styles.scanInlineText}>Scan</Text></Pressable></View>
        <View style={styles.filterRow}><FilterChip label="All claims" active={filter === 'all'} onPress={() => setFilter('all')} /><FilterChip label="Battery" active={filter === 'battery'} onPress={() => setFilter('battery')} /><FilterChip label="UPS" active={filter === 'ups'} onPress={() => setFilter('ups')} /><Text style={styles.resultCount}>{filtered.length} result{filtered.length === 1 ? '' : 's'}</Text></View>
      </View>
      <View style={styles.claimList}>
        {filtered.length ? filtered.map((claim) => <ClaimListCard key={claim.id} claim={claim} onPress={() => onOpenClaim(claim)} />) : <EmptyState title="No claims match that search" copy="Try another serial number, customer, or scan a product label." />}
      </View>
    </View>
  );
}

function IntakeScreen({
  user,
  reminderPolicy,
  onCreate,
  onOpenClaim,
  onOpenScanner,
  onOpenAttachmentCamera,
}: {
  user: AppUser;
  reminderPolicy: ReminderPolicy;
  onCreate: (claim: Claim) => void;
  onOpenClaim: (claim: Claim) => void;
  onOpenScanner: (target: (payload: string) => void) => void;
  onOpenAttachmentCamera: (target: (attachment: ClaimAttachment) => void) => void;
}) {
  const [draft, setDraft] = useState<IntakeDraft>(() => emptyDraft());
  const [duplicate, setDuplicate] = useState<Claim | null>(null); // This state is not used, consider removing
  const [duplicateVisible, setDuplicateVisible] = useState(false);
  const [repeatApproved, setRepeatApproved] = useState(false);
  const [formMessage, setFormMessage] = useState('');
  const [attachments, setAttachments] = useState<ClaimAttachment[]>([]);

  useEffect(() => {
    setDraft(d => ({ ...d, attachments }));
  }, [attachments]);

  const applyScan = (payload: string) => {
    setDraft((current) => ({ ...current, scanPayload: payload, productSerial: extractSerial(payload) }));
    setDuplicate(null);
    setRepeatApproved(false);
  };

  const checkDuplicate = async (): Promise<Claim | null> => {
    const serial = extractSerial(draft.productSerial || draft.scanPayload);
    if (!serial) {
      setFormMessage('Scan or enter the product serial before checking for an earlier claim.');
      return null;
    }
    if (!supabase) {
      setFormMessage('Supabase is not configured, so duplicate checking is unavailable right now.');
      return null;
    }
    setDraft((current) => ({ ...current, productSerial: serial }));
    const { data } = await supabase.from('claims').select('*').eq('product_serial', serial).order('created_at', { ascending: false }).limit(1);
    const found = data?.[0] ? cloudRowToClaim(data[0]) : null;
    setDuplicate(found);
    if (found) {
      setDuplicateVisible(true);
    } else {
      setFormMessage('No earlier claim found. You can continue with a new complaint.');
    }
    return found;
  };

  const save = () => {
    const serial = extractSerial(draft.productSerial || draft.scanPayload);
    const required = [serial, draft.productName.trim(), draft.customerName.trim(), draft.mobileNumber.trim(), draft.slipNumber.trim()];
    if (required.some((value) => !value)) {
      setFormMessage('Please complete the serial, product, customer, mobile number, and slip number.');
      return;
    }
    if (!isLikelyMobile(draft.mobileNumber)) {
      setFormMessage('Enter a valid 10-digit mobile number.');
      return;
    }
    if (duplicate && !repeatApproved) {
      setDuplicateVisible(true);
      return;
    }

    const now = new Date();
    // This is a simplified version for demo. A real app would get this from the backend.
    const caseNumber = nextCaseNumber(draft.productType);
    const normalizedPolicy = normalizeReminderPolicy(reminderPolicy);
    const nextReminderDate = buildNextReminderDate(normalizedPolicy) || addDays(now, normalizedPolicy.mode === 'interval' ? normalizedPolicy.everyDays : 1);
    const reminderEveryDays = normalizedPolicy.mode === 'interval' ? Math.max(1, normalizedPolicy.everyDays) : 1;
    const reminderDueAt = nextReminderDate instanceof Date ? nextReminderDate : new Date(nextReminderDate);
    const claim: Claim = {
      id: makeUuid(),
      caseNumber,
      productType: draft.productType,
      productSerial: serial,
      scanPayload: draft.scanPayload || undefined,
      productName: draft.productName.trim(),
      customerName: draft.customerName.trim(),
      mobileNumber: normaliseMobile(draft.mobileNumber),
      slipNumber: draft.slipNumber.trim(),
      complaint: draft.complaint.trim(),
      status: 'with_us',
      cleared: false,
      createdBy: user.id,
      createdAt: now.toISOString(),
      updatedAt: now.toISOString(),
      receivedAt: now.toISOString(),
      reminderDueAt: reminderDueAt.toISOString(),
      reminderEveryDays,
      previousClaimId: duplicate?.id,
      battery: draft.productType === 'battery' ? draft.battery : undefined,
      ups: draft.productType === 'ups' ? draft.ups : undefined,
      syncState: isSupabaseConfigured ? 'pending' : 'disabled',
      attachments: attachments.length > 0 ? attachments : undefined,
    };
    onCreate(claim);
  };

  const updateBattery = (key: keyof BatteryDetails, value: string) => setDraft((current) => ({ ...current, battery: { ...current.battery, [key]: value } }));
  const updateUps = (key: keyof UpsDetails, value: string) => setDraft((current) => ({ ...current, ups: { ...current.ups, [key]: value } as UpsDetails }));

  return (
    <View>
      <ScreenHeading eyebrow="NEW COMPLAINT" title="Start with the product." copy="Scan its QR code, paste the identifier, or type the serial number. We’ll protect the history for you." />
      <View style={styles.intakeLayout}>
        <View style={styles.intakeSteps}>
          <StepRail index="01" title="Identify" active /><StepRail index="02" title="Customer" /><StepRail index="03" title="Details" />
        </View>
        <View style={styles.intakeContent}>
          <View style={styles.surface}>
            <View style={styles.intakeSectionHeader}><View><Text style={styles.intakeSectionTitle}>1. Identify the product</Text><Text style={styles.sectionCopy}>Battery and UPS entries stay deliberately separate.</Text></View><Badge label="Required" tone="neutral" /></View>
            <View style={styles.productToggle}><ProductTypeButton type="battery" active={draft.productType === 'battery'} onPress={() => setDraft((current) => ({ ...current, productType: 'battery' }))} /><ProductTypeButton type="ups" active={draft.productType === 'ups'} onPress={() => setDraft((current) => ({ ...current, productType: 'ups' }))} /></View>
            <View style={styles.scanArea}><View style={styles.scanOrb}><Text style={styles.scanOrbIcon}>▣</Text></View><View style={styles.scanAreaCopy}><Text style={styles.scanAreaTitle}>Scan QR code or label</Text><Text style={styles.scanAreaText}>We keep the raw QR value and safely extract the serial—links are never opened.</Text></View><PrimaryButton label="Open scanner" onPress={() => onOpenScanner(applyScan)} compact /></View>
            <View style={styles.orDivider}><View style={styles.divider} /><Text style={styles.orText}>OR ENTER MANUALLY</Text><View style={styles.divider} /></View>
            <View style={styles.twoFieldGrid}><Field label="Product serial number" value={draft.productSerial} onChangeText={(value) => { setDraft((current) => ({ ...current, productSerial: value })); setDuplicate(null); setRepeatApproved(false); }} placeholder="e.g. EXD-12V-88291" autoCapitalize="characters" /><Field label="QR code or product URL (optional)" value={draft.scanPayload} onChangeText={(value) => setDraft((current) => ({ ...current, scanPayload: value }))} placeholder="Paste QR content or URL" /></View>
            <View style={styles.duplicateCheckRow}><Text style={styles.duplicateCheckText}>Before we create a claim, we check whether this serial was logged already.</Text><GhostButton label="Check history" onPress={() => void checkDuplicate()} compact /></View>
          </View>

          <View style={[styles.surface, styles.intakeSurfaceSpacing]}>
            <View style={styles.intakeSectionHeader}><View><Text style={styles.intakeSectionTitle}>2. Customer & receipt</Text><Text style={styles.sectionCopy}>These details appear in the Google Sheets record too.</Text></View></View>
            <View style={styles.twoFieldGrid}><Field label="Customer name" value={draft.customerName} onChangeText={(value) => setDraft((current) => ({ ...current, customerName: value }))} placeholder="Full name" /><Field label="Mobile number" value={draft.mobileNumber} onChangeText={(value) => setDraft((current) => ({ ...current, mobileNumber: value }))} placeholder="10-digit mobile number" keyboardType="phone-pad" /></View>
            <View style={styles.twoFieldGrid}><Field label="Slip number" value={draft.slipNumber} onChangeText={(value) => setDraft((current) => ({ ...current, slipNumber: value }))} placeholder="e.g. SLP-2246" autoCapitalize="characters" /><Field label="Product name" value={draft.productName} onChangeText={(value) => setDraft((current) => ({ ...current, productName: value }))} placeholder={draft.productType === 'battery' ? 'e.g. Exide Xpress XP800' : 'e.g. Microtek EB 1100'} /></View>
          </View>

          <View style={[styles.surface, styles.intakeSurfaceSpacing]}>
            <View style={styles.intakeSectionHeader}><View><Text style={styles.intakeSectionTitle}>3. Product details</Text><Text style={styles.sectionCopy}>Only the fields that matter for this product type are shown.</Text></View><Badge label={TYPE_LABELS[draft.productType]} tone={draft.productType === 'battery' ? 'mint' : 'blue'} /></View>
            {draft.productType === 'battery' ? <View style={styles.detailsGrid}><Field label="Voltage" value={draft.battery.voltage} onChangeText={(value) => updateBattery('voltage', value)} placeholder="e.g. 12V" /><Field label="Capacity" value={draft.battery.capacity} onChangeText={(value) => updateBattery('capacity', value)} placeholder="e.g. 150Ah" /><Field label="Chemistry / type" value={draft.battery.chemistry} onChangeText={(value) => updateBattery('chemistry', value)} placeholder="e.g. Tall tubular" /><Field label="Warranty (months)" value={draft.battery.warrantyMonths} onChangeText={(value) => updateBattery('warrantyMonths', value)} placeholder="e.g. 36" keyboardType="numeric" /></View> : <View style={styles.detailsGrid}><Field label="VA rating" value={draft.ups.rating} onChangeText={(value) => updateUps('rating', value)} placeholder="e.g. 1100VA" /><Field label="Battery count" value={draft.ups.batteryCount} onChangeText={(value) => updateUps('batteryCount', value)} placeholder="e.g. 1" keyboardType="numeric" /><Field label="Battery capacity" value={draft.ups.batteryCapacity} onChangeText={(value) => updateUps('batteryCapacity', value)} placeholder="e.g. 150Ah" /><Field label="Warranty (months)" value={draft.ups.warrantyMonths} onChangeText={(value) => updateUps('warrantyMonths', value)} placeholder="e.g. 24" keyboardType="numeric" /></View>}
            {draft.productType === 'ups' && (
              <View style={[styles.twoFieldGrid, { marginTop: 12 }]}>
                <Field
                  label="Repair Price"
                  value={draft.ups.repairPrice || ''}
                  onChangeText={(value) => updateUps('repairPrice', value)}
                  placeholder="e.g. 500"
                  keyboardType="numeric"
                />
                <Field
                  label="Selling Price to Customer"
                  value={draft.ups.sellingPrice || ''}
                  onChangeText={(value) => updateUps('sellingPrice', value)}
                  placeholder="e.g. 750"
                  keyboardType="numeric"
                />
              </View>
            )}
            <Field label="Complaint notes" value={draft.complaint} onChangeText={(value) => setDraft((current) => ({ ...current, complaint: value }))} placeholder="What did the customer report?" multiline />
          </View>

          <View style={styles.attachmentsSection}>
            <View style={styles.attachmentsHeader}><Text style={styles.sectionTitle}>Attachments</Text><Text style={styles.sectionCopy}>Capture images for the product, receipt, or damage notes.</Text></View>
            {attachments.length ? (
              <View style={styles.attachmentsList}>{draft.attachments.map((attachment) => (
                <View key={attachment.id} style={styles.attachmentRow}>
                  <Text style={styles.attachmentLabel}>{attachment.name || 'Photo attachment'}</Text>
                  <GhostButton label="Remove" onPress={() => setAttachments((current) => current.filter((item) => item.id !== attachment.id))} compact />
                </View>
              ))}</View>
            ) : (
              <Text style={styles.sectionCopy}>No attachments added yet.</Text>
            )}
            <PrimaryButton label="Capture attachment" onPress={() => onOpenAttachmentCamera((attachment) => setAttachments((current) => [...current, attachment]))} compact />
          </View>
          {formMessage ? <View style={styles.formNotice}><Text style={styles.formNoticeIcon}>i</Text><Text style={styles.formNoticeText}>{formMessage}</Text></View> : null}
          <View style={styles.intakeSubmit}><View><Text style={styles.submitTitle}>Ready to record this claim?</Text><Text style={styles.submitCopy}>It starts as “With us” and is queued for syncing after your backend is connected.</Text></View><PrimaryButton label="Create complaint" onPress={save} /></View>
        </View>
      </View>

      <DuplicateModal
        claim={duplicate}
        user={user}
        visible={duplicateVisible}
        onClose={() => setDuplicateVisible(false)}
        onOpenExisting={() => { if (duplicate) onOpenClaim(duplicate); setDuplicateVisible(false); }}
        onCreateRepeat={() => { setRepeatApproved(true); setDuplicateVisible(false); setFormMessage('Confirmed: this is a new complaint linked to the previous history.'); }}
      />
    </View>
  );
}

function ExchangeScreen({
  claims,
  onOpenScanner,
  onComplete,
  onOpenClaim,
}: {
  claims: Claim[];
  onOpenScanner: (target: (payload: string) => void) => void;
  onComplete: (claim: Claim, serial: string, productName: string, deliveredToCustomer: boolean) => void;
  onOpenClaim: (claim: Claim) => void;
}) {
  const [oldSerial, setOldSerial] = useState('');
  const [claim, setClaim] = useState<Claim | null>(null);
  const [newSerial, setNewSerial] = useState('');
  const [newProductName, setNewProductName] = useState('');
  const [delivered, setDelivered] = useState(true);
  const [message, setMessage] = useState('');

  const findClaim = (value = oldSerial) => {
    const serial = extractSerial(value);
    setOldSerial(value); // Keep the raw value in the input
    const found = claims.find((item) => item.productSerial === serial);
    if (!found) {
      setClaim(null);
      setMessage('No claim was found for that old serial. Search the register first if you need to review it.');
      return;
    }
    setClaim(found);
    setNewProductName(found.productName);
    setMessage('');
  };

  const complete = () => {
    if (!claim) { setMessage('Find the existing claim before linking a replacement.'); return; }
    const serial = extractSerial(newSerial);
    if (!serial || !newProductName.trim()) { setMessage('Scan or enter the new product serial and product name.'); return; }
    const duplicateNew = claims.find((item) => item.productSerial === serial && item.id !== claim.id);
    if (duplicateNew) { setMessage(`That new serial already belongs to ${duplicateNew.caseNumber}. Choose a different replacement product.`); return; }
    onComplete(claim, serial, newProductName.trim(), delivered);
  };

  return (
    <View>
      <ScreenHeading eyebrow="WARRANTY EXCHANGE" title="Link the old item to its replacement." copy="One clean record keeps the customer, both serial numbers, and the hand-off together." />
      <View style={styles.exchangeLayout}>
        <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : 'height'} style={[styles.surface, styles.exchangeCard]}>
          <View style={styles.exchangeStepTop}><View style={styles.exchangeStepNumber}><Text style={styles.exchangeStepNumberText}>1</Text></View><View><Text style={styles.intakeSectionTitle}>Find the original claim</Text><Text style={styles.sectionCopy}>Scan or type the serial currently on record.</Text></View></View>
          <View style={styles.exchangeSearchRow}><TextInput value={oldSerial} onChangeText={(value) => { setOldSerial(value); setClaim(null); }} placeholder="Old product serial" placeholderTextColor={palette.muted} autoCapitalize="characters" style={styles.exchangeInput} /><Pressable onPress={() => onOpenScanner((payload) => { setOldSerial(extractSerial(payload)); findClaim(payload); })} style={styles.exchangeScanButton}><Text style={styles.exchangeScanText}>Scan</Text></Pressable><PrimaryButton label="Find" onPress={() => findClaim()} compact /></View>
          {claim ? <View style={styles.foundClaim}><View style={styles.foundClaimTop}><Badge label={claim.caseNumber} tone="forest" /><StatusBadge status={claim.status} /></View><Text style={styles.foundClaimProduct}>{claim.productName}</Text><Text style={styles.foundClaimSerial}>{claim.productSerial}</Text><View style={styles.foundClaimMeta}><Text style={styles.foundClaimMetaText}>{claim.customerName}</Text><Text style={styles.metaDivider}>•</Text><Text style={styles.foundClaimMetaText}>{claim.mobileNumber}</Text><Pressable onPress={() => onOpenClaim(claim)}><Text style={styles.textLink}>Open claim ›</Text></Pressable></View></View> : <View style={styles.emptyFound}><Text style={styles.emptyFoundIcon}>⌕</Text><Text style={styles.emptyFoundText}>The old product will appear here once found.</Text></View>}
        </KeyboardAvoidingView>

        <View style={styles.exchangeConnector}><View style={styles.connectorLine} /><View style={styles.connectorArrow}><Text style={styles.connectorArrowText}>→</Text></View><View style={styles.connectorLine} /></View>

        <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : 'height'} style={[styles.surface, styles.exchangeCard, !claim && styles.exchangeCardMuted]}>
          <View style={styles.exchangeStepTop}><View style={[styles.exchangeStepNumber, claim && styles.exchangeStepNumberActive]}><Text style={[styles.exchangeStepNumberText, claim && styles.exchangeStepNumberTextActive]}>2</Text></View><View><Text style={styles.intakeSectionTitle}>Scan the replacement</Text><Text style={styles.sectionCopy}>The new serial is linked, never used to overwrite the old one.</Text></View></View>
          <View style={styles.scanReplacement}><Text style={styles.replacementIcon}>▣</Text><View style={styles.replacementCopy}><Text style={styles.replacementTitle}>New product identifier</Text><Text style={styles.replacementText}>Scan QR, product URL, or type the serial from the replacement.</Text></View><GhostButton label="Open scanner" onPress={() => onOpenScanner((payload) => setNewSerial(extractSerial(payload)))} compact /></View>
          <Field label="New product serial" value={newSerial} onChangeText={setNewSerial} placeholder="e.g. AMR-INV-40188" autoCapitalize="characters" />
          <Field label="Replacement product name" value={newProductName} onChangeText={setNewProductName} placeholder="Product name" />
          <Pressable onPress={() => setDelivered((current) => !current)} style={styles.deliveryToggle}><View style={[styles.checkbox, delivered && styles.checkboxChecked]}>{delivered ? <Text style={styles.checkboxTick}>✓</Text> : null}</View><View><Text style={styles.deliveryToggleTitle}>Replacement handed to customer now</Text><Text style={styles.deliveryToggleCopy}>Mark the original claim Delivered and Cleared when confirmed.</Text></View></Pressable>
          {message ? <View style={styles.formNotice}><Text style={styles.formNoticeIcon}>i</Text><Text style={styles.formNoticeText}>{message}</Text></View> : null}
          <PrimaryButton label="Confirm warranty exchange" onPress={complete} fullWidth disabled={!claim} />
        </KeyboardAvoidingView>
      </View>
      <View style={styles.exchangeSafety}><Text style={styles.exchangeSafetyIcon}>✓</Text><Text style={styles.exchangeSafetyText}>The old and new serials remain visible in one claim record and are included in the Sheets sync audit.</Text></View>
    </View>
  );
}

function SettingsScreen({
  user,
  claims,
  reminderPolicy,
  upsReminderPolicy,
  batteryAssignees,
  upsModels,
  upsAssignees,
  teamMembers,
  onReminderPolicyChange,
  onSaveUpsModel,
  onDeleteUpsModel,
  onUpsReminderPolicyChange,
  syncingClaims,
  runSyncClaims,
  syncingUpsPrices,
  runSyncUpsPrices,
  syncMessage,
  onRoleChange,
  onResetDemo,
  onSignOut,
  onBatteryAssigneeChange,
  onUpsAssigneeChange,
  onCheckForUpdates,
  currentlyRunning,
}: {
  user: AppUser;
  claims: Claim[];
  reminderPolicy: ReminderPolicy;
  upsReminderPolicy: UpsReminderPolicy;
  batteryAssignees: string[];
  upsModels: UpsModel[];
  upsAssignees: string[];
  teamMembers: AppUser[];
  onReminderPolicyChange: (policy: ReminderPolicy) => void;
  onSaveUpsModel: (model: UpsModel) => Promise<void>;
  onDeleteUpsModel: (modelId: string) => Promise<void>;
  onUpsReminderPolicyChange: (policy: UpsReminderPolicy) => void;
  syncingClaims: boolean;
  runSyncClaims: () => Promise<void>;
  syncingUpsPrices: boolean;
  runSyncUpsPrices: () => Promise<void>;
  syncMessage: string | null;
  onRoleChange: (role: UserRole) => void;
  onResetDemo: () => Promise<void>;
  onSignOut: () => Promise<void>;
  onBatteryAssigneeChange: (name: string) => void; // Now handles toggling
  onUpsAssigneeChange: (name: string) => void;
  onCheckForUpdates: () => void;
  currentlyRunning: Updates.UseUpdatesReturnType['currentlyRunning'];
}) {
  const [mode, setMode] = useState<ReminderMode>(reminderPolicy.mode);
  const [time, setTime] = useState(reminderPolicy.time);
  const [everyDays, setEveryDays] = useState(String(reminderPolicy.everyDays));
  const [date, setDate] = useState(reminderPolicy.date);
  const [saved, setSaved] = useState(false); 
  const [resetting, setResetting] = useState(false);
  const [upsMode, setUpsMode] = useState<ReminderMode>(upsReminderPolicy.mode);
  const [upsTime, setUpsTime] = useState(upsReminderPolicy.time);
  const [upsEveryDays, setUpsEveryDays] = useState(String(upsReminderPolicy.everyDays));
  const [upsDate, setUpsDate] = useState(upsReminderPolicy.date);
  const [upsSaved, setUpsSaved] = useState(false);
  const [settingsTab, setSettingsTab] = useState<'general' | 'ups_models'>('general');
  const [editingUpsModel, setEditingUpsModel] = useState<UpsModel | null>(null);
  const pending = claims.filter((claim) => claim.syncState === 'pending').length;
  const failed = claims.filter((claim) => claim.syncState === 'failed').length;

const demoMembers: AppUser[] = [
    user,
    { id: 'demo-admin', name: 'Riya Mehta', email: 'riya@warrantyflow.demo', role: 'admin' as const },
    { id: 'demo-staff', name: 'Aarav Singh', email: 'aarav@warrantyflow.demo', role: 'staff' as const },
  ].filter((member, index, allMembers) => {
    const firstIndex = allMembers.findIndex((candidate) => candidate.id === member.id || candidate.email === member.email);
    return firstIndex === index;
  }) as AppUser[];
  const resolvedTeamMembers: AppUser[] = teamMembers.length
    ? teamMembers
    : demoMembers;

  useEffect(() => {
    setMode(reminderPolicy.mode);
    setTime(reminderPolicy.time);
    setEveryDays(String(reminderPolicy.everyDays));
    setDate(reminderPolicy.date);
  }, [reminderPolicy]);

  const savePolicy = () => {
    const nextPolicy = normalizeReminderPolicy({
      mode,
      time: time.trim() || defaultReminderPolicy.time,
      everyDays: Number(everyDays) || defaultReminderPolicy.everyDays,
      date: date.trim() || defaultReminderPolicy.date,
    });
    onReminderPolicyChange(nextPolicy);
    setSaved(true);
    setTimeout(() => setSaved(false), 2200);
  };

  const saveUpsPolicy = () => {
    const nextPolicy = normalizeUpsReminderPolicy({
      mode: upsMode,
      time: upsTime.trim() || defaultUpsReminderPolicy.time,
      everyDays: Number(upsEveryDays) || defaultUpsReminderPolicy.everyDays,
      date: upsDate.trim() || defaultUpsReminderPolicy.date,
    });
    onUpsReminderPolicyChange(nextPolicy);
    setUpsSaved(true);
    setTimeout(() => setUpsSaved(false), 2200);
  };

  const reminderSummary = (() => {
    if (mode === 'daily') return `Daily reminder at ${time || '10:00'}`;
    if (mode === 'interval') return `Reminder every ${Math.max(1, Number(everyDays) || 3)} day(s) at ${time || '10:00'}`;
    return `One-off reminder on ${date || defaultReminderPolicy.date} at ${time || '10:00'}`;
  })();

  const upsReminderSummary = (() => {
    if (upsMode === 'daily') return `Daily reminder at ${upsTime || '10:30'}`;
    if (upsMode === 'interval') return `Reminder every ${Math.max(1, Number(upsEveryDays) || 1)} day(s) at ${upsTime || '10:30'}`;
    return `One-off reminder on ${upsDate || defaultUpsReminderPolicy.date} at ${upsTime || '10:30'}`;
  })();

  const handleEditUpsModel = (model: UpsModel) => {
    setEditingUpsModel(JSON.parse(JSON.stringify(model))); // Deep copy to avoid direct state mutation
  };

  return (
    <>
      <ScreenHeading eyebrow={user.role === 'admin' ? 'ADMINISTRATION' : 'YOUR WORKSPACE'} title={user.role === 'admin' ? 'Keep your desk running smoothly.' : 'Your AE Complaint Logs account.'} copy={user.role === 'admin' ? 'Set follow-up habits, check data sync, and keep team permissions intentional.' : 'You can manage your own session and view the current workspace setup.'} />

      <View style={styles.settingsGrid}>
        <View style={[styles.surface, styles.accountSurface]}>
          <Text style={styles.sectionTitle}>Signed-in account</Text><Text style={styles.sectionCopy}>Every action in the register is stamped with this identity.</Text>
          <View style={styles.accountIdentity}><Avatar name={user.name} large /><View><Text style={styles.accountName}>{user.name}</Text><Text style={styles.accountEmail}>{user.email}</Text><Badge label={user.role === 'admin' ? 'Administrator' : 'Staff member'} tone={user.role === 'admin' ? 'forest' : 'blue'} /></View></View>
          {!isSupabaseConfigured ? <View style={styles.demoBanner}><Text style={styles.demoBannerTitle}>Demo workspace</Text><Text style={styles.demoBannerText}>Connect Supabase to replace local demo data with shared secure records.</Text></View> : null}
          <GhostButton label="Sign out" onPress={() => void onSignOut()} compact />
        </View>

        {user.role === 'admin' ? <View style={[styles.surface, styles.reminderSurface]}><Text style={styles.sectionTitle}>Reminder policy</Text><Text style={styles.sectionCopy}>Choose how follow-up reminders should reach the team for open claims.</Text><View style={styles.reminderSetting}><View style={{ flex: 1 }}><Text style={styles.reminderBigNumber}>{mode === 'daily' ? 'Daily' : mode === 'interval' ? 'Every few days' : 'One date'}</Text><Text style={styles.reminderBigLabel}>{reminderSummary}</Text></View></View><View style={styles.segmented}><Pressable style={[styles.segmentButton, mode === 'daily' && styles.segmentButtonActive]} onPress={() => setMode('daily')}><Text style={[styles.segmentButtonText, mode === 'daily' && styles.segmentButtonTextActive]}>Daily</Text></Pressable><Pressable style={[styles.segmentButton, mode === 'interval' && styles.segmentButtonActive]} onPress={() => setMode('interval')}><Text style={[styles.segmentButtonText, mode === 'interval' && styles.segmentButtonTextActive]}>Every N days</Text></Pressable><Pressable style={[styles.segmentButton, mode === 'single' && styles.segmentButtonActive]} onPress={() => setMode('single')}><Text style={[styles.segmentButtonText, mode === 'single' && styles.segmentButtonTextActive]}>One date</Text></Pressable></View>{mode === 'interval' ? <View style={{ marginTop: 12, gap: 8 }}><Text style={styles.sectionCopy}>Send reminder every</Text><TextInput value={everyDays} onChangeText={setEveryDays} keyboardType="numeric" placeholder="3" style={[styles.policyInput, { width: 88 }]} /></View> : null}{mode === 'single' ? <View style={{ marginTop: 12, gap: 8 }}><Text style={styles.sectionCopy}>Pick the reminder date</Text><TextInput value={date} onChangeText={setDate} placeholder="YYYY-MM-DD" style={[styles.policyInput, { width: 140 }]} /></View> : null}<View style={{ marginTop: 12, gap: 8 }}><Text style={styles.sectionCopy}>Reminder time</Text><TextInput value={time} onChangeText={setTime} keyboardType="numbers-and-punctuation" placeholder="HH:MM" style={[styles.policyInput, { width: 92 }]} /></View><PrimaryButton label={saved ? 'Saved ✓' : 'Save reminder policy'} onPress={savePolicy} fullWidth /></View> : null}
      </View>

      {user.role === 'admin' ? <>
        <View style={styles.segmented}>
          <SegmentButton active={settingsTab === 'general'} label="General Settings" onPress={() => setSettingsTab('general')} />
          <SegmentButton active={settingsTab === 'ups_models'} label="UPS Models" onPress={() => setSettingsTab('ups_models')} />
        </View>

        {settingsTab === 'general' && (
          <>
        <View style={[styles.surface, styles.settingsSection]}>
          <View style={styles.surfaceHeader}><View><Text style={styles.sectionTitle}>Google Sheets delivery</Text><Text style={styles.sectionCopy}>Database records are the source of truth; Sheets receives reliable, separate Battery and UPS projections.</Text></View><Badge label={isSupabaseConfigured ? 'Backend configured' : 'Setup needed'} tone={isSupabaseConfigured ? 'mint' : 'amber'} /></View>
          <View style={styles.syncStatusGrid}><SyncStatus label="Queued" value={pending} tone="amber" /><SyncStatus label="Needs retry" value={failed} tone={failed ? 'rose' : 'mint'} /><SyncStatus label="Battery target" value="Battery Claims" tone="blue" /><SyncStatus label="UPS target" value="UPS Claims" tone="blue" /></View>
          <View style={styles.setupList}><SetupLine number="1" text="Add Supabase and Google service-account values to Vercel." /><SetupLine number="2" text="Share each target Sheet with the service-account email." /><SetupLine number="3" text="Deploy: records will upsert by Claim ID, without duplicate rows." /></View>
          <View style={[styles.syncControls, { marginTop: 18 }]}>
            <Text style={styles.sectionTitle}>Manual sync controls</Text>
            <Text style={styles.sectionCopy}>Retry any pending claim syncs or publish the latest UPS price list to your sheet.</Text>
            <View style={styles.syncButtonRow}>
              <PrimaryButton label={syncingClaims ? 'Syncing claims…' : 'Retry claim sync'} onPress={() => void runSyncClaims()} disabled={syncingClaims} compact />
              <PrimaryButton label={syncingUpsPrices ? 'Syncing UPS prices…' : 'Sync UPS prices'} onPress={() => void runSyncUpsPrices()} disabled={syncingUpsPrices} compact />
            </View> 
            {syncMessage ? <Text style={styles.syncMessage}>{syncMessage}</Text> : null} 
          </View>
        </View>

        <View style={[styles.surface, styles.settingsSection]}>
          <View style={styles.surfaceHeader}><View><Text style={styles.sectionTitle}>Team permissions</Text><Text style={styles.sectionCopy}>Administrators can configure reporting and policy. Staff can create, find, and update operational claims.</Text></View></View>
<View style={styles.teamRows}>{resolvedTeamMembers.map((member) => <TeamRow key={member.id} user={member} currentRole={user.role} onChange={onRoleChange} />)}</View>
        </View>

        <View style={[styles.surface, styles.settingsSection]}>
          <View style={styles.surfaceHeader}><View><Text style={styles.sectionTitle}>Battery Claim Notifications</Text><Text style={styles.sectionCopy}>Choose team members to receive reminders for battery claims that are not yet delivered.</Text></View></View>
<View style={styles.teamRows}>
            {resolvedTeamMembers.map((member) => <AssigneeRow key={member.id} user={member} active={batteryAssignees.includes(member.name)} onSelect={() => onBatteryAssigneeChange(member.name)} />)}
          </View>
        </View>
        
        <View style={[styles.surface, styles.settingsSection]}>
          <View style={styles.surfaceHeader}><View><Text style={styles.sectionTitle}>UPS Claim Notifications</Text><Text style={styles.sectionCopy}>Assign staff to receive daily summaries of open UPS claims, including repair and selling prices.</Text></View></View>
<View style={styles.teamRows}>
            {resolvedTeamMembers.map((member) => <AssigneeRow key={member.id} user={member} active={upsAssignees.includes(member.name)} onSelect={() => onUpsAssigneeChange(member.name)} />)}
          </View>
        </View> 

        <View style={[styles.surface, styles.settingsSection]}>
          <View style={styles.surfaceHeader}><View><Text style={styles.sectionTitle}>UPS Reminder Policy</Text><Text style={styles.sectionCopy}>Choose how financial summaries should reach the assigned team members.</Text></View></View>
          <View style={[styles.reminderSurface, {padding: 0}]}><View style={styles.reminderSetting}><View style={{ flex: 1 }}><Text style={styles.reminderBigNumber}>{upsMode === 'daily' ? 'Daily' : upsMode === 'interval' ? 'Every few days' : 'One date'}</Text><Text style={styles.reminderBigLabel}>{upsReminderSummary}</Text></View></View><View style={styles.segmented}><Pressable style={[styles.segmentButton, upsMode === 'daily' && styles.segmentButtonActive]} onPress={() => setUpsMode('daily')}><Text style={[styles.segmentButtonText, upsMode === 'daily' && styles.segmentButtonTextActive]}>Daily</Text></Pressable><Pressable style={[styles.segmentButton, upsMode === 'interval' && styles.segmentButtonActive]} onPress={() => setUpsMode('interval')}><Text style={[styles.segmentButtonText, upsMode === 'interval' && styles.segmentButtonTextActive]}>Every N days</Text></Pressable><Pressable style={[styles.segmentButton, upsMode === 'single' && styles.segmentButtonActive]} onPress={() => setUpsMode('single')}><Text style={[styles.segmentButtonText, upsMode === 'single' && styles.segmentButtonTextActive]}>One date</Text></Pressable></View>{upsMode === 'interval' ? <View style={{ marginTop: 12, gap: 8 }}><Text style={styles.sectionCopy}>Send reminder every</Text><TextInput value={upsEveryDays} onChangeText={setUpsEveryDays} keyboardType="numeric" placeholder="1" style={[styles.policyInput, { width: 88 }]} /></View> : null}{upsMode === 'single' ? <View style={{ marginTop: 12, gap: 8 }}><Text style={styles.sectionCopy}>Pick the reminder date</Text><TextInput value={upsDate} onChangeText={setUpsDate} placeholder="YYYY-MM-DD" style={[styles.policyInput, { width: 140 }]} /></View> : null}<View style={{ marginTop: 12, gap: 8 }}><Text style={styles.sectionCopy}>Reminder time</Text><TextInput value={upsTime} onChangeText={setUpsTime} keyboardType="numbers-and-punctuation" placeholder="HH:MM" style={[styles.policyInput, { width: 92 }]} /></View><PrimaryButton label={upsSaved ? 'Saved ✓' : 'Save UPS Policy'} onPress={saveUpsPolicy} fullWidth /></View>
        </View>
        </>
        )}

        {settingsTab === 'ups_models' && (
          <View style={[styles.surface, styles.settingsSection]}>
            <View style={styles.surfaceHeader}>
              <View>
                <Text style={styles.sectionTitle}>UPS Models & Pricing</Text>
                <Text style={styles.sectionCopy}>Manage a central list of UPS models and their standard costs. This list will be synced to your Google Sheet.</Text>
              </View>
            </View>
            <View style={styles.modelTableHeader}>
              <Text style={styles.modelTableCell}>Model</Text>
              <Text style={styles.modelTableCell}>Repair</Text>
              <Text style={styles.modelTableCell}>Selling</Text>
              <Text style={[styles.modelTableCell, styles.modelTableCellActions]}>Actions</Text>
            </View>
            <View>
              {upsModels.map(model => (
                <View key={model.id} style={styles.modelRow}>
                  <Text style={styles.modelTableCell}>{model.model_name}</Text>
                  <Text style={styles.modelTableCell}>₹{model.repair_price}</Text>
                  <Text style={styles.modelTableCell}>₹{model.selling_price}</Text>
                  <View style={[styles.modelTableCell, styles.modelTableCellActions]}><GhostButton label="Edit" onPress={() => handleEditUpsModel(model)} compact /><GhostButton label="Delete" onPress={() => onDeleteUpsModel(model.id)} compact /></View>
                </View>
              ))}
            </View>
            <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : 'height'}>
              <View style={{ marginTop: 16, paddingTop: 16, borderTopWidth: 1, borderColor: palette.line }}>
                <Text style={styles.sectionTitle}>{editingUpsModel?.id ? 'Edit UPS Model' : 'Add New UPS Model'}</Text>
                <Field label="Model Name" value={editingUpsModel?.model_name || ''} onChangeText={text => setEditingUpsModel(m => ({ ...(m || emptyUpsModel()), model_name: text }))} placeholder="e.g. Microtek EB 1100" />
                <View style={styles.twoFieldGrid}>
                  <Field label="Repair Price" value={String(editingUpsModel?.repair_price || '')} onChangeText={text => setEditingUpsModel(m => ({ ...(m || emptyUpsModel()), repair_price: Number(text) }))} placeholder="500" keyboardType="numeric" />
                  <Field label="Selling Price" value={String(editingUpsModel?.selling_price || '')} onChangeText={text => setEditingUpsModel(m => ({ ...(m || emptyUpsModel()), selling_price: Number(text) }))} placeholder="750" keyboardType="numeric" />
                </View>
                <View style={{ flexDirection: 'row', gap: 10, marginTop: 12 }}>
                  <PrimaryButton
                    label="Save Model"
                    onPress={() => {
                      if (editingUpsModel) void onSaveUpsModel(editingUpsModel).then(() => setEditingUpsModel(null));
                    }}
                  />
                  <GhostButton label="Cancel" onPress={() => setEditingUpsModel(null)} />
                </View>
              </View>
            </KeyboardAvoidingView>
          </View>
        )}

        {!isSupabaseConfigured ? <View style={styles.demoResetRow}><View><Text style={styles.demoResetTitle}>Need a clean demo?</Text><Text style={styles.demoResetCopy}>Restore the example claims stored only on this device.</Text></View><GhostButton label={resetting ? 'Resetting…' : 'Reset demo data'} onPress={async () => { setResetting(true); await onResetDemo(); setResetting(false); }} compact /></View> : null}
      </> : null}

      <View style={[styles.surface, { marginTop: 16 }]}>
        <Text style={styles.sectionTitle}>App Updates</Text>
        <PrimaryButton label="Check for Updates" onPress={onCheckForUpdates} fullWidth />
        {!__DEV__ && currentlyRunning.updateId && (
          <Text style={styles.updateIdText}>
            Current version: {currentlyRunning.updateId.slice(0, 8)}
          </Text>
        )}
      </View>
    </>
  );
}

function ClaimDetailModal({
  claim,
  user,
  onClose,
  onChangeStatus,
  onStartExchange,
}: {
  claim: Claim | null;
  user: AppUser;
  onClose: () => void;
  onChangeStatus: (claim: Claim, status: ClaimStatus) => void;
  onStartExchange: (claim: Claim) => void;
}) {
  if (!claim) return null;
  const isDelivered = claim.status === 'delivered_to_customer';
  return (
    <Modal visible transparent animationType="slide" onRequestClose={onClose}>
      <View style={styles.modalBackdrop}>
        <Pressable style={styles.modalDismissArea} onPress={onClose} />
        <View style={styles.claimModal}>
          <View style={styles.modalHandle} />
          <View style={styles.claimModalHeader}><View><View style={styles.detailBadgeRow}><Badge label={claim.caseNumber} tone="forest" /><StatusBadge status={claim.status} /></View><Text style={styles.detailProduct}>{claim.productName}</Text><Text style={styles.detailSerial}>{claim.productSerial}</Text></View><Pressable onPress={onClose} style={styles.closeButton}><Text style={styles.closeButtonText}>×</Text></Pressable></View>
          <ScrollView showsVerticalScrollIndicator={false} contentContainerStyle={styles.claimModalScroll}>
            <View style={styles.detailIdentity}><View><Text style={styles.detailLabel}>CUSTOMER</Text><Text style={styles.detailValue}>{claim.customerName}</Text><Text style={styles.detailSubvalue}>{claim.mobileNumber}</Text></View><View><Text style={styles.detailLabel}>SLIP NUMBER</Text><Text style={styles.detailValue}>{claim.slipNumber}</Text><Text style={styles.detailSubvalue}>Added {formatDateTime(claim.createdAt)}</Text></View></View>
            {claim.complaint ? <View style={styles.detailNote}><Text style={styles.detailLabel}>CUSTOMER COMPLAINT</Text><Text style={styles.detailNoteText}>{claim.complaint}</Text></View> : null}
            {claim.assigneeName ? <View style={styles.detailSection}><Text style={styles.sectionTitle}>Assigned follow-up</Text><Text style={styles.detailValue}>{claim.assigneeName}</Text></View> : null}
            <View style={styles.detailSection}><View style={styles.detailSectionHeading}><Text style={styles.sectionTitle}>Status journey</Text><Text style={styles.detailMeta}>Updated by {claim.createdBy}</Text></View><StatusJourney status={claim.status} /></View>
            {!isDelivered ? <View style={styles.statusActions}><Text style={styles.detailLabel}>UPDATE STATUS</Text><View style={styles.statusActionRow}><StatusAction label="With us" active={claim.status === 'with_us'} tone="mint" onPress={() => onChangeStatus(claim, 'with_us')} /><StatusAction label="Send for warranty" active={claim.status === 'gone_for_warranty_claim'} tone="amber" onPress={() => onChangeStatus(claim, 'gone_for_warranty_claim')} /><StatusAction label="Delivered" active={false} tone="blue" onPress={() => onChangeStatus(claim, 'delivered_to_customer')} /></View></View> : null}
            <View style={styles.detailSection}><Text style={styles.sectionTitle}>Product details</Text><View style={styles.detailSpecs}>{claim.productType === 'battery' ? <><DetailSpec label="Voltage" value={claim.battery?.voltage || '—'} /><DetailSpec label="Capacity" value={claim.battery?.capacity || '—'} /><DetailSpec label="Type" value={claim.battery?.chemistry || '—'} /><DetailSpec label="Warranty" value={claim.battery?.warrantyMonths ? `${claim.battery.warrantyMonths} months` : '—'} /></> : <><DetailSpec label="VA rating" value={claim.ups?.rating || '—'} /><DetailSpec label="Batteries" value={claim.ups?.batteryCount || '—'} /><DetailSpec label="Capacity" value={claim.ups?.batteryCapacity || '—'} /><DetailSpec label="Warranty" value={claim.ups?.warrantyMonths ? `${claim.ups.warrantyMonths} months` : '—'} /></>}</View></View>
            {claim.productType === 'ups' && (claim.ups?.repairPrice || claim.ups?.sellingPrice) && (
              <View style={styles.detailSection}>
                <Text style={styles.sectionTitle}>Financials</Text>
                <View style={styles.detailSpecs}>
                  {claim.ups?.repairPrice ? (
                    <DetailSpec label="Repair Price" value={`₹${Number(claim.ups.repairPrice).toLocaleString('en-IN')}`} />
                  ) : null}
                  {claim.ups?.sellingPrice ? (
                    <DetailSpec label="Selling Price" value={`₹${Number(claim.ups.sellingPrice).toLocaleString('en-IN')}`} />
                  ) : null}
                </View>
              </View>
            )}
            {claim.attachments && claim.attachments.length ? (
              <View style={styles.detailSection}>
                <Text style={styles.sectionTitle}>Attachments</Text>
                <View style={styles.attachmentPreviewGrid}>
                  {claim.attachments.map((attachment) => (
                    <View key={attachment.id} style={styles.attachmentPreviewCard}> 
                      <Image source={{ uri: `${attachment.uri}?v=${Date.now()}` }} style={styles.attachmentPreviewImage} />
                      <Text style={styles.attachmentPreviewLabel}>{attachment.name || 'Photo'}</Text>
                    </View>
                  ))}
                </View>
              </View>
            ) : null}
            {claim.replacementSerial ? <View style={styles.replacementRecord}><Text style={styles.detailLabel}>WARRANTY REPLACEMENT</Text><Text style={styles.replacementRecordName}>{claim.replacementProductName || 'Replacement product'}</Text><Text style={styles.replacementRecordSerial}>{claim.replacementSerial}</Text><Text style={styles.replacementRecordCaption}>Linked to old serial {claim.productSerial}</Text></View> : null}
            <View style={styles.detailFooter}><View><Text style={styles.detailLabel}>SHEETS SYNC</Text><Badge label={syncLabel(claim.syncState)} tone={syncTone[claim.syncState]} /></View><Text style={styles.detailMeta}>{isDelivered ? `Cleared ${formatDate(claim.deliveredAt || claim.updatedAt)}` : `Next follow-up ${formatDate(claim.reminderDueAt)}`}</Text></View>
            {!claim.replacementSerial && user.role !== 'staff' ? <PrimaryButton label="Start warranty exchange" onPress={() => onStartExchange(claim)} fullWidth /> : null}
          </ScrollView>
        </View>
      </View>
    </Modal>
  );
}

function DuplicateModal({
  claim,
  user,
  visible,
  onClose,
  onOpenExisting,
  onCreateRepeat,
}: {
  claim: Claim | null;
  user: AppUser;
  visible: boolean;
  onClose: () => void;
  onOpenExisting: () => void;
  onCreateRepeat: () => void;
}) {
  if (!claim) return null;
  const completed = claim.status === 'delivered_to_customer';
  const canRepeat = completed || user.role === 'admin';
  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose}>
      <View style={styles.dialogBackdrop}><View style={styles.duplicateDialog}><View style={styles.duplicateIcon}><Text style={styles.duplicateIconText}>!</Text></View><Text style={styles.duplicateTitle}>{completed ? 'This item has been here before.' : 'This item is already on the desk.'}</Text><Text style={styles.duplicateCopy}>{completed ? 'A completed complaint exists for this serial. Has the item come back with a new complaint?' : `An active claim was added ${formatDate(claim.createdAt)} by ${claim.createdBy}. To avoid two active cases, review the existing record first.`}</Text><View style={styles.duplicateRecord}><Text style={styles.duplicateRecordCase}>{claim.caseNumber}</Text><Text style={styles.duplicateRecordProduct}>{claim.productName}</Text><Text style={styles.duplicateRecordSerial}>{claim.productSerial}</Text><StatusBadge status={claim.status} /></View><PrimaryButton label="Open existing claim" onPress={onOpenExisting} fullWidth />{canRepeat ? <GhostButton label={completed ? 'Yes, it came back for a new complaint' : 'Create an admin exception'} onPress={onCreateRepeat} fullWidth /> : null}<Pressable onPress={onClose}><Text style={styles.dialogCancel}>Cancel</Text></Pressable></View></View>
    </Modal>
  );
}

function ScannerModal({ visible, onClose, onScan }: { visible: boolean; onClose: () => void; onScan: (payload: string) => void }) {
  const [permission, requestPermission] = useCameraPermissions();
  const [manualValue, setManualValue] = useState(''); 
  const [paused, setPaused] = useState(false);

  const complete = (value: string) => {
    if (!value.trim()) return;
    setPaused(true);
    onScan(value.trim());
    setManualValue('');
  };

  useEffect(() => {
    if (visible) setPaused(false);
  }, [visible]);

  return (
    <Modal visible={visible} animationType="slide" onRequestClose={onClose}>
      <SafeAreaView style={styles.scannerScreen}>
        <View style={styles.scannerHeader}><View><Text style={styles.scannerTitle}>Scan product code</Text><Text style={styles.scannerCopy}>QR, barcode, or serial label.</Text></View><Pressable onPress={onClose} style={styles.scannerClose}><Text style={styles.scannerCloseText}>×</Text></Pressable></View>
        <View style={styles.cameraFrame}>
          {!permission ? <View style={styles.cameraMessage}><ActivityIndicator color={palette.white} /></View> : !permission.granted ? <View style={styles.cameraMessage}><Text style={styles.cameraMessageTitle}>Camera access is needed to scan.</Text><Text style={styles.cameraMessageCopy}>You can also paste or type an identifier below.</Text><PrimaryButton label="Allow camera" onPress={() => void requestPermission()} /></View> : <CameraView style={styles.camera} facing="back" onBarcodeScanned={paused ? undefined : ({ data }: { data: string }) => complete(data)} barcodeScannerSettings={{ barcodeTypes: ['qr', 'code128', 'code39', 'ean13', 'ean8'] }} autofocus="on" />}
          <View pointerEvents="none" style={styles.scanGuide}><View style={styles.guideCornerTopLeft} /><View style={styles.guideCornerTopRight} /><View style={styles.guideCornerBottomLeft} /><View style={styles.guideCornerBottomRight} /></View>
        </View>
        <View style={styles.manualScanEntry}><Text style={styles.fieldLabel}>NO CAMERA? PASTE OR TYPE THE CODE</Text><View style={styles.manualScanRow}><TextInput value={manualValue} onChangeText={setManualValue} placeholder="Serial, QR value, or product URL" placeholderTextColor={palette.muted} style={styles.manualScanInput} autoCapitalize="characters" /><PrimaryButton label="Use code" onPress={() => complete(manualValue)} compact /></View><Text style={styles.manualScanHint}>If it’s a URL, WarrantyFlow extracts the serial safely—it never opens the link.</Text></View>
      </SafeAreaView> 
    </Modal>
  );
}

function AttachmentCameraModal({ visible, onClose, onCapture }: { visible: boolean; onClose: () => void; onCapture: (attachment: ClaimAttachment) => void }) {
  const [permission, requestPermission] = useCameraPermissions();
  const [busy, setBusy] = useState(false);
const cameraRef = useRef<CameraView | null>(null);

  const capture = async () => {
    if (!cameraRef.current || busy) return;
    setBusy(true);
    try {
      const photo = await cameraRef.current.takePictureAsync({ quality: 0.6, skipProcessing: true });
      if (photo?.uri) {
        onCapture({ id: makeUuid(), uri: photo.uri, name: `Attachment ${new Date().toLocaleString()}` });
        onClose();
      }
    } catch (error) {
      console.error('Failed to capture attachment', error);
      Alert.alert('Capture failed', 'Unable to take the photo.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal visible={visible} animationType="slide" onRequestClose={onClose}>
      <SafeAreaView style={styles.scannerScreen}>
        <View style={styles.scannerHeader}><View><Text style={styles.scannerTitle}>Capture attachment</Text><Text style={styles.scannerCopy}>Take a photo of the product, receipt, or damage details.</Text></View><Pressable onPress={onClose} style={styles.scannerClose}><Text style={styles.scannerCloseText}>×</Text></Pressable></View>
        <View style={[styles.cameraFrame, { borderRadius: 0 }]}>
          {!permission ? <View style={styles.cameraMessage}><ActivityIndicator color={palette.white} /></View> : !permission.granted ? <View style={styles.cameraMessage}><Text style={styles.cameraMessageTitle}>Camera access is needed.</Text><PrimaryButton label="Allow camera" onPress={() => void requestPermission()} /></View> : <CameraView style={styles.camera} ref={cameraRef} facing="back" />}
        </View>
        <View style={styles.manualScanEntry}><Text style={styles.fieldLabel}>Need a better angle?</Text><View style={styles.manualScanRow}><PrimaryButton label={busy ? 'Capturing…' : 'Take photo'} onPress={capture} disabled={busy || !permission?.granted} compact /><GhostButton label="Cancel" onPress={onClose} compact /></View></View>
      </SafeAreaView>
    </Modal>
  );
}

function ScreenHeading({ eyebrow, title, copy }: { eyebrow: string; title: string; copy: string }) {
  return <View style={styles.screenHeading}><Text style={styles.eyebrow}>{eyebrow}</Text><Text style={styles.pageTitle}>{title}</Text><Text style={styles.pageSubtitle}>{copy}</Text></View>;
}

function MetricCard({ label, value, detail, tone, icon }: { label: string; value: string; detail: string; tone: 'forest' | 'amber' | 'rose' | 'mint' | 'blue'; icon: string }) {
  const fills: Record<string, { backgroundColor: string; color: string }> = {
    forest: { backgroundColor: palette.forest, color: palette.white }, amber: { backgroundColor: palette.amberSoft, color: palette.amber }, rose: { backgroundColor: palette.roseSoft, color: palette.rose }, mint: { backgroundColor: palette.mint, color: palette.emerald }, blue: { backgroundColor: palette.blueSoft, color: palette.blue },
  };
  return <View style={styles.metricCard}><View style={[styles.metricIcon, { backgroundColor: fills[tone].backgroundColor }]}><Text style={[styles.metricIconText, { color: fills[tone].color }]}>{icon}</Text></View><Text style={styles.metricLabel}>{label}</Text><Text style={styles.metricValue}>{value}</Text><Text style={styles.metricDetail}>{detail}</Text></View>;
}

function QuickAction({ icon, title, copy, onPress }: { icon: string; title: string; copy: string; onPress: () => void }) {
  return <Pressable onPress={onPress} style={({ pressed }) => [styles.quickAction, pressed && styles.pressed]}><View style={styles.quickActionIcon}><Text style={styles.quickActionIconText}>{icon}</Text></View><View style={styles.quickActionCopy}><Text style={styles.quickActionTitle}>{title}</Text><Text style={styles.quickActionText}>{copy}</Text></View><Text style={styles.quickActionArrow}>›</Text></Pressable>;
}

function MixBar({ label, value, total, color }: { label: string; value: number; total: number; color: string }) {
  const percentage = Math.round((value / total) * 100);
  return <View style={styles.mixBarRow}><View style={styles.mixBarLabelRow}><Text style={styles.mixBarLabel}>{label}</Text><Text style={styles.mixBarValue}>{value} · {percentage}%</Text></View><View style={styles.mixTrack}><View style={[styles.mixFill, { width: `${percentage}%`, backgroundColor: color }]} /></View></View>;
}

function MiniStatus({ label, value, tone }: { label: string; value: number; tone: 'mint' | 'amber' | 'blue' }) {
  return <View style={styles.miniStatus}><View style={[styles.miniStatusDot, { backgroundColor: tone === 'mint' ? palette.emerald : tone === 'amber' ? palette.amber : palette.blue }]} /><Text style={styles.miniStatusValue}>{value}</Text><Text style={styles.miniStatusLabel}>{label}</Text></View>;
}

function ClaimTableRow({ claim, onPress }: { claim: Claim; onPress: () => void }) {
  return <Pressable onPress={onPress} style={({ pressed }) => [styles.claimTableRow, pressed && styles.pressed]}><View style={styles.tableClaim}><Text style={styles.tableClaimProduct}>{claim.productName}</Text><Text style={styles.tableClaimSerial}>{claim.productSerial}</Text></View><View style={styles.tableCustomer}><Text style={styles.tableCustomerName}>{claim.customerName}</Text><Text style={styles.tableCustomerMobile}>{claim.mobileNumber}</Text></View><View style={styles.tableStatus}><StatusBadge status={claim.status} /></View><Text style={[styles.tableAge, styles.tableAgeText]}>{daysBetween(claim.receivedAt, claim.deliveredAt)}d</Text><Text style={styles.tableArrow}>›</Text></Pressable>;
}

function ClaimListCard({ claim, onPress }: { claim: Claim; onPress: () => void }) {
  return <Pressable onPress={onPress} style={({ pressed }) => [styles.claimListCard, pressed && styles.pressed]}><View style={[styles.claimTypeMark, claim.productType === 'battery' ? styles.claimTypeBattery : styles.claimTypeUps]}><Text style={[styles.claimTypeMarkText, claim.productType === 'battery' ? styles.claimTypeBatteryText : styles.claimTypeUpsText]}>{claim.productType === 'battery' ? 'B' : 'U'}</Text></View><View style={styles.claimListMain}><View style={styles.claimListTop}><Text style={styles.claimListProduct}>{claim.productName}</Text><StatusBadge status={claim.status} /></View><Text style={styles.claimListSerial}>{claim.productSerial}</Text><View style={styles.claimListMeta}><Text style={styles.claimListMetaText}>{claim.caseNumber}</Text><Text style={styles.metaDivider}>•</Text><Text style={styles.claimListMetaText}>{claim.customerName}</Text><Text style={styles.metaDivider}>•</Text><Text style={styles.claimListMetaText}>{formatDate(claim.createdAt)}</Text></View></View><Text style={styles.claimListArrow}>›</Text></Pressable>;
}

function ProductTypeButton({ type, active, onPress }: { type: ProductType; active: boolean; onPress: () => void }) {
  return <Pressable onPress={onPress} style={[styles.productTypeButton, active && styles.productTypeButtonActive]}><View style={[styles.productTypeIcon, active && styles.productTypeIconActive]}><Text style={[styles.productTypeIconText, active && styles.productTypeIconTextActive]}>{type === 'battery' ? 'B' : 'U'}</Text></View><View><Text style={[styles.productTypeTitle, active && styles.productTypeTitleActive]}>{TYPE_LABELS[type]}</Text><Text style={[styles.productTypeCopy, active && styles.productTypeCopyActive]}>{type === 'battery' ? 'Voltage & capacity' : 'VA & backup details'}</Text></View><View style={[styles.radio, active && styles.radioActive]}>{active ? <View style={styles.radioDot} /> : null}</View></Pressable>;
}

function StepRail({ index, title, active = false }: { index: string; title: string; active?: boolean }) {
  return <View style={styles.stepRail}><View style={[styles.stepNumber, active && styles.stepNumberActive]}><Text style={[styles.stepNumberText, active && styles.stepNumberTextActive]}>{index}</Text></View><Text style={[styles.stepText, active && styles.stepTextActive]}>{title}</Text></View>;
}

function StatusJourney({ status }: { status: ClaimStatus }) {
  const states: ClaimStatus[] = ['with_us', 'gone_for_warranty_claim', 'delivered_to_customer'];
  const activeIndex = states.indexOf(status);
  return <View style={styles.journey}>{states.map((state, index) => <View key={state} style={styles.journeyItem}>{index < states.length - 1 ? <View style={[styles.journeyLine, index < activeIndex && styles.journeyLineActive]} /> : null}<View style={[styles.journeyDot, index <= activeIndex && styles.journeyDotActive]}>{index <= activeIndex ? <Text style={styles.journeyCheck}>✓</Text> : null}</View><Text style={[styles.journeyText, index <= activeIndex && styles.journeyTextActive]}>{STATUS_LABELS[state]}</Text></View>)}</View>;
}

function StatusAction({ label, active, tone, onPress }: { label: string; active: boolean; tone: 'mint' | 'amber' | 'blue'; onPress: () => void }) {
  const color = tone === 'mint' ? palette.emerald : tone === 'amber' ? palette.amber : palette.blue;
  return <Pressable onPress={onPress} style={[styles.statusAction, active && { borderColor: color, backgroundColor: tone === 'mint' ? palette.mint : tone === 'amber' ? palette.amberSoft : palette.blueSoft }]}><Text style={[styles.statusActionText, active && { color }]}>{label}</Text></Pressable>;
}

function DetailSpec({ label, value }: { label: string; value: string }) {
  return <View style={styles.detailSpec}><Text style={styles.detailSpecLabel}>{label}</Text><Text style={styles.detailSpecValue}>{value}</Text></View>;
}

function TeamRow({ user, currentRole, onChange }: { user: AppUser; currentRole: UserRole; onChange: (role: UserRole) => void }) {
  const initials = user.name.split(' ').map((part: string) => part[0]).slice(0, 2).join('').toUpperCase();
  return <View style={styles.teamRow}><View style={styles.teamAvatar}><Text style={styles.teamAvatarText}>{initials}</Text></View><View style={styles.teamInfo}><Text style={styles.teamName}>{user.name}</Text><Text style={styles.teamEmail}>{user.email}</Text></View><Pressable onPress={() => onChange(user.role)} style={[styles.teamRole, currentRole === user.role && styles.teamRoleActive]}><Text style={[styles.teamRoleText, currentRole === user.role && styles.teamRoleTextActive]}>{user.role === 'admin' ? 'Admin' : 'Staff'}</Text></Pressable></View>;
}

function AssigneeRow({ user, active, onSelect }: { user: AppUser; active: boolean; onSelect: () => void }) {
  const initials = user.name.split(' ').map((part) => part[0]).slice(0, 2).join('').toUpperCase();
  return (
    <Pressable onPress={onSelect} style={({ pressed }: { pressed: boolean }) => [styles.teamRow, pressed && styles.pressed]}><View style={styles.teamAvatar}><Text style={styles.teamAvatarText}>{initials}</Text></View><View style={styles.teamInfo}><Text style={styles.teamName}>{user.name}</Text><Text style={styles.teamEmail}>{user.role === 'admin' ? 'Administrator' : 'Staff member'}</Text></View><View style={[styles.checkbox, active && styles.checkboxChecked]}>{active ? <Text style={styles.checkboxTick}>✓</Text> : null}</View></Pressable>
  );
}

function SyncStatus({ label, value, tone }: { label: string; value: string | number; tone: 'mint' | 'amber' | 'rose' | 'blue' }) {
  const background = tone === 'mint' ? palette.mint : tone === 'amber' ? palette.amberSoft : tone === 'rose' ? palette.roseSoft : palette.blueSoft;
  const color = tone === 'mint' ? palette.emerald : tone === 'amber' ? palette.amber : tone === 'rose' ? palette.rose : palette.blue;
  return <View style={[styles.syncStatus, { backgroundColor: background }]}><Text style={[styles.syncStatusValue, { color }]}>{value}</Text><Text style={styles.syncStatusLabel}>{label}</Text></View>;
}

function SetupLine({ number, text }: { number: string; text: string }) {
  return <View style={styles.setupLine}><View style={styles.setupNumber}><Text style={styles.setupNumberText}>{number}</Text></View><Text style={styles.setupText}>{text}</Text></View>;
}

function FeatureDot({ text }: { text: string }) { return <View style={styles.featureDotRow}><View style={styles.featureDot}><Text style={styles.featureDotTick}>✓</Text></View><Text style={styles.featureDotText}>{text}</Text></View>; }

function RoleChoice({ role, active, onPress }: { role: UserRole; active: boolean; onPress: () => void }) { return <Pressable onPress={onPress} style={[styles.roleChoice, active && styles.roleChoiceActive]}><Text style={[styles.roleChoiceTitle, active && styles.roleChoiceTitleActive]}>{role === 'admin' ? 'Admin' : 'Staff'}</Text><Text style={[styles.roleChoiceCopy, active && styles.roleChoiceCopyActive]}>{role === 'admin' ? 'Dashboard & settings' : 'Claims & updates'}</Text></Pressable>; }

function Badge({ label, tone = 'neutral' }: { label: string; tone?: 'mint' | 'amber' | 'rose' | 'blue' | 'forest' | 'neutral' }) {
  const stylesForTone: Record<string, { bg: string; fg: string }> = { mint: { bg: palette.mint, fg: palette.emerald }, amber: { bg: palette.amberSoft, fg: palette.amber }, rose: { bg: palette.roseSoft, fg: palette.rose }, blue: { bg: palette.blueSoft, fg: palette.blue }, forest: { bg: palette.forest, fg: palette.white }, neutral: { bg: palette.canvas, fg: palette.muted } };
  const selected = stylesForTone[tone];
  return <View style={[styles.badge, { backgroundColor: selected.bg }]}><Text style={[styles.badgeText, { color: selected.fg }]}>{label}</Text></View>;
}

function StatusBadge({ status }: { status: ClaimStatus }) { return <Badge label={STATUS_LABELS[status]} tone={statusTone[status]} />; }

function Field({ label, value, onChangeText, placeholder, keyboardType = 'default', multiline = false, secureTextEntry = false, autoCapitalize = 'sentences', inputRef, returnKeyType = 'default', onSubmitEditing, autoComplete = 'off', editable = true }: { label: string; value: string; onChangeText: (value: string) => void; placeholder: string; keyboardType?: 'default' | 'email-address' | 'phone-pad' | 'numeric'; multiline?: boolean; secureTextEntry?: boolean; autoCapitalize?: 'none' | 'sentences' | 'words' | 'characters'; inputRef?: { current: TextInput | null }; returnKeyType?: 'done' | 'next' | 'default'; onSubmitEditing?: () => void; autoComplete?: 'off' | 'name' | 'email' | 'password'; editable?: boolean }) {
  return <View style={[styles.field, multiline && styles.fieldMultiline]}><Text style={styles.fieldLabel}>{label.toUpperCase()}</Text><TextInput ref={inputRef} value={value} onChangeText={onChangeText} placeholder={placeholder} placeholderTextColor={palette.muted} keyboardType={keyboardType} multiline={multiline} secureTextEntry={secureTextEntry} autoCapitalize={autoCapitalize} autoComplete={autoComplete} returnKeyType={returnKeyType} onSubmitEditing={onSubmitEditing} editable={editable} style={[styles.textInput, multiline && styles.textArea]} /></View>;
}

function PrimaryButton({ label, onPress, disabled = false, compact = false, fullWidth = false }: { label: string; onPress: () => void; disabled?: boolean; compact?: boolean; fullWidth?: boolean }) { return <Pressable disabled={disabled} onPress={onPress} style={({ pressed }) => [styles.primaryButton, compact && styles.primaryButtonCompact, fullWidth && styles.buttonFull, disabled && styles.buttonDisabled, pressed && !disabled && styles.pressed]}><Text style={[styles.primaryButtonText, compact && styles.primaryButtonCompactText]}>{label}</Text></Pressable>; }
function GhostButton({ label, onPress, compact = false, fullWidth = false }: { label: string; onPress: () => void; compact?: boolean; fullWidth?: boolean }) { return <Pressable onPress={onPress} style={({ pressed }: { pressed: boolean }) => [styles.ghostButton, compact && styles.ghostButtonCompact, fullWidth && styles.buttonFull, pressed && styles.pressed]}><Text style={[styles.ghostButtonText, compact && styles.ghostButtonCompactText]}>{label}</Text></Pressable>; }
function SegmentButton({ active, label, onPress }: { active: boolean; label: string; onPress: () => void }) { return <Pressable onPress={onPress} style={({ pressed }: { pressed: boolean }) => [styles.segmentButton, active && styles.segmentButtonActive]}><Text style={[styles.segmentButtonText, active && styles.segmentButtonTextActive]}>{label}</Text></Pressable>; }
function FilterChip({ label, active, onPress }: { label: string; active: boolean; onPress: () => void }) { return <Pressable onPress={onPress} style={({ pressed }: { pressed: boolean }) => [styles.filterChip, active && styles.filterChipActive]}><Text style={[styles.filterChipText, active && styles.filterChipTextActive]}>{label}</Text></Pressable>; }
function Avatar({ name, small = false, large = false }: { name: string; small?: boolean; large?: boolean }) { const initials = name.split(' ').map((part: string) => part[0]).slice(0, 2).join('').toUpperCase(); return <View style={[styles.avatar, small && styles.avatarSmall, large && styles.avatarLarge]}><Text style={[styles.avatarText, small && styles.avatarTextSmall, large && styles.avatarTextLarge]}>{initials}</Text></View>; }
function EmptyState({ title, copy }: { title: string; copy: string }) { return <View style={styles.emptyState}><View style={styles.emptyIcon}><Text style={styles.emptyIconText}>⌕</Text></View><Text style={styles.emptyTitle}>{title}</Text><Text style={styles.emptyCopy}>{copy}</Text></View>; }
function screenTitle(screen: Screen): string { return ({ dashboard: 'Overview', claims: 'Claims', intake: 'New complaint', exchange: 'Warranty exchange', settings: 'Settings' })[screen]; }
function syncLabel(state: SyncState): string { return ({ synced: 'Synced', pending: 'Sync pending', failed: 'Sync needs retry', disabled: 'Demo mode' })[state]; }
function nextCaseNumber(type: ProductType): string { const now = new Date(); const prefix = type === 'battery' ? 'BAT' : 'UPS'; const period = `${String(now.getFullYear()).slice(-2)}${String(now.getMonth() + 1).padStart(2, '0')}`; const randomSuffix = Math.floor(Math.random() * 9000) + 1000; return `${prefix}-${period}-${randomSuffix}`; }
function makeUuid(): string { return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (token) => { const value = (Date.now() + Math.random() * 16) % 16 | 0; const nibble = token === 'x' ? value : (value & 0x3) | 0x8; return nibble.toString(16); }); }
function toAppUser(id: string, email: string | undefined, metadata: Record<string, unknown> | undefined): AppUser { return { id, name: typeof metadata?.full_name === 'string' ? metadata.full_name : email?.split('@')[0] || 'Team member', email: email || '', role: metadata?.role === 'admin' ? 'admin' : 'staff' }; }

async function upsertProfile(user: AppUser): Promise<void> {
  if (!supabase || !user.id) return;
  const row: ProfileRow = {
    id: user.id,
    email: user.email,
    full_name: user.name,
    role: user.role,
  };
  const { error } = await supabase.from('profiles').upsert(row, { onConflict: 'id' });
  if (error) console.error('Failed to sync profile:', error);
}

async function loadTeamMembers(): Promise<AppUser[]> {
  if (!supabase) return [];
  const { data, error } = await supabase.from('profiles').select('*').order('full_name', { ascending: true });
  if (error) {
    console.error('Failed to load team members:', error);
    return [];
  }
  const rows = (data as ProfileRow[]) || [];
  return rows.map((row) => ({
    id: row.id,
    name: row.full_name || row.email?.split('@')[0] || 'Team member',
    email: row.email,
    role: row.role === 'admin' ? 'admin' : 'staff',
  }));
}

const styles = StyleSheet.create({ // NOSONAR
  appShell: { flex: 1, backgroundColor: palette.canvas },
  appFrame: { flex: 1 },
  appFrameWide: { flexDirection: 'row', maxWidth: 1500, width: '100%', alignSelf: 'center', borderLeftWidth: 1, borderRightWidth: 1, borderColor: palette.line, backgroundColor: palette.surface },
  contentColumn: { flex: 1, minWidth: 0, backgroundColor: palette.canvas },
  scrollContent: { paddingHorizontal: 18, paddingTop: 14, paddingBottom: 112 },
  updateBanner: { backgroundColor: palette.forest, paddingVertical: 12, paddingHorizontal: 18, flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  updateBannerText: { color: palette.white, fontSize: 13, fontWeight: '700' },
  updateBannerAction: { color: palette.mint, fontSize: 13, fontWeight: '800' },
  updateIdText: { color: palette.muted, fontSize: 10, textAlign: 'center', marginTop: 10 },
  scrollContentWide: { paddingHorizontal: 42, paddingTop: 44, paddingBottom: 52 },
  pressed: { opacity: 0.78 }, 
  loadingScreen: { flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: palette.canvas, padding: 28 }, loadingMark: { width: 62, height: 62, borderRadius: 20, backgroundColor: palette.forest, alignItems: 'center', justifyContent: 'center' }, loadingMarkText: { fontSize: 31, fontWeight: '800', color: palette.white }, loadingSpinner: { marginTop: 24 }, loadingTitle: { marginTop: 16, color: palette.ink, fontSize: 18, fontWeight: '700' }, loadingCopy: { marginTop: 7, color: palette.muted, fontSize: 14, textAlign: 'center', maxWidth: 290, lineHeight: 20 },
  
  // AuthScreen styles
  authScreenShell: { flex: 1, backgroundColor: palette.canvas },
  authScreenKeyboardAvoiding: { flex: 1 },
  authScreenScroll: { flexGrow: 1, justifyContent: 'center', padding: 24 }, 
  authScreenHeader: { alignItems: 'center', paddingHorizontal: 16, paddingBottom: 32 }, 
  brandMark: { width: 64, height: 64, borderRadius: 22 },
  authTitle: { fontSize: 28, fontWeight: '800', color: palette.ink, marginTop: 16, textAlign: 'center' },
  authCopy: { fontSize: 15, color: palette.muted, textAlign: 'center', lineHeight: 22, maxWidth: 340, marginTop: 8 },
  authFeatureList: { marginTop: 24, gap: 12, alignSelf: 'stretch', paddingHorizontal: 16 },
  featureDotRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  featureDot: { width: 20, height: 20, borderRadius: 10, backgroundColor: palette.mint, alignItems: 'center', justifyContent: 'center' },
  featureDotTick: { color: palette.emerald, fontSize: 12, fontWeight: '800' },
  featureDotText: { color: palette.ink, fontSize: 13 },
  authFormContainer: { backgroundColor: palette.surface, borderRadius: 20, borderWidth: 1, borderColor: palette.line, padding: 20, gap: 16 },
  authCardTitle: { color: palette.ink, fontSize: 20, fontWeight: '800', textAlign: 'center' },
  authCardCopy: { color: palette.muted, fontSize: 13, textAlign: 'center', lineHeight: 19, marginTop: 4, marginBottom: 4 },
  segmented: { flexDirection: 'row', borderWidth: 1, borderColor: palette.line, borderRadius: 12, overflow: 'hidden' },
  authFieldGroup: { gap: 12 },
  segmentButton: { flex: 1, paddingVertical: 12, alignItems: 'center', backgroundColor: palette.canvas },
  segmentButtonActive: { backgroundColor: palette.forest },
  segmentButtonText: { color: palette.muted, fontWeight: '700', fontSize: 13 },
  segmentButtonTextActive: { color: palette.white },
  demoRoleBox: { backgroundColor: palette.canvas, borderRadius: 12, padding: 15 },
  smallLabel: { color: palette.muted, fontSize: 9.5, letterSpacing: 0.7, fontWeight: '800', marginBottom: 10 },
  roleRow: { flexDirection: 'row', gap: 10, marginBottom: 10 },
  roleChoice: { flex: 1, padding: 12, borderRadius: 10, borderWidth: 1, borderColor: palette.line, backgroundColor: palette.white },
  roleChoiceActive: { borderColor: palette.emerald, backgroundColor: palette.mint },
  roleChoiceTitle: { color: palette.ink, fontWeight: '800', fontSize: 13 },
  roleChoiceTitleActive: { color: palette.forest },
  roleChoiceCopy: { color: palette.muted, fontSize: 10.5, marginTop: 2 },
  roleChoiceCopyActive: { color: palette.emerald },
  helperText: { color: palette.muted, fontSize: 11, lineHeight: 16 },
  formMessage: { color: palette.rose, fontSize: 12.5, textAlign: 'center' },
  demoHint: { color: palette.muted, fontSize: 11, textAlign: 'center' },

  sidebar: { width: 262, backgroundColor: palette.surface, borderRightWidth: 1, borderColor: palette.line, padding: 26, paddingTop: 34, justifyContent: 'space-between' }, sidebarBrand: { flexDirection: 'row', alignItems: 'center', gap: 11 }, sidebarMark: { width: 38, height: 38, borderRadius: 12, backgroundColor: palette.forest, alignItems: 'center', justifyContent: 'center' }, sidebarMarkText: { color: palette.white, fontSize: 20, fontWeight: '800' }, sidebarBrandName: { fontSize: 16, color: palette.ink, fontWeight: '800', letterSpacing: -0.2 }, sidebarBrandSub: { fontSize: 11, color: palette.muted, marginTop: 1 }, sidebarNav: { flex: 1, paddingTop: 48, gap: 7 }, sidebarItem: { minHeight: 46, borderRadius: 12, flexDirection: 'row', alignItems: 'center', gap: 13, paddingHorizontal: 12 }, sidebarItemActive: { backgroundColor: palette.aqua }, sidebarIcon: { width: 18, color: palette.muted, textAlign: 'center', fontSize: 20, fontWeight: '600' }, sidebarIconActive: { color: palette.forest }, sidebarItemText: { color: palette.muted, fontWeight: '700', fontSize: 14 }, sidebarItemTextActive: { color: palette.forest }, sidebarUser: { borderTopWidth: 1, borderColor: palette.line, paddingTop: 18, flexDirection: 'row', alignItems: 'center', gap: 10 }, sidebarUserCopy: { flex: 1 }, sidebarUserName: { color: palette.ink, fontSize: 13, fontWeight: '800' }, sidebarUserRole: { color: palette.muted, fontSize: 11, marginTop: 2 }, sidebarChevron: { color: palette.muted, fontSize: 22 },
  mobileHeader: { height: 72, paddingHorizontal: 18, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', backgroundColor: palette.surface, borderBottomWidth: 1, borderColor: palette.line }, mobileBrandRow: { flexDirection: 'row', alignItems: 'center', gap: 10 }, mobileMark: { width: 34, height: 34, borderRadius: 10 }, mobileHeaderTitle: { color: palette.ink, fontWeight: '800', fontSize: 15 }, mobileHeaderSub: { color: palette.muted, fontSize: 10, marginTop: 1 }, bottomNav: { height: 74, position: 'absolute', bottom: 0, left: 0, right: 0, flexDirection: 'row', backgroundColor: palette.surface, borderTopWidth: 1, borderColor: palette.line, paddingHorizontal: 7, paddingTop: 7 }, bottomNavItem: { flex: 1, alignItems: 'center', gap: 2 }, bottomNavIconWrap: { minWidth: 35, height: 28, alignItems: 'center', justifyContent: 'center', borderRadius: 10 }, bottomNavIconWrapActive: { backgroundColor: palette.aqua }, bottomNavIcon: { color: palette.muted, fontSize: 18, fontWeight: '600' }, bottomNavIconActive: { color: palette.forest }, bottomNavLabel: { color: palette.muted, fontSize: 10, fontWeight: '600' }, bottomNavLabelActive: { color: palette.forest, fontWeight: '800' },
  desktopPageHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-start', gap: 22, marginBottom: 30 }, headerActions: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingTop: 6 }, screenHeading: { marginBottom: 25 }, eyebrow: { color: palette.emerald, fontSize: 11, fontWeight: '800', letterSpacing: 1.35 }, pageTitle: { color: palette.ink, fontSize: 30, lineHeight: 37, letterSpacing: -0.7, fontWeight: '800', marginTop: 7 }, pageSubtitle: { color: palette.muted, fontSize: 14.5, lineHeight: 21, marginTop: 7, maxWidth: 640 }, metricGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: 13, marginBottom: 18 }, metricCard: { flexGrow: 1, flexBasis: 160, minWidth: 150, backgroundColor: palette.surface, borderRadius: 17, padding: 17, borderWidth: 1, borderColor: palette.line }, metricIcon: { width: 31, height: 31, borderRadius: 10, alignItems: 'center', justifyContent: 'center', marginBottom: 16 }, metricIconText: { fontWeight: '800', fontSize: 17 }, metricLabel: { color: palette.muted, fontSize: 12, fontWeight: '700' }, metricValue: { color: palette.ink, fontSize: 29, lineHeight: 34, fontWeight: '800', letterSpacing: -0.8, marginTop: 4 }, metricDetail: { color: palette.muted, fontSize: 11.5, marginTop: 5 }, dashboardRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 18, marginBottom: 18 }, surface: { backgroundColor: palette.surface, borderWidth: 1, borderColor: palette.line, borderRadius: 18, padding: 20 }, activitySurface: { flexGrow: 1.4, flexBasis: 400 }, pipelineSurface: { flexGrow: 0.8, flexBasis: 300 }, surfaceHeader: { flexDirection: 'row', alignItems: 'flex-start', justifyContent: 'space-between', gap: 12, marginBottom: 18 }, sectionTitle: { color: palette.ink, fontSize: 16, fontWeight: '800', letterSpacing: -0.15 }, sectionCopy: { color: palette.muted, fontSize: 12.5, lineHeight: 18, marginTop: 4 }, liveDot: { flexDirection: 'row', alignItems: 'center', gap: 5, backgroundColor: palette.mint, borderRadius: 20, paddingHorizontal: 8, paddingVertical: 5 }, dot: { width: 6, height: 6, borderRadius: 3, backgroundColor: palette.emerald }, liveText: { color: palette.emerald, fontWeight: '800', fontSize: 9, letterSpacing: 0.5 }, quickActions: { gap: 8 }, quickAction: { minHeight: 65, borderWidth: 1, borderColor: palette.line, borderRadius: 13, flexDirection: 'row', alignItems: 'center', paddingHorizontal: 13, gap: 11 }, quickActionIcon: { width: 31, height: 31, borderRadius: 10, backgroundColor: palette.aqua, alignItems: 'center', justifyContent: 'center' }, quickActionIconText: { color: palette.forest, fontSize: 17, fontWeight: '800' }, quickActionCopy: { flex: 1 }, quickActionTitle: { color: palette.ink, fontWeight: '800', fontSize: 13 }, quickActionText: { color: palette.muted, fontSize: 11.5, marginTop: 2 }, quickActionArrow: { color: palette.muted, fontSize: 24 }, attentionStrip: { backgroundColor: palette.amberSoft, padding: 13, borderRadius: 12, flexDirection: 'row', alignItems: 'center', gap: 9, marginTop: 14 }, attentionIcon: { width: 20, height: 20, borderRadius: 10, overflow: 'hidden', textAlign: 'center', color: palette.white, backgroundColor: palette.amber, fontWeight: '800', lineHeight: 20 }, attentionCopy: { flex: 1 }, attentionTitle: { color: palette.amber, fontSize: 12.5, fontWeight: '800' }, attentionText: { color: '#8B641E', fontSize: 11, marginTop: 2, lineHeight: 15 }, attentionAction: { color: palette.amber, fontSize: 12, fontWeight: '800' }, miniNumber: { color: palette.forest, fontWeight: '800', fontSize: 12 }, mixBarRow: { marginTop: 15 }, mixBarLabelRow: { flexDirection: 'row', justifyContent: 'space-between', marginBottom: 7 }, mixBarLabel: { color: palette.ink, fontSize: 12.5, fontWeight: '700' }, mixBarValue: { color: palette.muted, fontSize: 11.5 }, mixTrack: { height: 8, backgroundColor: palette.canvas, borderRadius: 8, overflow: 'hidden' }, mixFill: { height: '100%', borderRadius: 8, minWidth: 8 }, statusMiniGrid: { flexDirection: 'row', justifyContent: 'space-between', borderTopWidth: 1, borderColor: palette.line, paddingTop: 16, marginTop: 20 }, miniStatus: { alignItems: 'center', minWidth: 62 }, miniStatusDot: { width: 7, height: 7, borderRadius: 4, marginBottom: 6 }, miniStatusValue: { color: palette.ink, fontSize: 19, fontWeight: '800' }, miniStatusLabel: { color: palette.muted, fontSize: 10.5, marginTop: 2 }, recentSurface: { marginBottom: 17 }, textLink: { color: palette.emerald, fontSize: 12.5, fontWeight: '800' }, tableHeader: { flexDirection: 'row', paddingHorizontal: 12, paddingBottom: 8, borderBottomWidth: 1, borderColor: palette.line }, tableHeaderText: { color: palette.muted, fontWeight: '800', letterSpacing: 0.65, fontSize: 9.5 }, tableClaim: { flex: 1.55, minWidth: 120 }, tableCustomer: { flex: 1.1, minWidth: 85 }, tableStatus: { width: 120 }, tableAge: { width: 35, alignItems: 'flex-end' }, claimTableRow: { minHeight: 63, flexDirection: 'row', alignItems: 'center', paddingHorizontal: 12, borderBottomWidth: 1, borderColor: palette.line }, tableClaimProduct: { color: palette.ink, fontSize: 12.5, fontWeight: '800' }, tableClaimSerial: { color: palette.muted, fontSize: 10.5, marginTop: 3 }, tableCustomerName: { color: palette.ink, fontSize: 12, fontWeight: '700' }, tableCustomerMobile: { color: palette.muted, fontSize: 10.5, marginTop: 3 }, tableAgeText: { color: palette.muted, fontSize: 12, textAlign: 'right' }, tableArrow: { color: palette.muted, width: 10, fontSize: 19, marginLeft: 5 }, syncCallout: { flexDirection: 'row', alignItems: 'center', gap: 12, backgroundColor: palette.aqua, borderRadius: 16, padding: 16 }, syncCalloutIcon: { width: 36, height: 36, borderRadius: 11, backgroundColor: palette.forest, alignItems: 'center', justifyContent: 'center' }, syncCalloutIconText: { color: palette.white, fontSize: 18, fontWeight: '800' }, syncCalloutBody: { flex: 1 }, syncCalloutTitle: { color: palette.forest, fontSize: 13, fontWeight: '800' }, syncCalloutCopy: { color: '#3B6F65', fontSize: 11.5, lineHeight: 16, marginTop: 3 },
  claimSearchSurface: { backgroundColor: palette.surface, borderRadius: 18, borderWidth: 1, borderColor: palette.line, padding: 13, marginBottom: 16 }, searchField: { minHeight: 49, flexDirection: 'row', alignItems: 'center', borderRadius: 12, backgroundColor: palette.canvas, paddingLeft: 14 }, searchIcon: { fontSize: 22, color: palette.muted, marginRight: 8 }, searchInput: { flex: 1, minWidth: 0, fontSize: 13.5, color: palette.ink, paddingVertical: 11 }, scanInlineButton: { flexDirection: 'row', alignItems: 'center', gap: 5, paddingHorizontal: 12, alignSelf: 'stretch', justifyContent: 'center', borderLeftWidth: 1, borderColor: palette.line }, scanInlineIcon: { color: palette.emerald, fontSize: 14 }, scanInlineText: { color: palette.emerald, fontSize: 12, fontWeight: '800' }, filterRow: { flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap', gap: 8, paddingTop: 12 }, filterChip: { paddingHorizontal: 12, paddingVertical: 7, borderRadius: 20, backgroundColor: palette.canvas }, filterChipActive: { backgroundColor: palette.forest }, filterChipText: { color: palette.muted, fontSize: 12, fontWeight: '700' }, filterChipTextActive: { color: palette.white }, resultCount: { color: palette.muted, fontSize: 11.5, marginLeft: 'auto' }, claimList: { gap: 10 }, claimListCard: { flexDirection: 'row', alignItems: 'center', backgroundColor: palette.surface, borderWidth: 1, borderColor: palette.line, borderRadius: 16, padding: 14, gap: 12 }, claimTypeMark: { width: 41, height: 41, borderRadius: 13, alignItems: 'center', justifyContent: 'center' }, claimTypeBattery: { backgroundColor: palette.mint }, claimTypeUps: { backgroundColor: palette.blueSoft }, claimTypeMarkText: { fontWeight: '800', fontSize: 15 }, claimTypeBatteryText: { color: palette.emerald }, claimTypeUpsText: { color: palette.blue }, claimListMain: { flex: 1, minWidth: 0 }, claimListTop: { flexDirection: 'row', justifyContent: 'space-between', gap: 9, alignItems: 'center' }, claimListProduct: { color: palette.ink, fontSize: 14, fontWeight: '800', flex: 1 }, claimListSerial: { color: palette.muted, fontSize: 11.5, marginTop: 3 }, claimListMeta: { flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap', gap: 5, marginTop: 7 }, claimListMetaText: { color: palette.muted, fontSize: 10.5 }, metaDivider: { color: '#AEB7B2', fontSize: 10 }, claimListArrow: { color: palette.muted, fontSize: 23 }, emptyState: { backgroundColor: palette.surface, borderRadius: 18, borderWidth: 1, borderColor: palette.line, alignItems: 'center', padding: 38 }, emptyIcon: { width: 42, height: 42, borderRadius: 14, backgroundColor: palette.aqua, alignItems: 'center', justifyContent: 'center' }, emptyIconText: { color: palette.forest, fontSize: 22 }, emptyTitle: { color: palette.ink, fontWeight: '800', fontSize: 16, marginTop: 15 }, emptyCopy: { color: palette.muted, fontSize: 12.5, lineHeight: 18, textAlign: 'center', maxWidth: 280, marginTop: 5 },
  intakeLayout: { flexDirection: 'row', gap: 23, alignItems: 'flex-start' }, intakeSteps: { width: 78, paddingTop: 14, gap: 25 }, stepRail: { alignItems: 'center', gap: 7 }, stepNumber: { width: 32, height: 32, borderRadius: 16, backgroundColor: palette.surface, borderWidth: 1, borderColor: palette.line, alignItems: 'center', justifyContent: 'center' }, stepNumberActive: { backgroundColor: palette.forest, borderColor: palette.forest }, stepNumberText: { color: palette.muted, fontSize: 10, fontWeight: '800' }, stepNumberTextActive: { color: palette.white }, stepText: { color: palette.muted, fontSize: 11, fontWeight: '700' }, stepTextActive: { color: palette.forest }, intakeContent: { flex: 1, minWidth: 0 }, intakeSectionHeader: { flexDirection: 'row', alignItems: 'flex-start', justifyContent: 'space-between', gap: 12, marginBottom: 17 }, intakeSectionTitle: { color: palette.ink, fontSize: 16, fontWeight: '800' }, productToggle: { flexDirection: 'row', gap: 10, flexWrap: 'wrap' }, productTypeButton: { flexGrow: 1, flexBasis: 210, minHeight: 76, flexDirection: 'row', alignItems: 'center', padding: 13, borderWidth: 1, borderColor: palette.line, borderRadius: 13, gap: 10 }, productTypeButtonActive: { borderColor: '#96CDC0', backgroundColor: '#F0FBF7' }, productTypeIcon: { width: 34, height: 34, borderRadius: 10, backgroundColor: palette.canvas, alignItems: 'center', justifyContent: 'center' }, productTypeIconActive: { backgroundColor: palette.mint }, productTypeIconText: { color: palette.muted, fontWeight: '800', fontSize: 14 }, productTypeIconTextActive: { color: palette.emerald }, productTypeTitle: { color: palette.ink, fontSize: 13, fontWeight: '800' }, productTypeTitleActive: { color: palette.forest }, productTypeCopy: { color: palette.muted, fontSize: 10.5, marginTop: 2 }, productTypeCopyActive: { color: palette.emerald }, radio: { width: 18, height: 18, borderRadius: 10, borderWidth: 1.5, borderColor: palette.line, marginLeft: 'auto', alignItems: 'center', justifyContent: 'center' }, radioActive: { borderColor: palette.emerald }, radioDot: { width: 9, height: 9, borderRadius: 5, backgroundColor: palette.emerald }, scanArea: { flexDirection: 'row', alignItems: 'center', gap: 12, backgroundColor: palette.aqua, borderRadius: 14, padding: 14, marginTop: 15, flexWrap: 'wrap' }, scanOrb: { width: 40, height: 40, backgroundColor: palette.forest, borderRadius: 13, alignItems: 'center', justifyContent: 'center' }, scanOrbIcon: { color: palette.white, fontSize: 20 }, scanAreaCopy: { flex: 1, minWidth: 160 }, scanAreaTitle: { color: palette.forest, fontSize: 13, fontWeight: '800' }, scanAreaText: { color: '#3B6F65', fontSize: 11, lineHeight: 15, marginTop: 2 }, orDivider: { flexDirection: 'row', alignItems: 'center', gap: 10, marginVertical: 17 }, divider: { height: 1, flex: 1, backgroundColor: palette.line }, orText: { color: palette.muted, letterSpacing: 0.8, fontWeight: '800', fontSize: 9.5 }, twoFieldGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: 12 }, detailsGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: 12 }, field: { flexGrow: 1, flexBasis: 210, gap: 5 }, fieldMultiline: { flexBasis: '100%', marginTop: 14 }, fieldLabel: { color: palette.muted, fontSize: 9.5, letterSpacing: 0.7, fontWeight: '800' }, textInput: { minHeight: 42, borderWidth: 1, borderColor: palette.line, backgroundColor: palette.white, color: palette.ink, fontSize: 13.5, borderRadius: 10, paddingHorizontal: 12, paddingVertical: 8 }, textArea: { height: 87, textAlignVertical: 'top' }, duplicateCheckRow: { marginTop: 16, flexDirection: 'row', gap: 12, alignItems: 'center', justifyContent: 'space-between', backgroundColor: palette.canvas, padding: 12, borderRadius: 11 }, duplicateCheckText: { flex: 1, color: palette.muted, fontSize: 11.5, lineHeight: 16 }, intakeSurfaceSpacing: { marginTop: 15 }, followupRow: { marginTop: 16, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 13, backgroundColor: palette.aqua, borderRadius: 12, padding: 13 }, followupCopy: { color: '#3B6F65', fontSize: 11, marginTop: 3 }, reminderStepper: { flexDirection: 'row', alignItems: 'center', backgroundColor: palette.white, borderRadius: 9, paddingRight: 10, borderWidth: 1, borderColor: '#B9DDD3' }, reminderInput: { width: 44, color: palette.forest, fontWeight: '800', fontSize: 15, textAlign: 'center', paddingVertical: 8 }, reminderSuffix: { color: palette.muted, fontSize: 11.5 }, formNotice: { marginTop: 15, flexDirection: 'row', alignItems: 'center', gap: 9, backgroundColor: palette.amberSoft, padding: 12, borderRadius: 12 }, formNoticeIcon: { backgroundColor: palette.amber, width: 18, height: 18, borderRadius: 9, overflow: 'hidden', color: palette.white, fontWeight: '800', textAlign: 'center', lineHeight: 18 }, formNoticeText: { color: '#805B1F', flex: 1, fontSize: 11.5, lineHeight: 16 }, intakeSubmit: { marginTop: 16, backgroundColor: palette.forest, borderRadius: 17, padding: 18, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 18, flexWrap: 'wrap' }, submitTitle: { color: palette.white, fontSize: 15, fontWeight: '800' }, submitCopy: { color: '#B8D7CF', fontSize: 11.5, lineHeight: 16, maxWidth: 440, marginTop: 4 },
  exchangeLayout: { flexDirection: 'row', alignItems: 'stretch', gap: 15, flexWrap: 'wrap' }, exchangeCard: { flexGrow: 1, flexBasis: 330, minWidth: 280 }, exchangeCardMuted: { opacity: 0.94 }, exchangeStepTop: { flexDirection: 'row', alignItems: 'center', gap: 11, marginBottom: 17 }, exchangeStepNumber: { width: 29, height: 29, borderRadius: 15, backgroundColor: palette.canvas, alignItems: 'center', justifyContent: 'center', borderWidth: 1, borderColor: palette.line }, exchangeStepNumberActive: { backgroundColor: palette.forest, borderColor: palette.forest }, exchangeStepNumberText: { color: palette.muted, fontWeight: '800', fontSize: 13 }, exchangeStepNumberTextActive: { color: palette.white }, exchangeSearchRow: { minHeight: 45, flexDirection: 'row', gap: 7, marginBottom: 16 }, exchangeInput: { flex: 1, minWidth: 0, color: palette.ink, fontSize: 13, borderWidth: 1, borderColor: palette.line, borderRadius: 10, paddingHorizontal: 11 }, exchangeScanButton: { backgroundColor: palette.aqua, alignItems: 'center', justifyContent: 'center', borderRadius: 10, paddingHorizontal: 10 }, exchangeScanText: { color: palette.emerald, fontSize: 11.5, fontWeight: '800' }, foundClaim: { backgroundColor: palette.aqua, borderRadius: 14, padding: 14 }, foundClaimTop: { flexDirection: 'row', justifyContent: 'space-between', gap: 8, alignItems: 'center' }, foundClaimProduct: { color: palette.forest, fontWeight: '800', fontSize: 15, marginTop: 13 }, foundClaimSerial: { color: '#3B6F65', fontSize: 12, marginTop: 3 }, foundClaimMeta: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: 5, marginTop: 10 }, foundClaimMetaText: { color: '#3B6F65', fontSize: 10.5 }, emptyFound: { minHeight: 112, borderRadius: 14, backgroundColor: palette.canvas, alignItems: 'center', justifyContent: 'center', padding: 15 }, emptyFoundIcon: { color: palette.muted, fontSize: 21 }, emptyFoundText: { color: palette.muted, fontSize: 11.5, marginTop: 5 }, exchangeConnector: { width: 30, alignItems: 'center', justifyContent: 'center', gap: 0 }, connectorLine: { width: 1, flex: 1, backgroundColor: palette.line }, connectorArrow: { width: 27, height: 27, borderRadius: 14, backgroundColor: palette.forest, alignItems: 'center', justifyContent: 'center' }, connectorArrowText: { color: palette.white, fontSize: 17, fontWeight: '800' }, scanReplacement: { flexDirection: 'row', alignItems: 'center', gap: 10, backgroundColor: palette.canvas, padding: 12, borderRadius: 12, marginBottom: 14, flexWrap: 'wrap' }, replacementIcon: { color: palette.forest, fontSize: 19 }, replacementCopy: { flex: 1, minWidth: 150 }, replacementTitle: { color: palette.ink, fontSize: 12.5, fontWeight: '800' }, replacementText: { color: palette.muted, fontSize: 10.5, marginTop: 2, lineHeight: 14 }, deliveryToggle: { flexDirection: 'row', gap: 10, alignItems: 'flex-start', backgroundColor: palette.aqua, padding: 12, borderRadius: 12, marginBottom: 14 }, checkbox: { width: 20, height: 20, borderWidth: 1.5, borderColor: '#9FCFC3', borderRadius: 6, backgroundColor: palette.white, alignItems: 'center', justifyContent: 'center' }, checkboxChecked: { backgroundColor: palette.emerald, borderColor: palette.emerald }, checkboxTick: { color: palette.white, fontWeight: '800', fontSize: 13 }, deliveryToggleTitle: { color: palette.forest, fontWeight: '800', fontSize: 12.5 }, deliveryToggleCopy: { color: '#3B6F65', fontSize: 10.5, lineHeight: 14, marginTop: 3, flexShrink: 1 }, exchangeSafety: { marginTop: 15, flexDirection: 'row', alignItems: 'center', gap: 8, backgroundColor: palette.mint, padding: 13, borderRadius: 12 }, exchangeSafetyIcon: { color: palette.emerald, fontWeight: '800', fontSize: 15 }, exchangeSafetyText: { color: '#287463', flex: 1, fontSize: 11.5, lineHeight: 16 },
  settingsGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: 16 }, accountSurface: { flexGrow: 1, flexBasis: 310 }, reminderSurface: { flexGrow: 1, flexBasis: 310 }, accountIdentity: { flexDirection: 'row', alignItems: 'center', gap: 13, marginTop: 18, marginBottom: 16 }, accountName: { color: palette.ink, fontSize: 16, fontWeight: '800' }, accountEmail: { color: palette.muted, fontSize: 11.5, marginTop: 3, marginBottom: 8 }, demoBanner: { backgroundColor: palette.amberSoft, padding: 11, borderRadius: 11, marginBottom: 15 }, demoBannerTitle: { color: palette.amber, fontWeight: '800', fontSize: 12 }, demoBannerText: { color: '#805B1F', fontSize: 10.5, lineHeight: 15, marginTop: 3 }, reminderSetting: { backgroundColor: palette.aqua, borderRadius: 15, padding: 16, marginVertical: 18, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }, reminderBigNumber: { color: palette.forest, fontSize: 34, lineHeight: 37, fontWeight: '800' }, reminderBigLabel: { color: '#3B6F65', fontSize: 11, marginTop: 3 }, policyInput: { width: 62, minHeight: 50, backgroundColor: palette.white, borderWidth: 1, borderColor: '#B9DDD3', borderRadius: 10, color: palette.forest, fontWeight: '800', fontSize: 20, textAlign: 'center' }, settingsSection: { marginTop: 16 }, syncStatusGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: 9 }, syncStatus: { flexGrow: 1, flexBasis: 128, padding: 13, borderRadius: 12 }, syncStatusValue: { fontSize: 16, fontWeight: '800' }, syncStatusLabel: { color: palette.muted, fontSize: 10.5, marginTop: 4 }, setupList: { marginTop: 18, gap: 11 }, setupLine: { flexDirection: 'row', alignItems: 'center', gap: 10 }, setupNumber: { width: 21, height: 21, borderRadius: 11, backgroundColor: palette.forest, alignItems: 'center', justifyContent: 'center' }, setupNumberText: { color: palette.white, fontWeight: '800', fontSize: 10 }, setupText: { color: palette.ink, fontSize: 12, lineHeight: 17, flex: 1 }, teamRows: { marginTop: 2 }, teamRow: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingVertical: 13, borderBottomWidth: 1, borderColor: palette.line }, teamAvatar: { width: 34, height: 34, borderRadius: 12, backgroundColor: palette.aqua, alignItems: 'center', justifyContent: 'center' }, teamAvatarText: { color: palette.forest, fontSize: 11, fontWeight: '800' }, teamInfo: { flex: 1 }, teamName: { color: palette.ink, fontSize: 13, fontWeight: '800' }, teamEmail: { color: palette.muted, fontSize: 10.5, marginTop: 2 }, teamRole: { paddingHorizontal: 10, paddingVertical: 7, borderRadius: 9, backgroundColor: palette.canvas }, teamRoleActive: { backgroundColor: palette.mint }, teamRoleText: { color: palette.muted, fontSize: 11, fontWeight: '800' }, teamRoleTextActive: { color: palette.emerald }, demoResetRow: { marginTop: 16, flexDirection: 'row', alignItems: 'center', gap: 12, justifyContent: 'space-between', backgroundColor: palette.surface, borderRadius: 14, borderWidth: 1, borderColor: palette.line, padding: 15 }, demoResetTitle: { color: palette.ink, fontSize: 13, fontWeight: '800' }, demoResetCopy: { color: palette.muted, fontSize: 11, marginTop: 3 },
  modalBackdrop: { flex: 1, backgroundColor: 'rgba(16, 30, 28, 0.46)', justifyContent: 'flex-end' }, modalDismissArea: { flex: 1 }, claimModal: { maxHeight: '88%', backgroundColor: palette.surface, borderTopLeftRadius: 25, borderTopRightRadius: 25, paddingTop: 9 }, modalHandle: { alignSelf: 'center', width: 39, height: 4, backgroundColor: '#CCD5CF', borderRadius: 4, marginBottom: 15 }, claimModalHeader: { flexDirection: 'row', justifyContent: 'space-between', gap: 10, paddingHorizontal: 21, paddingBottom: 17, borderBottomWidth: 1, borderColor: palette.line }, detailBadgeRow: { flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap', gap: 7, marginBottom: 11 }, detailProduct: { color: palette.ink, fontSize: 20, lineHeight: 25, fontWeight: '800', maxWidth: 310 }, detailSerial: { color: palette.muted, fontSize: 12.5, marginTop: 3 }, closeButton: { width: 32, height: 32, borderRadius: 16, backgroundColor: palette.canvas, alignItems: 'center', justifyContent: 'center' }, closeButtonText: { color: palette.muted, fontSize: 22, lineHeight: 25 }, claimModalScroll: { padding: 21, paddingBottom: 38 }, detailIdentity: { flexDirection: 'row', justifyContent: 'space-between', gap: 16, paddingBottom: 18, borderBottomWidth: 1, borderColor: palette.line }, detailLabel: { color: palette.muted, fontSize: 9.5, fontWeight: '800', letterSpacing: 0.75 }, detailValue: { color: palette.ink, fontSize: 14, fontWeight: '800', marginTop: 5 }, detailSubvalue: { color: palette.muted, fontSize: 11, marginTop: 3 }, detailNote: { backgroundColor: palette.canvas, padding: 13, borderRadius: 12, marginTop: 17 }, detailNoteText: { color: palette.ink, fontSize: 12.5, lineHeight: 18, marginTop: 6 }, detailSection: { marginTop: 21 }, detailSectionHeading: { flexDirection: 'row', justifyContent: 'space-between', gap: 10, alignItems: 'center' }, detailMeta: { color: palette.muted, fontSize: 10.5, textAlign: 'right' }, journey: { flexDirection: 'row', marginTop: 18 }, journeyItem: { flex: 1, alignItems: 'center', position: 'relative' }, journeyLine: { position: 'absolute', height: 2, backgroundColor: palette.line, top: 10, left: '50%', right: '-50%' }, journeyLineActive: { backgroundColor: palette.emerald }, journeyDot: { width: 21, height: 21, borderRadius: 11, backgroundColor: palette.canvas, borderWidth: 1, borderColor: palette.line, alignItems: 'center', justifyContent: 'center' }, journeyDotActive: { backgroundColor: palette.emerald, borderColor: palette.emerald }, journeyCheck: { color: palette.white, fontSize: 11, fontWeight: '800' }, journeyText: { color: palette.muted, fontSize: 9.5, textAlign: 'center', marginTop: 7, maxWidth: 74 }, journeyTextActive: { color: palette.ink, fontWeight: '800' }, statusActions: { marginTop: 21 }, statusActionRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 7, marginTop: 9 }, statusAction: { flexGrow: 1, paddingVertical: 9, paddingHorizontal: 9, borderRadius: 10, borderWidth: 1, borderColor: palette.line, alignItems: 'center' }, statusActionText: { color: palette.muted, fontSize: 10.5, fontWeight: '800' }, detailSpecs: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginTop: 11 }, detailSpec: { flexGrow: 1, flexBasis: 120, backgroundColor: palette.canvas, borderRadius: 11, padding: 11 }, detailSpecLabel: { color: palette.muted, fontSize: 9.5, fontWeight: '800', letterSpacing: 0.45 }, detailSpecValue: { color: palette.ink, fontSize: 12.5, fontWeight: '800', marginTop: 5 }, replacementRecord: { backgroundColor: palette.aqua, borderRadius: 13, padding: 13, marginTop: 20 }, replacementRecordName: { color: palette.forest, fontSize: 13, fontWeight: '800', marginTop: 6 }, replacementRecordSerial: { color: palette.emerald, fontSize: 12, marginTop: 3 }, replacementRecordCaption: { color: '#3B6F65', fontSize: 10.5, marginTop: 7 }, detailFooter: { marginTop: 21, paddingTop: 16, borderTopWidth: 1, borderColor: palette.line, flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  dialogBackdrop: { flex: 1, backgroundColor: 'rgba(16, 30, 28, 0.46)', padding: 20, alignItems: 'center', justifyContent: 'center' }, duplicateDialog: { width: '100%', maxWidth: 430, backgroundColor: palette.surface, borderRadius: 22, padding: 22, alignItems: 'center', gap: 13 }, duplicateIcon: { width: 44, height: 44, borderRadius: 14, backgroundColor: palette.amberSoft, alignItems: 'center', justifyContent: 'center' }, duplicateIconText: { color: palette.amber, fontSize: 22, fontWeight: '800' }, duplicateTitle: { color: palette.ink, fontSize: 20, fontWeight: '800', textAlign: 'center', letterSpacing: -0.3 }, duplicateCopy: { color: palette.muted, fontSize: 12.5, lineHeight: 18, textAlign: 'center' }, duplicateRecord: { width: '100%', backgroundColor: palette.canvas, borderRadius: 12, padding: 13, alignItems: 'flex-start', gap: 3 }, duplicateRecordCase: { color: palette.emerald, fontWeight: '800', fontSize: 11.5 }, duplicateRecordProduct: { color: palette.ink, fontWeight: '800', fontSize: 13.5, marginTop: 3 }, duplicateRecordSerial: { color: palette.muted, fontSize: 11.5, marginBottom: 4 }, dialogCancel: { color: palette.muted, fontSize: 12, fontWeight: '700', padding: 5 },
  scannerScreen: { flex: 1, backgroundColor: palette.ink }, scannerHeader: { padding: 22, flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-start' }, scannerTitle: { color: palette.white, fontSize: 22, fontWeight: '800' }, scannerCopy: { color: '#BFD0CA', fontSize: 12, marginTop: 4 }, scannerClose: { width: 36, height: 36, borderRadius: 18, backgroundColor: 'rgba(255,255,255,0.12)', alignItems: 'center', justifyContent: 'center' }, scannerCloseText: { color: palette.white, fontSize: 24, lineHeight: 27 }, cameraFrame: { margin: 18, marginTop: 8, flex: 1, minHeight: 270, backgroundColor: '#092B29', borderRadius: 24, overflow: 'hidden', justifyContent: 'center' }, camera: { flex: 1 }, cameraMessage: { flex: 1, justifyContent: 'center', alignItems: 'center', padding: 30, gap: 12 }, cameraMessageTitle: { color: palette.white, fontWeight: '800', fontSize: 16, textAlign: 'center' }, cameraMessageCopy: { color: '#BFD0CA', fontSize: 12, textAlign: 'center', lineHeight: 17 }, scanGuide: { position: 'absolute', width: 210, height: 210, alignSelf: 'center', top: '50%', marginTop: -105 }, guideCornerTopLeft: { position: 'absolute', top: 0, left: 0, width: 36, height: 36, borderTopWidth: 3, borderLeftWidth: 3, borderColor: palette.white, borderTopLeftRadius: 12 }, guideCornerTopRight: { position: 'absolute', top: 0, right: 0, width: 36, height: 36, borderTopWidth: 3, borderRightWidth: 3, borderColor: palette.white, borderTopRightRadius: 12 }, guideCornerBottomLeft: { position: 'absolute', bottom: 0, left: 0, width: 36, height: 36, borderBottomWidth: 3, borderLeftWidth: 3, borderColor: palette.white, borderBottomLeftRadius: 12 }, guideCornerBottomRight: { position: 'absolute', bottom: 0, right: 0, width: 36, height: 36, borderBottomWidth: 3, borderRightWidth: 3, borderColor: palette.white, borderBottomRightRadius: 12 }, manualScanEntry: { backgroundColor: palette.surface, borderTopLeftRadius: 24, borderTopRightRadius: 24, padding: 22, gap: 10 }, manualScanRow: { flexDirection: 'row', gap: 8, alignItems: 'center' }, manualScanInput: { flex: 1, minWidth: 0, backgroundColor: palette.canvas, borderRadius: 10, color: palette.ink, fontSize: 12.5, paddingHorizontal: 11, paddingVertical: 11 }, manualScanHint: { color: palette.muted, fontSize: 10.5, lineHeight: 15 },
buttonFull: { width: '100%' }, buttonDisabled: { opacity: 0.42 }, avatar: { width: 37, height: 37, borderRadius: 13, backgroundColor: palette.forest, alignItems: 'center', justifyContent: 'center' }, avatarSmall: { width: 35, height: 35, borderRadius: 12 }, avatarLarge: { width: 52, height: 52, borderRadius: 17 }, avatarText: { color: palette.white, fontSize: 11, fontWeight: '800' }, avatarTextSmall: { fontSize: 10.5 }, avatarTextLarge: { fontSize: 15 }, badge: { alignSelf: 'flex-start', borderRadius: 20, paddingHorizontal: 8, paddingVertical: 5 }, badgeText: { fontWeight: '800', fontSize: 10, lineHeight: 12 }, primaryButton: { minHeight: 42, justifyContent: 'center', alignItems: 'center', borderRadius: 11, backgroundColor: palette.forest, paddingHorizontal: 15 }, primaryButtonCompact: { minHeight: 36, borderRadius: 9, paddingHorizontal: 12 }, primaryButtonText: { color: palette.white, fontSize: 12.5, fontWeight: '800' }, primaryButtonCompactText: { fontSize: 11.5 }, ghostButton: { minHeight: 42, justifyContent: 'center', alignItems: 'center', borderRadius: 11, borderWidth: 1, borderColor: palette.line, backgroundColor: palette.surface, paddingHorizontal: 15 }, ghostButtonCompact: { minHeight: 36, borderRadius: 9, paddingHorizontal: 11 }, ghostButtonText: { color: palette.forest, fontSize: 12.5, fontWeight: '800' }, ghostButtonCompactText: { fontSize: 11.5 },
  attachmentsSection: { marginTop: 16, backgroundColor: palette.surface, borderWidth: 1, borderColor: palette.line, borderRadius: 18, padding: 20 },
  attachmentsHeader: { marginBottom: 12 },
  attachmentsList: { marginTop: 8, gap: 8 },
  attachmentRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 10, padding: 10, borderRadius: 11, backgroundColor: palette.canvas },
  attachmentLabel: { flex: 1, color: palette.ink, fontSize: 12.5, fontWeight: '700' },
  syncControls: { marginTop: 4 },
  syncButtonRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 10, marginTop: 12 },
  syncMessage: { marginTop: 10, color: palette.forest, fontSize: 12, fontWeight: '700' },
  modelTableHeader: { flexDirection: 'row', backgroundColor: palette.canvas, borderRadius: 10, paddingVertical: 10, paddingHorizontal: 12, marginTop: 14 },
modelTableCell: { flex: 1, minWidth: 80, color: palette.ink, fontSize: 12, fontWeight: '700' },
  modelTableCellActions: { flex: 1.4, flexDirection: 'row', gap: 8, alignItems: 'center' },
  modelRow: { flexDirection: 'row', alignItems: 'center', paddingVertical: 12, paddingHorizontal: 12, borderBottomWidth: 1, borderColor: palette.line },
  attachmentPreviewGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: 10, marginTop: 11 },
  attachmentPreviewCard: { width: 120, backgroundColor: palette.canvas, borderRadius: 12, padding: 8 },
  attachmentPreviewImage: { width: '100%', height: 84, borderRadius: 8, backgroundColor: palette.line },
  attachmentPreviewLabel: { color: palette.ink, fontSize: 10.5, fontWeight: '700', marginTop: 6 },
});
