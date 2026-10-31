import { BodyTooLargeError, readResponseTextWithLimit } from '../http/boundedBody.js';

const ENDPOINT = 'https://app.chargecloud.de/emobility:ocpi/16551d48ed6c048085c5e8bccd34b0c7/app/2.0/locations';
export type ChargecloudFetch = (input: string | URL, init?: RequestInit) => Promise<Response>;
export type ChargecloudErrorKind = 'request' | 'not_found' | 'dependency' | 'timeout' | 'contract' | 'rate_limit';
export class ChargecloudError extends Error {
  constructor(
    readonly kind: ChargecloudErrorKind,
    readonly status: number,
  ) {
    super(`Chargecloud ${kind} failure`);
    this.name = 'ChargecloudError';
  }
}
export interface ChargecloudEnvelope {
  data: unknown[];
  timestamp: string;
}
const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
export function validTimestamp(v: unknown): v is string {
  if (typeof v !== 'string' || v.length > 40) return false;
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(Z|[+-]\d{2}:\d{2})$/.exec(v);
  if (!match || Number.isNaN(Date.parse(v))) return false;
  const [, year, month, day, hour, minute, second, zone] = match;
  const y = Number(year),
    m = Number(month),
    d = Number(day);
  const calendar = new Date(0);
  calendar.setUTCFullYear(y, m - 1, d);
  if (calendar.getUTCFullYear() !== y || calendar.getUTCMonth() !== m - 1 || calendar.getUTCDate() !== d) return false;
  if (Number(hour) > 23 || Number(minute) > 59 || Number(second) > 59) return false;
  return zone === 'Z' || (Number(zone.slice(1, 3)) <= 23 && Number(zone.slice(4, 6)) <= 59);
}
export class ChargecloudClient {
  constructor(
    private readonly fetchImpl: ChargecloudFetch = fetch,
    private readonly timeoutMs = 25_000,
  ) {}
  async locations(evseId?: string): Promise<ChargecloudEnvelope> {
    const url = new URL(ENDPOINT);
    if (evseId !== undefined) url.searchParams.set('evse', evseId);
    const controller = new AbortController();
    let response: Response | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        controller.abort();
        reject(new ChargecloudError('timeout', 504));
      }, this.timeoutMs);
    });
    const request = async (): Promise<ChargecloudEnvelope> => {
      try {
        response = await this.fetchImpl(url, {
          signal: controller.signal,
          redirect: 'error',
          headers: { Accept: 'application/json' },
        });
        if (response.status === 429) throw new ChargecloudError('rate_limit', 429);
        if (!response.ok || response.redirected || (response.status >= 300 && response.status < 400))
          throw new ChargecloudError('dependency', 502);
        const raw: unknown = JSON.parse(
          await readResponseTextWithLimit(response, evseId === undefined ? 32 * 1024 * 1024 : 1024 * 1024),
        );
        if (
          !isRecord(raw) ||
          !Array.isArray(raw['data']) ||
          raw['status_code'] !== 1000 ||
          typeof raw['status_message'] !== 'string' ||
          raw['status_message'].length > 512 ||
          !validTimestamp(raw['timestamp'])
        )
          throw new ChargecloudError('contract', 502);
        return { data: raw['data'], timestamp: raw['timestamp'] };
      } catch (error) {
        if (error instanceof ChargecloudError) throw error;
        if (controller.signal.aborted) throw new ChargecloudError('timeout', 504);
        if (error instanceof BodyTooLargeError || error instanceof SyntaxError)
          throw new ChargecloudError('contract', 502);
        throw new ChargecloudError('dependency', 502);
      }
    };
    try {
      return await Promise.race([request(), timeout]);
    } finally {
      if (timer) clearTimeout(timer);
      controller.abort();
      // Error and declared-size paths can reject before reading the stream.
      // Cancel it as well as aborting fetch; cleanup must not extend the deadline.
      if (response?.body && !response.body.locked) void response.body.cancel().catch(() => undefined);
    }
  }
}
