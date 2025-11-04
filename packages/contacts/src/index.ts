// Main repository class

// Re-export email parsing utilities from email-preprocess
export {
  extractDisplayNameFromSender,
  extractDomainFromEmail,
  extractEmailFromSender,
  isValidEmail,
  normalizeContactData,
} from '@ludwig/email-preprocess'
export type { EmailMetadataContact } from './ContactRepository.js'
export { ContactRepository } from './ContactRepository.js'
// Type exports
export type { ContactData, ContactType, NormalizedContactData } from './types/index.js'
