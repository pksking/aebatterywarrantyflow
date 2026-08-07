import { serve } from 'https://deno.land/std@0.177.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { corsHeaders } from '../_shared/cors.ts';

// Expo's push notification library
import Expo from 'https://esm.sh/expo-server-sdk@3.7.0';

interface Claim {
  id: string;
  productType: 'battery' | 'ups';
  productName: string;
  customerName: string;
  createdBy: string; // This is the user ID of the person who created the claim
}

serve(async (req: Request) => {
  // This is needed for CORS requests from the browser.
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders });
  }

  try {
    const { claim } = (await req.json()) as { claim: Claim };

    // Create a Supabase client with the service_role key to bypass RLS.
    // This is secure because this code runs on Supabase's servers.
    const supabaseAdmin = createClient(
      Deno.env.get('SUPABASE_URL') ?? '',
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''
    );

    // Get the push tokens of all 'admin' and 'staff' users,
    // except for the user who created the complaint.
    const { data: users, error: userError } = await supabaseAdmin
      .from('profiles')
      .select('push_token')
      .in('role', ['admin', 'staff'])
      .not('id', 'eq', claim.createdBy) // Don't send a notification to the creator
      .not('push_token', 'is', null);   // Only get users who have a push token

    if (userError) {
      throw userError;
    }

    const expo = new Expo();
    const messages = [];
    const notificationTitle = `New ${claim.productType.toUpperCase()} Complaint`;
    const notificationBody = `${claim.productName} from ${claim.customerName}`;

    for (const user of users) {
      // Check if the token is a valid Expo push token
      if (user.push_token && Expo.isExpoPushToken(user.push_token)) {
        messages.push({
          to: user.push_token,
          sound: 'default',
          title: notificationTitle,
          body: notificationBody,
          data: { screen: 'claims' }, // This tells the app to go to the claims screen on tap
        });
      }
    }

    // The Expo push notification service can send messages in chunks.
    if (messages.length > 0) {
      const chunks = expo.chunkPushNotifications(messages);
      const invalidTokens: string[] = [];

      for (const chunk of chunks) {
        const receipts = await expo.sendPushNotificationsAsync(chunk);

        // Check for errors and collect invalid tokens
        receipts.forEach((receipt, index) => {
          if (receipt.status === 'error' && receipt.details?.error === 'DeviceNotRegistered') {
            // The token is invalid, so we should stop sending notifications to it.
            // We collect it here to remove it from the database later.
            const message = chunk[index];
            if (typeof message.to === 'string') {
              invalidTokens.push(message.to);
            }
          }
        });
      }

      // If there are any invalid tokens, remove them from the database.
      if (invalidTokens.length > 0) {
        await supabaseAdmin.from('profiles').update({ push_token: null }).in('push_token', invalidTokens);
      }
    }

    return new Response(JSON.stringify({ message: `Notifications sent to ${messages.length} users.` }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      status: 200,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'An unknown error occurred';
    return new Response(JSON.stringify({ error: message }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      status: 400,
    });
  }
});
