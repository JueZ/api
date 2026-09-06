targetScope = 'resourceGroup'

@description('Azure region for all low-cost v0 resources.')
@allowed([
  'westeurope'
])
param location string = 'westeurope'

@description('Explicit deployment environment. There is deliberately no production default.')
@allowed([
  'test'
  'prod'
])
param environmentName string

@description('Workload name used in resource names and tags.')
param workloadName string = 'api-catalogue'

@description('Application-level OAuth/OIDC/JWT authentication. Test and production require true.')
@allowed([
  true
])
param authEnabled bool

@description('Comma-separated exact OIDC issuer URLs.')
param oidcIssuer string

@description('Expected JWT audience.')
param oidcAudience string

@description('Optional explicit JWKS URI. Leave empty to use issuer discovery.')
param oidcJwksUri string = ''

@description('Comma-separated delegated scopes/application roles recognized by the operation policy.')
param oidcRequiredScopes string = 'catalogue.read,reddit.read,youtube.read,wlh.read,bring.read,bring.write,bring.complete,bring.remove'

@description('Comma-separated allowed Microsoft Entra user object IDs.')
param oidcAllowedObjectIds string

@description('Comma-separated allowed subjects used only when oid is absent.')
param oidcAllowedSubjects string = ''

@description('Comma-separated allowed service-principal object IDs.')
param oidcAllowedAppObjectIds string = ''

@description('Comma-separated allowed application/client IDs for service tokens.')
param oidcAllowedClientIds string = ''

@description('Comma-separated allowed OAuth client IDs for delegated user tokens.')
param oidcAllowedDelegatedClientIds string

@description('Comma-separated allowed tenant IDs.')
param oidcAllowedTenants string

@description('Enable sanitized auth diagnostics without logging tokens or claims.')
param authDebug bool = false

@description('Exact browser origins allowed to call REST endpoints.')
param apiCorsAllowedOrigins string

@description('Canonical public HTTPS origin of the MCP gateway.')
param mcpResourceOrigin string

@description('Comma-separated exact HTTPS browser origins allowed to call MCP.')
param mcpAllowedOrigins string

@description('Object ID of the environment-specific GitHub Actions OIDC deployment service principal.')
param deploymentPrincipalObjectId string

@description('Operator email for Azure Monitor and budget notifications.')
param operatorAlertEmail string

@description('Monthly resource-group budget. Test uses EUR 10 and production EUR 15, for EUR 25 combined.')
param monthlyBudgetEur int = environmentName == 'prod' ? 15 : 10

@description('Immutable budget start. New budgets default to the current month; deployment callers preserve an existing value.')
param budgetStartDate string = utcNow('yyyy-MM-01T00:00:00Z')

@description('Reddit OAuth client ID.')
param redditClientId string

@secure()
@description('Reddit OAuth client secret; stored in Key Vault and referenced by the Function App.')
param redditOAuthSecret string

@description('Reddit API User-Agent.')
param redditUserAgent string

@description('Private container for resumable Reddit thread snapshots.')
param redditSnapshotContainer string = 'reddit-snapshots'

@description('Reddit snapshot cursor lifetime in seconds.')
param redditSnapshotTtlSeconds int = 86400

@description('High resource-safety cap per Reddit snapshot; this is not a normal pagination limit.')
param redditSnapshotMaxComments int = 100000

@description('High serialized-byte safety cap per Reddit snapshot; leaves headroom below the application Blob read limit.')
param redditSnapshotMaxBytes int = 100663296

@description('Enable metered native-caption YouTube transcripts. Disabled by default.')
param youtubeTranscriptEnabled bool = false
@secure()
@description('Supadata API key, stored in Key Vault. Empty while the feature is disabled.')
param supadataApiKey string = ''
@secure()
@description('HMAC key for principal-bound YouTube transcript cursors.')
param youtubeTranscriptCursorHmacKey string = ''
@description('Private YouTube transcript snapshot container.')
param youtubeTranscriptContainer string = 'youtube-transcripts'
@description('Positive transcript cache lifetime in seconds.')
@minValue(300)
@maxValue(172800)
param youtubeTranscriptCacheTtlSeconds int = 86400

@secure()
@description('WLH upstream base URL; stored in Key Vault because the existing integration treats it as sensitive.')
param wlhBaseUrl string

@description('Private WLH reference-data container.')
param wlhCategoryBlobContainer string = 'wlh-reference'

@description('WLH category-data blob name.')
param wlhCategoryBlobName string = 'categories-marketplace.v1.json.gz'

@description('Enable Google Weather API forecasts.')
param weatherEnabled bool = false

@secure()
@description('Google Weather API key; stored in Key Vault and restricted to the Weather API.')
param googleWeatherApiKey string = ''

@description('Enable the unofficial Bring integration.')
param bringEnabled bool = false

@description('Enable idempotent Bring add operations. Test must remain false.')
param bringAddEnabled bool = false

@description('Enable confirmed Bring complete/remove operations. Test must remain false.')
param bringDestructiveEnabled bool = false

@description('Bring upstream base URL.')
param bringBaseUrl string = 'https://api.getbring.com/rest/'

