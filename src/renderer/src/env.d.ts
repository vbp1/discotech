import type { DiscotechApi } from '../../shared/api'

declare global {
  interface Window {
    discotech: DiscotechApi
  }
}
