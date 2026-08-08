import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import '@/index.css';
import { PlayerApp } from './player-app';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <PlayerApp />
  </StrictMode>,
);
