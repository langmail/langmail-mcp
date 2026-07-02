// biome-ignore lint/performance/noBarrelFile: package entry point requires re-exports
export {
  type EmailChangesParams,
  type EmailGetDetailParams,
  type EmailGetParams,
  type EmailQueryFilters,
  type EmailQueryParams,
  type EmailSetChanges,
  type EmailSetParams,
  emailChanges,
  emailGet,
  emailGetDetail,
  emailQuery,
  emailSet,
  type MailboxCreateParams,
  type MailboxIdByNameParams,
  type MailboxIdByRoleParams,
  mailboxCreate,
  mailboxIdByName,
  mailboxIdByRole,
  type ThreadEmailIdsParams,
  threadEmailIds,
} from './email.ts'
export { LABEL_KEYWORD_PREFIX, toLabelKeyword } from './keywords.ts'
export { type JmapLive, makeJmapLive } from './live.ts'
export { accountIdForMail, bearerAuthorization, fetchSession, JmapError } from './session.ts'
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
