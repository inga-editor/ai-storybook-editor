import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import '@/index.css';
import { RemixEditorApp } from './remix-editor-app';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <RemixEditorApp />
  </StrictMode>,
);