@secure()
@description('Unofficial Bring client API key.')
param bringClientApiKey string

@description('Bring client country.')
param bringCountry string = 'AT'

@secure()
@description('Bring technical account email. Test may reuse production only while all test writes remain disabled.')
param bringEmail string

@secure()
@description('Bring technical account password.')
param bringPassword string

@description('SHA-256 fingerprint of the expected Bring account email.')
param bringExpectedAccountFingerprint string

@description('Optional default readable Bring list UUID.')
param bringDefaultListUuid string = ''

@description('Comma-separated Bring list UUIDs that this environment may read.')
param bringReadableListUuids string

@description('Comma-separated list UUIDs that production may write. Unlisted lists are denied in application policy.')
param bringWritableListUuids string = ''

@description('Comma-separated shared-list UUIDs that may be written only when also explicitly writable. Empty denies all shared-list writes.')
param bringWritableSharedListUuids string = ''

@description('Enable durable Bring authentication-session caching.')
param bringSessionCacheEnabled bool = true

@description('Private Bring session container.')
param bringSessionCacheContainer string = 'bring-private'

@description('Private Bring session blob.')
param bringSessionCacheBlob string = 'session-v1.json'

@description('Private Bring mutation replay container.')
param bringMutationContainer string = 'bring-mutations'

@description('Private Bring audit container.')
param bringAuditContainer string = 'bring-audit'

@secure()
@description('At least 32 bytes used for confirmation tokens and pseudonyms.')
param bringConfirmationHmacKey string

@secure()
@description('Base64-encoded 32-byte AES key for prepared mutation payloads.')
param bringMutationEncryptionKey string

@secure()
@description('Optional OpenAI API key for sanitized repairable-error analysis.')
param openAiCredential string = ''

@description('Enable optional LLM-assisted repairable-error analysis.')
param repairableErrorsLlmEnabled bool = false

@description('OpenAI model for repairable-error analysis.')
param repairableErrorsLlmModel string = ''

var validatedCorsOrigins = !empty(apiCorsAllowedOrigins) && !contains(apiCorsAllowedOrigins, '*')
  ? apiCorsAllowedOrigins
  : fail('API CORS origins must be non-empty and must not contain a wildcard.')
var validatedMcpOrigin = startsWith(mcpResourceOrigin, 'https://') && !endsWith(mcpResourceOrigin, '/') && mcpResourceOrigin != 'https://null'
  ? mcpResourceOrigin
  : fail('MCP_RESOURCE_ORIGIN must be one canonical non-placeholder HTTPS origin without a trailing slash.')
var validatedMcpAllowedOrigins = !empty(mcpAllowedOrigins) && !contains(mcpAllowedOrigins, '*')
  ? mcpAllowedOrigins
  : fail('MCP allowed origins must be non-empty exact origins without a wildcard.')
var validatedOidcIssuer = !empty(oidcIssuer) ? oidcIssuer : fail('OIDC issuer is required.')
var validatedOidcAudience = !empty(oidcAudience) ? oidcAudience : fail('OIDC audience is required.')
var validatedOidcObjectIds = !empty(oidcAllowedObjectIds) ? oidcAllowedObjectIds : fail('At least one OIDC user object ID is required.')
var validatedOidcDelegatedClientIds = !empty(oidcAllowedDelegatedClientIds)
  ? oidcAllowedDelegatedClientIds
  : fail('At least one delegated OAuth client ID is required.')
var validatedOidcTenants = !empty(oidcAllowedTenants) ? oidcAllowedTenants : fail('At least one OIDC tenant is required.')
var validatedBringAddEnabled = !bringEnabled && bringAddEnabled
  ? fail('Bring add operations require bringEnabled=true.')
  : environmentName == 'test' && bringAddEnabled
    ? fail('Bring add operations are prohibited in test.')
    : bringAddEnabled
var validatedBringDestructiveEnabled = !bringEnabled && bringDestructiveEnabled
  ? fail('Destructive Bring operations require bringEnabled=true.')
  : environmentName == 'test' && bringDestructiveEnabled
    ? fail('Destructive Bring operations are prohibited in test.')
    : bringDestructiveEnabled
var validatedBringReadableLists = bringEnabled && empty(bringReadableListUuids)
  ? fail('Enabled Bring integration requires a readable-list allowlist.')
  : bringReadableListUuids
var validatedBringWritableLists = (validatedBringAddEnabled || validatedBringDestructiveEnabled) && empty(bringWritableListUuids)
  ? fail('Enabled Bring writes require an explicit writable-list allowlist.')
  : bringWritableListUuids
var validatedBringFingerprint = bringEnabled && empty(bringExpectedAccountFingerprint)
  ? fail('Enabled Bring integration requires an expected account fingerprint.')
  : bringExpectedAccountFingerprint
var validatedBudgetAmount = ((environmentName == 'test' && monthlyBudgetEur == 10) || (environmentName == 'prod' && monthlyBudgetEur == 15))
  ? monthlyBudgetEur
  : fail('Budget split must remain EUR 10 for test and EUR 15 for production.')

