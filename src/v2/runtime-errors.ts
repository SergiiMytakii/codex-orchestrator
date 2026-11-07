/** Infrastructure unavailability must not be confused with invalid or unsafe evidence. */
export function isRetryableInfrastructureError(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  if (typeof code === 'string' && ['EIO', 'ENOENT', 'EAGAIN', 'EINTR', 'ENOSPC', 'EMFILE', 'ENFILE', 'EBUSY', 'ETIMEDOUT', 'ECONNRESET', 'ENETUNREACH', 'ECONNREFUSED', 'EAI_AGAIN', 'EPIPE'].includes(code)) return true;
  return error instanceof Error && /^(?:git failed:|report read-view inventory failed:)/u.test(error.message);
}
