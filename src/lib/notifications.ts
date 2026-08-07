import { supabase } from './supabase';
import { Claim } from '../types';

/**
 * Triggers a push notification to other team members about a new claim.
 * This function invokes a Supabase Edge Function named 'new-claim-notification'.
 *
 * @param claim The newly created claim.
 */
export async function sendNewClaimNotification(claim: Claim): Promise<void> {
  if (!supabase) {
    console.log('Supabase not configured. Skipping new claim notification.');
    return;
  }

  // This will call the 'new-claim-notification' Edge Function in your Supabase project.
  await supabase.functions.invoke('new-claim-notification', { body: { claim } });
}