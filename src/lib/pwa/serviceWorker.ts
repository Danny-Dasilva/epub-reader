/**
 * Service Worker registration utilities for PWA support
 */

export function registerServiceWorker(): void {
  if (typeof window === 'undefined' || !('serviceWorker' in navigator)) {
    return;
  }

  window.addEventListener('load', async () => {
    try {
      const registration = await navigator.serviceWorker.register('/sw.js', {
        scope: '/',
      });

      console.log('Service Worker registered:', registration.scope);

      // Check for updates
      registration.addEventListener('updatefound', () => {
        const newWorker = registration.installing;
        if (!newWorker) return;

        newWorker.addEventListener('statechange', () => {
          if (newWorker.state === 'installed' && navigator.serviceWorker.controller) {
            // New content available, prompt for refresh
            if (window.confirm('New version available! Reload to update?')) {
              newWorker.postMessage({ type: 'SKIP_WAITING' });
              window.location.reload();
            }
          }
        });
      });
    } catch (error) {
      console.error('Service Worker registration failed:', error);
    }
  });
}

export function unregisterServiceWorker(): Promise<boolean> {
  if (typeof window === 'undefined' || !('serviceWorker' in navigator)) {
    return Promise.resolve(false);
  }

  return navigator.serviceWorker.ready.then((registration) => {
    return registration.unregister();
  });
}

// Check if the app can be installed (PWA)
export function canInstallPWA(): boolean {
  return typeof window !== 'undefined' && 'BeforeInstallPromptEvent' in window;
}

// Store the install prompt for later use
let deferredPrompt: any = null;

export function setupInstallPrompt(
  onCanInstall: () => void,
  onInstalled: () => void
): () => void {
  if (typeof window === 'undefined') {
    return () => {};
  }

  const handleBeforeInstall = (e: Event) => {
    e.preventDefault();
    deferredPrompt = e;
    onCanInstall();
  };

  const handleAppInstalled = () => {
    deferredPrompt = null;
    onInstalled();
  };

  window.addEventListener('beforeinstallprompt', handleBeforeInstall);
  window.addEventListener('appinstalled', handleAppInstalled);

  return () => {
    window.removeEventListener('beforeinstallprompt', handleBeforeInstall);
    window.removeEventListener('appinstalled', handleAppInstalled);
  };
}

export async function promptInstall(): Promise<boolean> {
  if (!deferredPrompt) {
    return false;
  }

  deferredPrompt.prompt();
  const { outcome } = await deferredPrompt.userChoice;
  deferredPrompt = null;

  return outcome === 'accepted';
}
