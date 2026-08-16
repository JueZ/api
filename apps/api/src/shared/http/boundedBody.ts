export class BodyTooLargeError extends Error {
  constructor(readonly maxBytes: number) {
    super(`Body exceeds the ${maxBytes}-byte limit.`);
    this.name = 'BodyTooLargeError';
  }
}

export const AUTHENTICATED_PROVIDER_JSON_BODY_MAX_BYTES = 64 * 1024;

export async function readResponseTextWithLimit(response: Response, maxBytes: number): Promise<string> {
  assertDeclaredLength(response.headers, maxBytes);
  return readStreamTextWithLimit(response.body, maxBytes);
}

export async function readRequestTextWithLimit(request: RequestLike, maxBytes: number): Promise<string> {
  assertDeclaredLength(request.headers, maxBytes);
  return readStreamTextWithLimit(request.body, maxBytes);
}

export async function readRequestJsonWithLimit<T>(request: RequestLike, maxBytes: number): Promise<T> {
  return JSON.parse(await readRequestTextWithLimit(request, maxBytes)) as T;
}

interface RequestLike {
  headers: Headers;
  body: ReadableStream<Uint8Array> | null;
}

function assertDeclaredLength(headers: Headers, maxBytes: number): void {
  const rawLength = headers.get('content-length');
  if (rawLength === null) return;
  const length = Number(rawLength);
  if (Number.isFinite(length) && length > maxBytes) throw new BodyTooLargeError(maxBytes);
}

async function readStreamTextWithLimit(body: ReadableStream<Uint8Array> | null, maxBytes: number): Promise<string> {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) throw new Error('maxBytes must be a positive integer.');
  if (!body) return '';

  const reader = body.getReader();
  const decoder = new TextDecoder('utf-8', { fatal: false });
  let text = '';
  let totalBytes = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      totalBytes += value.byteLength;
      if (totalBytes > maxBytes) {
        await reader.cancel().catch(() => undefined);
        throw new BodyTooLargeError(maxBytes);
      }
      text += decoder.decode(value, { stream: true });
    }
    return text + decoder.decode();
  } finally {
    reader.releaseLock();
  }
}
