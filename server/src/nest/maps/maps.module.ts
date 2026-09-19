import { Module } from '@nestjs/common';
import { MapsController } from './maps.controller';
import { AmapProxyController } from './amap-proxy.controller';
import { MapsService } from './maps.service';
import { MapsMcp } from './maps.mcp';
import { PlacePhotosModule } from '../place-photos/place-photos.module';
import { StorageModule } from '../storage/storage.module';
import { RateLimitModule } from '../common/rate-limit.module';
import { SettingsModule } from '../settings/settings.module';

/**
 * Maps / geo domain (L3 leaf module). Registered in AppModule. Exports
 * MapsService for the in-container consumers (BookingImportModule's Nominatim
 * geocoding, PlacesModule's search_place tool and list-import enrichment).
 * Nothing outside the container consumes this domain, so there is no bridge.
 *
 * AmapProxyController lives here rather than in its own module because it is
 * the same credential story as the Amap places provider — but note its route
 * prefix is `/_AMapService`, not `api/`: Amap fixes that path and the SDK will
 * not ask anywhere else.
 */
@Module({
  // RateLimitModule: AmapProxyController holds a credential and fans out to a
  // third party, which is exactly what the limiter is for.
  // SettingsModule: the proxy resolves the Amap 安全密钥 out of settings.
  imports: [PlacePhotosModule, StorageModule, RateLimitModule, SettingsModule],
  controllers: [MapsController, AmapProxyController],
  providers: [MapsService, MapsMcp],
  exports: [MapsService],
})
export class MapsModule {}
