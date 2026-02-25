import { createHash } from 'node:crypto'

export const hashEmail = (email: string): string =>
  createHash('sha256').update(email.toLowerCase()).digest('hex').slice(0, 12)
