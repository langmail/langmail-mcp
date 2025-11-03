// Main repository class
export { ContactRepository } from './ContactRepository.js'
export type { EmailMetadataContact } from './ContactRepository.js'

// Type exports
export type { ContactData, NormalizedContactData, ContactType } from './types/index.js'

// Utility exports
export {
  extractEmailFromSender,
  extractDisplayNameFromSender,
  extractDomainFromEmail,
  isValidEmail,
  normalizeContactData,
} from './utils/email-parser.js'
