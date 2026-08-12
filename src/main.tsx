import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.tsx'
import { setRemixDataGateway } from '@/stores/remix-store/gateway/remix-data-gateway'
import { supabaseRemixGateway } from '@/stores/remix-store/gateway/supabase-remix-gateway'

// Install the editor's remix data-access impl (direct RLS Supabase) before any
// store runs. The Remix Editor sub-app installs `HttpRemixGateway` at its own root.
setRemixDataGateway(supabaseRemixGateway)

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