var nameSuffix = uniqueString(resourceGroup().id, workloadName, environmentName)
var normalizedWorkload = replace(workloadName, '-', '')
var hostStorageName = take('st${normalizedWorkload}${environmentName}h${nameSuffix}', 24)
var releaseStorageName = take('st${normalizedWorkload}${environmentName}r${nameSuffix}', 24)
var staticStorageName = take('st${normalizedWorkload}${environmentName}w${nameSuffix}', 24)
var privateStorageName = take('st${normalizedWorkload}${environmentName}p${nameSuffix}', 24)
var functionAppName = 'func-${workloadName}-${environmentName}-${nameSuffix}'
var hostingPlanName = 'plan-${workloadName}-${environmentName}-${nameSuffix}'
var appInsightsName = 'appi-${workloadName}-${environmentName}-${nameSuffix}'
var keyVaultName = take('kv-${normalizedWorkload}-${environmentName}-${nameSuffix}', 24)
var actionGroupName = 'ag-${workloadName}-${environmentName}'
var tags = {
  workload: workloadName
  environment: environmentName
  costProfile: 'serverless-consumption'
  dataBoundary: environmentName
  managedBy: 'bicep'
}
var apiCorsAllowedOriginList = split(validatedCorsOrigins, ',')
var storageNetworkPolicy = {
  bypass: 'AzureServices'
  defaultAction: 'Allow'
}
var storageProperties = {
  accessTier: 'Hot'
  allowBlobPublicAccess: false
  allowCrossTenantReplication: false
  allowSharedKeyAccess: false
  defaultToOAuthAuthentication: true
  minimumTlsVersion: 'TLS1_2'
  networkAcls: storageNetworkPolicy
  publicNetworkAccess: 'Enabled'
  supportsHttpsTrafficOnly: true
}

resource hostStorage 'Microsoft.Storage/storageAccounts@2023-05-01' = {
  name: hostStorageName
  location: location
  sku: {
    name: 'Standard_LRS'
  }
  kind: 'StorageV2'
  tags: union(tags, { purpose: 'function-host' })
  properties: storageProperties
}

resource releaseStorage 'Microsoft.Storage/storageAccounts@2023-05-01' = {
  name: releaseStorageName
  location: location
  sku: {
    name: 'Standard_LRS'
  }
  kind: 'StorageV2'
  tags: union(tags, { purpose: 'immutable-release-packages' })
  properties: storageProperties
}

resource staticStorage 'Microsoft.Storage/storageAccounts@2023-05-01' = {
  name: staticStorageName
  location: location
  sku: {
    name: 'Standard_LRS'
  }
  kind: 'StorageV2'
  tags: union(tags, { purpose: 'public-static-site' })
  properties: storageProperties
}

module privateStorageDeployment './modules/private-storage.bicep' = {
  name: 'private-storage-${environmentName}'
  params: {
    location: location
    environmentName: environmentName
    workloadName: workloadName
    storageAccountName: privateStorageName
    deploymentPrincipalObjectId: deploymentPrincipalObjectId
    wlhCategoryBlobContainer: wlhCategoryBlobContainer
    redditSnapshotContainer: redditSnapshotContainer
    youtubeTranscriptContainer: youtubeTranscriptContainer
    bringSessionCacheContainer: bringSessionCacheContainer
    bringMutationContainer: bringMutationContainer
    bringAuditContainer: bringAuditContainer
  }
}

resource privateStorage 'Microsoft.Storage/storageAccounts@2023-05-01' existing = {
  name: privateStorageName
}

resource hostBlobService 'Microsoft.Storage/storageAccounts/blobServices@2023-05-01' = {
  parent: hostStorage
  name: 'default'
  properties: {
    deleteRetentionPolicy: {
      enabled: true
      days: 7
    }
    containerDeleteRetentionPolicy: {
      enabled: true
      days: 7
    }
  }
}

resource releaseBlobService 'Microsoft.Storage/storageAccounts/blobServices@2023-05-01' = {
  parent: releaseStorage
  name: 'default'
  properties: {
    isVersioningEnabled: true
    deleteRetentionPolicy: {
      enabled: true
      days: 14
    }
    containerDeleteRetentionPolicy: {
      enabled: true
      days: 14
    }
  }
}

resource staticBlobService 'Microsoft.Storage/storageAccounts/blobServices@2025-08-01' = {
  parent: staticStorage
  name: 'default'
  properties: {
    staticWebsite: {
      enabled: true
      indexDocument: 'index.html'
      errorDocument404Path: 'index.html'
    }
    deleteRetentionPolicy: {
      enabled: true
      days: 7
    }
  }
}

resource privateBlobService 'Microsoft.Storage/storageAccounts/blobServices@2023-05-01' existing = {
  parent: privateStorage
  name: 'default'
}

resource releaseContainer 'Microsoft.Storage/storageAccounts/blobServices/containers@2023-05-01' = {
  parent: releaseBlobService
  name: 'function-releases'
  properties: {
    publicAccess: 'None'
  }
}

resource wlhReferenceContainer 'Microsoft.Storage/storageAccounts/blobServices/containers@2023-05-01' existing = {
  parent: privateBlobService
  name: wlhCategoryBlobContainer
}

