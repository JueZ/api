import { ChargecloudClient, ChargecloudError, validTimestamp } from './client.js';
import { chargecloudGetInputSchema, chargecloudListInputSchema } from './types.js';
import type {
  ChargecloudConnector,
  ChargecloudGetInput,
  ChargecloudGetResult,
  ChargecloudListInput,
  ChargecloudListResult,
  ChargecloudPoint,
} from './types.js';

type Obj = Record<string, unknown>;
const record = (v: unknown): Obj => (typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Obj) : {});
const string = (v: unknown, max: number): string | undefined =>
  typeof v === 'string' && v.trim().length > 0 && v.length <= max && !/[\u0000-\u001f\u007f]/.test(v)
    ? v.trim()
    : undefined;
const number = (v: unknown): number | undefined => {
  if (typeof v !== 'number' && (typeof v !== 'string' || !/^-?\d+(?:\.\d+)?$/.test(v))) return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
};
const statuses = new Set([
  'AVAILABLE',
  'BLOCKED',
  'CHARGING',
  'INOPERATIVE',
  'OUTOFORDER',
  'PLANNED',
  'REMOVED',
  'RESERVED',
  'UNKNOWN',
  'OCCUPIED',
]);
const idPattern = /^[A-Z]{2}\*[A-Z0-9]{3}\*E[A-Z0-9]+(?:\*[A-Z0-9]+)*$/;
function normalize(location: Obj, evse: Obj): ChargecloudPoint {
  const locationId = string(location['id'], 128);
  const address = string(location['address'], 256);
  const postalCode = string(location['postal_code'], 16);
  const city = string(location['city'], 128);
  const evseId = string(evse['id'], 64);
  if (!locationId || !address || !postalCode || !city || !evseId || !idPattern.test(evseId))
    throw new ChargecloudError('contract', 502);
  const coords = record(location['coordinates']);
  const latitude = number(coords['latitude']);
  const longitude = number(coords['longitude']);
  const coordinates =
    latitude !== undefined &&
    latitude >= -90 &&
    latitude <= 90 &&
    longitude !== undefined &&
    longitude >= -180 &&
    longitude <= 180
      ? { latitude, longitude }
      : undefined;
  const country = string(location['country'], 3);
  const rawStatus = evse['status'];
  const status = typeof rawStatus === 'string' && statuses.has(rawStatus) ? rawStatus : 'UNKNOWN';
  const connectors: ChargecloudConnector[] = [];
  if (Array.isArray(evse['connectors'])) {
    for (const value of evse['connectors'].slice(0, 16)) {
      const item = record(value);
      const type = string(item['standard'], 64);
      const power = number(item['max_power']);
      const maxPowerKw = power !== undefined && power >= 0 && power <= 10000 ? power : undefined;
      if (type || maxPowerKw !== undefined)
        connectors.push({ ...(type ? { type } : {}), ...(maxPowerKw !== undefined ? { maxPowerKw } : {}) });
    }
  }
  return {
    locationId,
    address,
    postalCode,
    city,
    ...(country ? { country } : {}),
    ...(coordinates ? { coordinates } : {}),
    evseId,
    status,
    ...(validTimestamp(evse['last_updated']) ? { lastUpdated: evse['last_updated'] } : {}),
    connectors,
  };
}
function points(data: unknown[], postalCode?: string, evseId?: string): ChargecloudPoint[] {
  const output: ChargecloudPoint[] = [];
  const seen = new Set<string>();
  for (const value of data) {
    const location = record(value);
    // A missing membership field is a provider contract failure, not evidence
    // that the location is outside the requested area.
    if (postalCode !== undefined && typeof location['postal_code'] !== 'string')
      throw new ChargecloudError('contract', 502);
    if (postalCode !== undefined && location['postal_code'] !== postalCode) continue;
    if (!Array.isArray(location['evses'])) throw new ChargecloudError('contract', 502);
    for (const raw of location['evses']) {
      const evse = record(raw);
      if (typeof evse['id'] !== 'string' || !idPattern.test(evse['id']) || evse['id'].length > 64)
        throw new ChargecloudError('contract', 502);
      if (evseId !== undefined && evse['id'] !== evseId) continue;
      if (seen.has(evse['id'])) throw new ChargecloudError('contract', 502);
      seen.add(evse['id']);
      output.push(normalize(location, evse));
    }
  }
  return output;
}
export class ChargecloudService {
  constructor(private readonly client: ChargecloudClient) {}
  async list(input: ChargecloudListInput): Promise<ChargecloudListResult> {
    const parsed = chargecloudListInputSchema.safeParse(input);
    if (!parsed.success) throw new ChargecloudError('request', 400);
    const { postalCode, availableOnly, limit, offset } = parsed.data;
    const envelope = await this.client.locations();
    const matches = points(envelope.data, postalCode).filter((point) => !availableOnly || point.status === 'AVAILABLE');
    matches.sort((a, b) => (a.evseId < b.evseId ? -1 : a.evseId > b.evseId ? 1 : 0));
    const chargingPoints = matches.slice(offset, offset + limit);
    const next = offset + chargingPoints.length;
    const truncated = next < matches.length;
    return {
      source: 'chargecloud-wien-energie',
      fetchedAt: new Date().toISOString(),
      sourceTimestamp: envelope.timestamp,
      chargingPoints,
      totalMatching: matches.length,
      returned: chargingPoints.length,
      truncated,
      ...(truncated && next <= 10000 ? { nextOffset: next } : {}),
      paginationNote:
        'Each request fetches a new live snapshot; results and offsets may change between requests. The maximum offset is 10000.',
    };
  }
  async get(input: ChargecloudGetInput): Promise<ChargecloudGetResult> {
    const parsed = chargecloudGetInputSchema.safeParse(input);
    if (!parsed.success) throw new ChargecloudError('request', 400);
    const envelope = await this.client.locations(parsed.data.evseId);
    const point = points(envelope.data, undefined, parsed.data.evseId)[0];
    if (!point) throw new ChargecloudError('not_found', 404);
    return {
      source: 'chargecloud-wien-energie',
      fetchedAt: new Date().toISOString(),
      sourceTimestamp: envelope.timestamp,
      point,
    };
  }
}
