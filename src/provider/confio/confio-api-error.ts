/**
 * A non-404 failure answered by ConfioPagos. The message carries the HTTP status only, never the
 * response body, which can hold buyer data; `providerCode` is the `code` field of that body.
 */
export class ConfioApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly providerCode?: string,
  ) {
    super(message)
  }
}