resource redditThreadSnapshotContainer 'Microsoft.Storage/storageAccounts/blobServices/containers@2023-05-01' existing = {
  parent: privateBlobService
  name: redditSnapshotContainer
}
resource youtubeTranscriptSnapshotContainer 'Microsoft.Storage/storageAccounts/blobServices/containers@2023-05-01' existing = {
  parent: privateBlobService
  name: youtubeTranscriptContainer
}

resource bringSessionContainer 'Microsoft.Storage/storageAccounts/blobServices/containers@2023-05-01' existing = {
  parent: privateBlobService
  name: bringSessionCacheContainer
}

resource bringMutationStoreContainer 'Microsoft.Storage/storageAccounts/blobServices/containers@2023-05-01' existing = {
  parent: privateBlobService
  name: bringMutationContainer
}

resource bringAuditStoreContainer 'Microsoft.Storage/storageAccounts/blobServices/containers@2023-05-01' existing = {
  parent: privateBlobService
  name: bringAuditContainer
}

resource staticWebContainer 'Microsoft.Storage/storageAccounts/blobServices/containers@2023-05-01' existing = {
  parent: staticBlobService
  name: '$web'
}

resource releaseLifecycle 'Microsoft.Storage/storageAccounts/managementPolicies@2023-05-01' = {
  parent: releaseStorage
  name: 'default'
  properties: {
    policy: {
      rules: [
        {
          name: 'expire-old-release-packages'
          enabled: true
          type: 'Lifecycle'
          definition: {
            actions: {
              baseBlob: {
                delete: {
                  daysAfterModificationGreaterThan: 180
                }
              }
              version: {
                delete: {
                  daysAfterCreationGreaterThan: 30
                }
              }
            }
            filters: {
              blobTypes: [
                'blockBlob'
              ]
              prefixMatch: [
                'function-releases/'
              ]
            }
          }
        }
      ]
    }
  }
}

resource keyVault 'Microsoft.KeyVault/vaults@2023-07-01' = {
  name: keyVaultName
  location: location
  tags: union(tags, { purpose: 'provider-secrets' })
  properties: {
    tenantId: subscription().tenantId
    sku: {
      family: 'A'
      name: 'standard'
    }
    enableRbacAuthorization: true
    enablePurgeProtection: true
    softDeleteRetentionInDays: 90
    publicNetworkAccess: 'Enabled'
    networkAcls: {
      bypass: 'AzureServices'
      defaultAction: 'Allow'
    }
  }
}

resource redditSecret 'Microsoft.KeyVault/vaults/secrets@2023-07-01' = {
  parent: keyVault
  name: 'reddit-client-secret'
  properties: {
    value: redditOAuthSecret
  }
}
resource supadataSecret 'Microsoft.KeyVault/vaults/secrets@2023-07-01' = if (youtubeTranscriptEnabled) {
  parent: keyVault
  name: 'supadata-api-key'
  properties: { value: supadataApiKey }
}
resource youtubeCursorSecret 'Microsoft.KeyVault/vaults/secrets@2023-07-01' = if (youtubeTranscriptEnabled) {
  parent: keyVault
  name: 'youtube-transcript-cursor-hmac-key'
  properties: { value: youtubeTranscriptCursorHmacKey }
}

resource wlhBaseUrlSecret 'Microsoft.KeyVault/vaults/secrets@2023-07-01' = {
  parent: keyVault
  name: 'wlh-base-url'
  properties: {
    value: wlhBaseUrl
  }
}

resource googleWeatherApiKeySecret 'Microsoft.KeyVault/vaults/secrets@2023-07-01' = if (weatherEnabled) {
  parent: keyVault
  name: 'google-weather-api-key'
  properties: { value: googleWeatherApiKey }
}

resource bringClientApiKeySecret 'Microsoft.KeyVault/vaults/secrets@2023-07-01' = {
  parent: keyVault
  name: 'bring-client-api-key'
  properties: {
    value: bringClientApiKey
  }
}

resource bringEmailSecret 'Microsoft.KeyVault/vaults/secrets@2023-07-01' = {
  parent: keyVault
  name: 'bring-email'
  properties: {
    value: bringEmail
  }
}

resource bringPasswordSecret 'Microsoft.KeyVault/vaults/secrets@2023-07-01' = {
  parent: keyVault
  name: 'bring-password'
  properties: {
    value: bringPassword
  }
}

resource bringConfirmationKeySecret 'Microsoft.KeyVault/vaults/secrets@2023-07-01' = {
  parent: keyVault
  name: 'bring-confirmation-hmac-key'
  properties: {
    value: bringConfirmationHmacKey
  }
}

resource bringEncryptionKeySecret 'Microsoft.KeyVault/vaults/secrets@2023-07-01' = {
  parent: keyVault
  name: 'bring-mutation-encryption-key'
  properties: {
    value: bringMutationEncryptionKey
  }
}

resource openAiSecret 'Microsoft.KeyVault/vaults/secrets@2023-07-01' = if (repairableErrorsLlmEnabled) {
  parent: keyVault
  name: 'openai-api-key'
  properties: {
    value: openAiCredential
  }
}

