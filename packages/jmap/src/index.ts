// biome-ignore lint/performance/noBarrelFile: package entry point requires re-exports
export { type BlobDownloadParams, type BlobUploadParams, blobDownload, blobDownloadUrl, blobUpload } from './blob.ts'
export {
  type EmailChangesParams,
  type EmailFilter,
  type EmailFilterCondition,
  type EmailGetDetailParams,
  type EmailGetParams,
  type EmailQueryFilterParams,
  type EmailQueryFilters,
  type EmailQueryParams,
  type EmailQueryPerTermParams,
  type EmailSetChanges,
  type EmailSetManyParams,
  type EmailSetManyResult,
  type EmailSetParams,
  type EmailStateParams,
  emailChanges,
  emailGet,
  emailGetDetail,
  emailQuery,
  emailQueryFilter,
  emailQueryPerTerm,
  emailSet,
  emailSetMany,
  emailState,
  type MailboxCreateParams,
  type MailboxIdByNameParams,
  type MailboxIdByRoleParams,
  type MailboxIdsByRolesParams,
  mailboxCreate,
  mailboxIdByName,
  mailboxIdByNameOrRole,
  mailboxIdByRole,
  mailboxIdsByRoles,
  mailboxNames,
  roleForPlaceName,
  type ThreadEmailIdsParams,
  type ThreadExpandParams,
  threadEmailIds,
  threadsExpandEmailIds,
} from './email.ts'
export { LABEL_KEYWORD_PREFIX, toLabelKeyword } from './keywords.ts'
export { type JmapLive, makeJmapLive } from './live.ts'
export { accountIdForMail, accountIdForSieve, bearerAuthorization, fetchSession, JmapError } from './session.ts'
export {
  type SieveScriptCreateParams,
  type SieveScriptListParams,
  type SieveScriptRecord,
  type SieveScriptUpdateParams,
  sieveScriptCreate,
  sieveScriptList,
  sieveScriptUpdate,
} from './sieve.ts'
export {
  type AuthServiceConfig,
  fetchStalwartCredential,
  type StalwartCredential,
  StalwartCredentialError,
} from './stalwart-credential.ts'
export { jmapTimeoutSignal } from './timeout.ts'
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
