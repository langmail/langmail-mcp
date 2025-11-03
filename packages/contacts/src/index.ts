// Main repository class

export type { EmailMetadataContact } from './ContactRepository.js'
export { ContactRepository } from './ContactRepository.js'

// Type exports
export type { ContactData, ContactType, NormalizedContactData } from './types/index.js'

// Utility exports
export {
  extractDisplayNameFromSender,
  extractDomainFromEmail,
  extractEmailFromSender,
  isValidEmail,
  normalizeContactData,
} from './utils/email-parser.js'
