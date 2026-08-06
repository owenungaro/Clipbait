import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { Overlay } from './Overlay'
import '../styles/tokens.css'
import '../styles/app.css'
import '../styles/overlay.css'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <Overlay />
  </StrictMode>
)
