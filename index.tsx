import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import ErrorBoundary from './components/ErrorBoundary';
import { registerServiceWorker } from './lib/push';

const rootElement = document.getElementById('root');
if (!rootElement) {
  throw new Error("Could not find root element to mount to");
}

const root = ReactDOM.createRoot(rootElement);
root.render(
  <React.StrictMode>
    <ErrorBoundary>
        <App />
    </ErrorBoundary>
  </React.StrictMode>
);

// PWA / Web Push: Service Worker kaydı (HTTPS veya localhost gereklidir)
if (typeof window !== 'undefined' && 'serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    registerServiceWorker().catch((err) =>
      console.error('[SW] Kayıt başarısız:', err)
    );
  });

  // SW notificationclick → ana pencereye NAVIGATE mesajı gönderir
  navigator.serviceWorker?.addEventListener('message', (event) => {
    const data = event.data || {};
    if (data.type === 'NAVIGATE' && typeof data.url === 'string') {
      try {
        const url = new URL(data.url, window.location.origin);
        if (url.hash) {
          window.location.hash = url.hash;
        } else if (url.pathname && url.pathname !== window.location.pathname) {
          window.location.assign(url.toString());
        }
      } catch {
        /* ignore */
      }
    }
  });
}
