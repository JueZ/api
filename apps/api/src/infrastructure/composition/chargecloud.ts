import { ChargecloudClient, type ChargecloudFetch } from '../../shared/chargecloud/client.js';
import { ChargecloudService } from '../../shared/chargecloud/service.js';

export function createChargecloudService(fetchImpl: ChargecloudFetch = fetch): ChargecloudService {
  return new ChargecloudService(new ChargecloudClient(fetchImpl));
}