resource appInsights 'Microsoft.Insights/components@2020-02-02' = {
  name: appInsightsName
  location: location
  kind: 'web'
  tags: tags
  properties: {
    Application_Type: 'web'
    RetentionInDays: 90
    SamplingPercentage: 100
    publicNetworkAccessForIngestion: 'Enabled'
    publicNetworkAccessForQuery: 'Enabled'
  }
}

resource hostingPlan 'Microsoft.Web/serverfarms@2023-12-01' = {
  name: hostingPlanName
  location: location
  kind: 'functionapp'
  tags: tags
  sku: {
    name: 'Y1'
    tier: 'Dynamic'
  }
  properties: {
    reserved: true
  }
}

resource functionApp 'Microsoft.Web/sites@2023-12-01' = {
  name: functionAppName
  location: location
  kind: 'functionapp,linux'
  tags: tags
  identity: {
    type: 'SystemAssigned'
  }
  properties: {
    serverFarmId: hostingPlan.id
    httpsOnly: true
    publicNetworkAccess: 'Enabled'
    siteConfig: {
      linuxFxVersion: 'NODE|22'
      minTlsVersion: '1.2'
      ftpsState: 'Disabled'
      http20Enabled: true
      minimumElasticInstanceCount: 0
      cors: {
        allowedOrigins: apiCorsAllowedOriginList
        supportCredentials: false
      }
    }
  }
}

// Preserve only settings owned by the immutable release deployment. The
// appsettings resource uses PUT semantics, so dropping these values during an
// infrastructure-only update would remove the active Functions package and
// its provenance before the artifact deployment could restore them.
var existingFunctionAppSettings = list('${functionApp.id}/config/appsettings', '2023-12-01').properties
var preservedFunctionReleaseSettings = union(
  contains(existingFunctionAppSettings, 'WEBSITE_RUN_FROM_PACKAGE')
    ? { WEBSITE_RUN_FROM_PACKAGE: existingFunctionAppSettings.WEBSITE_RUN_FROM_PACKAGE }
    : {},
  contains(existingFunctionAppSettings, 'WEBSITE_RUN_FROM_PACKAGE_BLOB_MI_RESOURCE_ID')
    ? { WEBSITE_RUN_FROM_PACKAGE_BLOB_MI_RESOURCE_ID: existingFunctionAppSettings.WEBSITE_RUN_FROM_PACKAGE_BLOB_MI_RESOURCE_ID }
    : {},
  contains(existingFunctionAppSettings, 'DEPLOYED_COMMIT_SHA')
    ? { DEPLOYED_COMMIT_SHA: existingFunctionAppSettings.DEPLOYED_COMMIT_SHA }
    : {},
  contains(existingFunctionAppSettings, 'DEPLOYED_SOURCE_REF')
    ? { DEPLOYED_SOURCE_REF: existingFunctionAppSettings.DEPLOYED_SOURCE_REF }
    : {},
  contains(existingFunctionAppSettings, 'DEPLOYMENT_RUN_ID')
    ? { DEPLOYMENT_RUN_ID: existingFunctionAppSettings.DEPLOYMENT_RUN_ID }
    : {},
  contains(existingFunctionAppSettings, 'DELIVERY_CORRELATION')
    ? { DELIVERY_CORRELATION: existingFunctionAppSettings.DELIVERY_CORRELATION }
    : {},
  contains(existingFunctionAppSettings, 'DELIVERY_MUTATION_RUN_ID')
    ? { DELIVERY_MUTATION_RUN_ID: existingFunctionAppSettings.DELIVERY_MUTATION_RUN_ID }
    : {},
  contains(existingFunctionAppSettings, 'DELIVERY_MUTATION_CORRELATION')
    ? { DELIVERY_MUTATION_CORRELATION: existingFunctionAppSettings.DELIVERY_MUTATION_CORRELATION }
    : {},
  contains(existingFunctionAppSettings, 'DELIVERY_MUTATION_CONTROLLER_SHA')
    ? { DELIVERY_MUTATION_CONTROLLER_SHA: existingFunctionAppSettings.DELIVERY_MUTATION_CONTROLLER_SHA }
    : {},
  contains(existingFunctionAppSettings, 'DELIVERY_MUTATION_KIND')
    ? { DELIVERY_MUTATION_KIND: existingFunctionAppSettings.DELIVERY_MUTATION_KIND }
    : {},
  contains(existingFunctionAppSettings, 'DEPLOYED_AT_UTC')
    ? { DEPLOYED_AT_UTC: existingFunctionAppSettings.DEPLOYED_AT_UTC }
    : {},
  contains(existingFunctionAppSettings, 'BUILD_TIMESTAMP_UTC')
    ? { BUILD_TIMESTAMP_UTC: existingFunctionAppSettings.BUILD_TIMESTAMP_UTC }
    : {},
  contains(existingFunctionAppSettings, 'RELEASE_FUNCTION_SHA256')
    ? { RELEASE_FUNCTION_SHA256: existingFunctionAppSettings.RELEASE_FUNCTION_SHA256 }
    : {},
  contains(existingFunctionAppSettings, 'RELEASE_FRONTEND_SHA256')
    ? { RELEASE_FRONTEND_SHA256: existingFunctionAppSettings.RELEASE_FRONTEND_SHA256 }
    : {},
  contains(existingFunctionAppSettings, 'RELEASE_SBOM_SHA256')
    ? { RELEASE_SBOM_SHA256: existingFunctionAppSettings.RELEASE_SBOM_SHA256 }
    : {}
)

