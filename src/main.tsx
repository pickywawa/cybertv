import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import './styles/app.css';
import { App } from './app/App';
import { boot } from './app/services';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
void boot();
