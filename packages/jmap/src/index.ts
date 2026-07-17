// biome-ignore lint/performance/noBarrelFile: package entry point requires re-exports
export { type BlobDownloadParams, blobDownload, blobDownloadUrl } from './blob.ts'
export {
  type EmailChangesParams,
  type EmailGetDetailParams,
  type EmailGetParams,
  type EmailQueryFilters,
  type EmailQueryParams,
  type EmailQueryPerTermParams,
  type EmailSetChanges,
  type EmailSetParams,
  type EmailStateParams,
  emailChanges,
  emailGet,
  emailGetDetail,
  emailQuery,
  emailQueryPerTerm,
  emailSet,
  emailState,
  type MailboxCreateParams,
  type MailboxIdByNameParams,
  type MailboxIdByRoleParams,
  type MailboxIdsByRolesParams,
  mailboxCreate,
  mailboxIdByName,
  mailboxIdByRole,
  mailboxIdsByRoles,
  type ThreadEmailIdsParams,
  threadEmailIds,
} from './email.ts'
export { LABEL_KEYWORD_PREFIX, toLabelKeyword } from './keywords.ts'
export { type JmapLive, makeJmapLive } from './live.ts'
export { accountIdForMail, bearerAuthorization, fetchSession, JmapError } from './session.ts'
export {
  type AuthServiceConfig,
  fetchStalwartCredential,
  type StalwartCredential,
  StalwartCredentialError,
} from './stalwart-credential.ts'
export type {
  EmailAddress,
  EmailBodyPart,
  EmailBodyValue,
  EmailChangesResult,
  EmailDetailRecord,
  EmailRecord,
  JmapSession,
  MailboxRecord,
  ThreadRecord,
} from './types.ts'