// Reconcile settings through a nested deployment. Reading and writing the same
// appsettings resource in one ARM template creates a resource-level cycle;
// this boundary lets the parent read release-owned keys after the Function App
// exists and passes only the complete secure settings object to the child.
module functionAppSettings './modules/function-app-settings.bicep' = {
  name: 'function-app-settings-${environmentName}'
  params: {
    functionAppName: functionApp.name
    appSettings: union(preservedFunctionReleaseSettings, {
      APPLICATIONINSIGHTS_CONNECTION_STRING: appInsights.properties.ConnectionString
      AzureWebJobsStorage__blobServiceUri: 'https://${hostStorage.name}.blob.${environment().suffixes.storage}'
      AzureWebJobsStorage__queueServiceUri: 'https://${hostStorage.name}.queue.${environment().suffixes.storage}'
      AzureWebJobsStorage__tableServiceUri: 'https://${hostStorage.name}.table.${environment().suffixes.storage}'
      AzureWebJobsStorage__credential: 'managedidentity'
      FUNCTIONS_EXTENSION_VERSION: '~4'
      FUNCTIONS_WORKER_RUNTIME: 'node'
      DEPLOYED_ENVIRONMENT_NAME: environmentName
      // ARM string(bool) produces title-cased text. Function settings are
      // case-sensitive strings, so normalize every boolean setting explicitly.
      AUTH_ENABLED: toLower(string(authEnabled))
      OIDC_ISSUER: validatedOidcIssuer
      OIDC_AUDIENCE: validatedOidcAudience
      OIDC_JWKS_URI: oidcJwksUri
      OIDC_REQUIRED_SCOPES: oidcRequiredScopes
      OIDC_ALLOWED_OBJECT_IDS: validatedOidcObjectIds
      OIDC_ALLOWED_SUBJECTS: oidcAllowedSubjects
      OIDC_ALLOWED_APP_OBJECT_IDS: oidcAllowedAppObjectIds
      OIDC_ALLOWED_CLIENT_IDS: oidcAllowedClientIds
      OIDC_ALLOWED_DELEGATED_CLIENT_IDS: validatedOidcDelegatedClientIds
      OIDC_ALLOWED_TENANTS: validatedOidcTenants
      AUTH_DEBUG: toLower(string(authDebug))
      API_CORS_ALLOWED_ORIGINS: validatedCorsOrigins
      MCP_RESOURCE_ORIGIN: validatedMcpOrigin
      MCP_ALLOWED_ORIGINS: validatedMcpAllowedOrigins
      REDDIT_CLIENT_ID: redditClientId
      REDDIT_CLIENT_SECRET: '@Microsoft.KeyVault(SecretUri=${redditSecret.properties.secretUriWithVersion})'
      REDDIT_USER_AGENT: redditUserAgent
      REDDIT_STORAGE_ACCOUNT_NAME: privateStorage.name
      REDDIT_SNAPSHOT_CONTAINER: redditSnapshotContainer
      REDDIT_SNAPSHOT_TTL_SECONDS: string(redditSnapshotTtlSeconds)
      REDDIT_SNAPSHOT_MAX_COMMENTS: string(redditSnapshotMaxComments)
      REDDIT_SNAPSHOT_MAX_BYTES: string(redditSnapshotMaxBytes)
      YOUTUBE_TRANSCRIPT_ENABLED: toLower(string(youtubeTranscriptEnabled))
      SUPADATA_API_KEY: youtubeTranscriptEnabled ? '@Microsoft.KeyVault(SecretUri=${supadataSecret!.properties.secretUriWithVersion})' : ''
      YOUTUBE_TRANSCRIPT_CURSOR_HMAC_KEY: youtubeTranscriptEnabled ? '@Microsoft.KeyVault(SecretUri=${youtubeCursorSecret!.properties.secretUriWithVersion})' : ''
      YOUTUBE_TRANSCRIPT_STORAGE_ACCOUNT_NAME: privateStorage.name
      YOUTUBE_TRANSCRIPT_CONTAINER: youtubeTranscriptContainer
      YOUTUBE_TRANSCRIPT_CACHE_TTL_SECONDS: string(youtubeTranscriptCacheTtlSeconds)
      WLH_BASE_URL: '@Microsoft.KeyVault(SecretUri=${wlhBaseUrlSecret.properties.secretUriWithVersion})'
      WLH_STORAGE_ACCOUNT_NAME: privateStorage.name
      WLH_CATEGORY_BLOB_CONTAINER: wlhCategoryBlobContainer
      WLH_CATEGORY_BLOB_NAME: wlhCategoryBlobName
      WEATHER_ENABLED: toLower(string(weatherEnabled))
      GOOGLE_WEATHER_API_KEY: weatherEnabled ? '@Microsoft.KeyVault(SecretUri=${googleWeatherApiKeySecret!.properties.secretUriWithVersion})' : ''
      BRING_ENABLED: toLower(string(bringEnabled))
      BRING_ADD_ENABLED: toLower(string(validatedBringAddEnabled))
      BRING_DESTRUCTIVE_ENABLED: toLower(string(validatedBringDestructiveEnabled))
      BRING_BASE_URL: bringBaseUrl
      BRING_CLIENT_API_KEY: '@Microsoft.KeyVault(SecretUri=${bringClientApiKeySecret.properties.secretUriWithVersion})'
      BRING_COUNTRY: bringCountry
      BRING_EMAIL: '@Microsoft.KeyVault(SecretUri=${bringEmailSecret.properties.secretUriWithVersion})'
      BRING_PASSWORD: '@Microsoft.KeyVault(SecretUri=${bringPasswordSecret.properties.secretUriWithVersion})'
      BRING_EXPECTED_ACCOUNT_FINGERPRINT: validatedBringFingerprint
      BRING_DEFAULT_LIST_UUID: bringDefaultListUuid
      BRING_READABLE_LIST_UUIDS: validatedBringReadableLists
      BRING_WRITABLE_LIST_UUIDS: validatedBringWritableLists
      BRING_WRITABLE_SHARED_LIST_UUIDS: bringWritableSharedListUuids
      BRING_SESSION_CACHE_ENABLED: toLower(string(bringSessionCacheEnabled))
      BRING_SESSION_CACHE_CONTAINER: bringSessionCacheContainer
      BRING_SESSION_CACHE_BLOB: bringSessionCacheBlob
      BRING_MUTATION_CONTAINER: bringMutationContainer
      BRING_AUDIT_CONTAINER: bringAuditContainer
      BRING_STORAGE_ACCOUNT_NAME: privateStorage.name
      BRING_CONFIRMATION_HMAC_KEY: '@Microsoft.KeyVault(SecretUri=${bringConfirmationKeySecret.properties.secretUriWithVersion})'
      BRING_MUTATION_ENCRYPTION_KEY: '@Microsoft.KeyVault(SecretUri=${bringEncryptionKeySecret.properties.secretUriWithVersion})'
      OPENAI_API_KEY: repairableErrorsLlmEnabled ? '@Microsoft.KeyVault(SecretUri=${openAiSecret!.properties.secretUriWithVersion})' : ''
      REPAIRABLE_ERRORS_LLM_ENABLED: toLower(string(repairableErrorsLlmEnabled))
      REPAIRABLE_ERRORS_LLM_MODEL: repairableErrorsLlmModel
    })
  }
}

