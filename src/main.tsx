import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import './styles/app.css';
import { App } from './app/App';
import { boot } from './app/services';
import { registerImageCache } from './core/images';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
void boot();
registerImageCache();

// on-device debugging builds only (VITE_DEBUG=1, never in a published release)
if (import.meta.env.VITE_DEBUG) {
  void Promise.all([import('./state/store'), import('./app/services'), import('./core/workers'), import('./core/native')]).then(([store, services, workers, native]) => {
    (window as unknown as { __cyber: unknown }).__cyber = { useApp: store.useApp, services, workers, native };
  });
}
