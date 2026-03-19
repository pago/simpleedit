import type { SimpleEditAPI } from './index'

declare global {
  interface Window {
    api: SimpleEditAPI
  }
}
