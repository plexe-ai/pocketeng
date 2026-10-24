import { notFound } from 'next/navigation'
import PasteSmokeClient from './PasteSmokeClient'

/** Dev-only: real-browser paste smoke test target (`npm run test:paste-e2e`). */
export default function PasteSmokePage() {
  if (process.env.NODE_ENV === 'production') {
    notFound()
  }
  return <PasteSmokeClient />
}
