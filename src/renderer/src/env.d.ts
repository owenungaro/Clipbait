/// <reference types="vite/client" />

import type { ClipbaitApi } from '../../preload'

declare global {
  interface Window {
    clipbait: ClipbaitApi
  }
}

export {}