var storageBlobDataOwnerRole = subscriptionResourceId('Microsoft.Authorization/roleDefinitions', 'b7e6dc6d-f1e8-4753-8033-0f276bb0955b')
var storageBlobDataContributorRole = subscriptionResourceId('Microsoft.Authorization/roleDefinitions', 'ba92f5b4-2d11-453d-a403-e96b0029c9fe')
var storageBlobDataReaderRole = subscriptionResourceId('Microsoft.Authorization/roleDefinitions', '2a2b9908-6ea1-4ae2-8e65-a410df84e7d1')
var storageQueueDataContributorRole = subscriptionResourceId('Microsoft.Authorization/roleDefinitions', '974c5e8b-45b9-4653-ba55-5f855dd0fb88')
var storageTableDataContributorRole = subscriptionResourceId('Microsoft.Authorization/roleDefinitions', '0a9a7e1f-b9d0-4cc4-a60d-0319b160aaa3')
var keyVaultSecretsUserRole = subscriptionResourceId('Microsoft.Authorization/roleDefinitions', '4633458b-17de-408a-b874-0445c86b69e6')

resource functionHostBlobRole 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(hostStorage.id, functionApp.id, 'host-blob-owner')
  scope: hostStorage
  properties: {
    roleDefinitionId: storageBlobDataOwnerRole
    principalId: functionApp.identity.principalId
    principalType: 'ServicePrincipal'
  }
}

resource functionHostQueueRole 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(hostStorage.id, functionApp.id, 'host-queue-contributor')
  scope: hostStorage
  properties: {
    roleDefinitionId: storageQueueDataContributorRole
    principalId: functionApp.identity.principalId
    principalType: 'ServicePrincipal'
  }
}

resource functionHostTableRole 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(hostStorage.id, functionApp.id, 'host-table-contributor')
  scope: hostStorage
  properties: {
    roleDefinitionId: storageTableDataContributorRole
    principalId: functionApp.identity.principalId
    principalType: 'ServicePrincipal'
  }
}

resource functionReleaseReaderRole 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(releaseContainer.id, functionApp.id, 'release-reader')
  scope: releaseContainer
  properties: {
    roleDefinitionId: storageBlobDataReaderRole
    principalId: functionApp.identity.principalId
    principalType: 'ServicePrincipal'
  }
}

