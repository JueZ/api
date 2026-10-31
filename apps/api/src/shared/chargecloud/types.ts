import { z } from 'zod';

export const chargecloudListInputSchema = z.strictObject({
  postalCode: z
    .string()
    .regex(/^\d{4}$/)
    .default('1080'),
  availableOnly: z.boolean().default(false),
  limit: z.number().int().min(1).max(100).default(100),
  offset: z.number().int().min(0).max(10000).default(0),
});
export const chargecloudGetInputSchema = z.strictObject({
  evseId: z
    .string()
    .trim()
    .max(64)
    .regex(/^[A-Z]{2}\*[A-Z0-9]{3}\*E[A-Z0-9]+(?:\*[A-Z0-9]+)*$/),
});
const chargecloudConnectorSchema = z.strictObject({
  type: z.string().min(1).max(64).optional(),
  maxPowerKw: z.number().min(0).max(10000).optional(),
});
const chargecloudPointSchema = z.strictObject({
  locationId: z.string().min(1).max(128),
  address: z.string().min(1).max(256),
  postalCode: z.string().min(1).max(16),
  city: z.string().min(1).max(128),
  country: z.string().min(1).max(3).optional(),
  coordinates: z
    .strictObject({ latitude: z.number().min(-90).max(90), longitude: z.number().min(-180).max(180) })
    .optional(),
  evseId: z.string().min(1).max(64),
  status: z.enum([
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
  ]),
  lastUpdated: z.string().max(40).optional(),
  connectors: z.array(chargecloudConnectorSchema).max(16),
});
const metadata = {
  source: z.literal('chargecloud-wien-energie'),
  fetchedAt: z.string().max(40),
  sourceTimestamp: z.string().max(40),
};
export const chargecloudListOutputSchema = z.strictObject({
  ...metadata,
  chargingPoints: z.array(chargecloudPointSchema).max(100),
  totalMatching: z.number().int().nonnegative(),
  returned: z.number().int().min(0).max(100),
  truncated: z.boolean(),
  nextOffset: z.number().int().min(0).max(10000).optional(),
  paginationNote: z.string().max(300),
});
export const chargecloudGetOutputSchema = z.strictObject({ ...metadata, point: chargecloudPointSchema });
export type ChargecloudListInput = z.infer<typeof chargecloudListInputSchema>;
export type ChargecloudGetInput = z.infer<typeof chargecloudGetInputSchema>;
export interface ChargecloudConnector {
  type?: string;
  maxPowerKw?: number;
}
export interface ChargecloudPoint {
  locationId: string;
  address: string;
  postalCode: string;
  city: string;
  country?: string;
  coordinates?: { latitude: number; longitude: number };
  evseId: string;
  status: string;
  lastUpdated?: string;
  connectors: ChargecloudConnector[];
}
export interface ChargecloudListResult {
  source: 'chargecloud-wien-energie';
  fetchedAt: string;
  sourceTimestamp: string;
  chargingPoints: ChargecloudPoint[];
  totalMatching: number;
  returned: number;
  truncated: boolean;
  nextOffset?: number;
  paginationNote: string;
}
export interface ChargecloudGetResult {
  source: 'chargecloud-wien-energie';
  fetchedAt: string;
  sourceTimestamp: string;
  point: ChargecloudPoint;
}
