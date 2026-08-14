declare module 'expo-notifications' {
  export * from 'expo-notifications/src/index';

  // Add explicit type definitions for members that are not being found
  export interface NotificationResponse {
    notification: {
      request: {
        content: {
          data?: unknown;
        };
      };
    };
  }
  export type NotificationTriggerInput = any;
}

declare module 'expo-updates' {
  export * from 'expo-updates/src/index';
  export type UseUpdatesReturnType = any;
}

declare const __DEV__: boolean;