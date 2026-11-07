/**
 * 中转站相关的错误类型。
 *
 * 单独一个文件是为了**不让 client.ts 与 errors 之间成环**:
 * runner / compile 都要 instanceof 判断它,而 client 自己也要抛它。
 * 挂在 Error 上的 status 只在 404/405 之类的分支判断里用到,其余地方忽略即可。
 */
export class RelayError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = 'RelayError';
  }
}

/** 是否「用户主动取消」(DOMException 的 AbortError,跨 realm 只认 name)。 */
export function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError';
}