resource functionWlhReaderRole 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(wlhReferenceContainer.id, functionApp.id, 'wlh-reader')
  scope: wlhReferenceContainer
  properties: {
    roleDefinitionId: storageBlobDataReaderRole
    principalId: functionApp.identity.principalId
    principalType: 'ServicePrincipal'
  }
  dependsOn: [
    privateStorageDeployment
  ]
}

resource functionRedditSnapshotRole 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(redditThreadSnapshotContainer.id, functionApp.id, 'reddit-snapshot-contributor')
  scope: redditThreadSnapshotContainer
  properties: {
    roleDefinitionId: storageBlobDataContributorRole
    principalId: functionApp.identity.principalId
    principalType: 'ServicePrincipal'
  }
  dependsOn: [
    privateStorageDeployment
  ]
}

resource functionYoutubeTranscriptRole 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(youtubeTranscriptSnapshotContainer.id, functionApp.id, 'youtube-transcript-contributor')
  scope: youtubeTranscriptSnapshotContainer
  properties: {
    roleDefinitionId: storageBlobDataContributorRole
    principalId: functionApp.identity.principalId
    principalType: 'ServicePrincipal'
  }
  dependsOn: [
    privateStorageDeployment
  ]
}

resource functionBringSessionRole 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(bringSessionContainer.id, functionApp.id, 'bring-session-contributor')
  scope: bringSessionContainer
  properties: {
    roleDefinitionId: storageBlobDataContributorRole
    principalId: functionApp.identity.principalId
    principalType: 'ServicePrincipal'
  }
  dependsOn: [
    privateStorageDeployment
  ]
}

resource functionBringMutationRole 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(bringMutationStoreContainer.id, functionApp.id, 'bring-mutation-contributor')
  scope: bringMutationStoreContainer
  properties: {
    roleDefinitionId: storageBlobDataContributorRole
    principalId: functionApp.identity.principalId
    principalType: 'ServicePrincipal'
  }
  dependsOn: [
    privateStorageDeployment
  ]
}

resource functionBringAuditRole 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(bringAuditStoreContainer.id, functionApp.id, 'bring-audit-contributor')
  scope: bringAuditStoreContainer
  properties: {
    roleDefinitionId: storageBlobDataContributorRole
    principalId: functionApp.identity.principalId
    principalType: 'ServicePrincipal'
  }
  dependsOn: [
    privateStorageDeployment
  ]
}

resource functionKeyVaultRole 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(keyVault.id, functionApp.id, 'key-vault-secrets-user')
  scope: keyVault
  properties: {
    roleDefinitionId: keyVaultSecretsUserRole
    principalId: functionApp.identity.principalId
    principalType: 'ServicePrincipal'
  }
}

resource deploymentReleaseWriterRole 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(releaseContainer.id, deploymentPrincipalObjectId, 'deployment-release-writer')
  scope: releaseContainer
  properties: {
    roleDefinitionId: storageBlobDataContributorRole
    principalId: deploymentPrincipalObjectId
    principalType: 'ServicePrincipal'
  }
}

resource deploymentStaticWriterRole 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(staticWebContainer.id, deploymentPrincipalObjectId, 'deployment-static-writer')
  scope: staticWebContainer
  properties: {
    roleDefinitionId: storageBlobDataContributorRole
    principalId: deploymentPrincipalObjectId
    principalType: 'ServicePrincipal'
  }
}

resource actionGroup 'Microsoft.Insights/actionGroups@2023-01-01' = {
  name: actionGroupName
  location: 'global'
  tags: tags
  properties: {
    groupShortName: take('juez${environmentName}', 12)
    enabled: true
    emailReceivers: [
      {
        name: 'operator'
        emailAddress: operatorAlertEmail
        useCommonAlertSchema: true
      }
    ]
  }
}

resource budget 'Microsoft.Consumption/budgets@2024-08-01' = {
  name: 'budget-${workloadName}-${environmentName}'
  properties: {
    amount: validatedBudgetAmount
    category: 'Cost'
    timeGrain: 'Monthly'
    timePeriod: {
      startDate: budgetStartDate
    }
    notifications: {
      actual80: {
        enabled: true
        operator: 'GreaterThanOrEqualTo'
        threshold: 80
        thresholdType: 'Actual'
        contactEmails: [
          operatorAlertEmail
        ]
        contactGroups: [
          actionGroup.id
        ]
        contactRoles: []
      }
      forecast100: {
        enabled: true
        operator: 'GreaterThanOrEqualTo'
        threshold: 100
        thresholdType: 'Forecasted'
        contactEmails: [
          operatorAlertEmail
        ]
        contactGroups: [
          actionGroup.id
        ]
        contactRoles: []
      }
    }
  }
}

output functionAppResourceName string = functionApp.name
output hostStorageAccountResourceName string = hostStorage.name
output releaseStorageAccountResourceName string = releaseStorage.name
output staticWebStorageAccountResourceName string = staticStorage.name
output privateStorageAccountResourceName string = privateStorage.name
output applicationInsightsResourceName string = appInsights.name
output keyVaultResourceName string = keyVault.name
output monthlyBudgetEur int = validatedBudgetAmount
