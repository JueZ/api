targetScope = 'resourceGroup'

@description('Azure region for all v0 resources. Keep westeurope for the production resource group.')
@allowed([
  'westeurope'
])
param location string = 'westeurope'

@description('Short environment name used in resource names and tags.')
@allowed([
  'test'
  'prod'
])
param environmentName string = 'prod'

@description('Workload name used in resource names and tags.')
param workloadName string = 'api-catalogue'

@description('Enable application-level OAuth/OIDC/JWT authentication for protected API routes. Production must use true.')
param authEnabled string = 'false'

@description('Comma-separated OIDC issuer URLs used for JWT issuer validation. When oidcJwksUri is empty, each issuer uses its own OpenID discovery JWKS URI.')
param oidcIssuer string = ''

@description('Expected JWT audience, usually the API application ID URI or client ID.')
param oidcAudience string = ''

@description('Optional explicit JWKS URI. Leave empty to use issuer discovery.')
param oidcJwksUri string = ''

@description('Comma-separated scopes or app roles required by protected API routes.')
param oidcRequiredScopes string = 'api.access'

@description('Comma-separated allowed Microsoft Entra user object IDs.')
param oidcAllowedObjectIds string = ''

@description('Comma-separated allowed subjects used only as fallback when oid is absent.')
param oidcAllowedSubjects string = ''

@description('Comma-separated allowed Microsoft Entra service-principal object IDs for app-only OAuth client-credentials tokens.')
param oidcAllowedAppObjectIds string = ''

@description('Comma-separated allowed Microsoft Entra application/client IDs for app-only OAuth client-credentials tokens.')
param oidcAllowedClientIds string = ''

@description('Optional comma-separated allowed OAuth client application IDs for delegated/user tokens. Leave empty to preserve existing delegated-token behavior.')
param oidcAllowedDelegatedClientIds string = ''

@description('Optional comma-separated allowed tenant IDs.')
param oidcAllowedTenants string = ''

@description('Enable sanitized authentication diagnostics without logging tokens or claims.')
param authDebug string = 'false'


@description('Reddit OAuth client ID for app-only API access.')
param redditClientId string = ''

@secure()
@description('Reddit OAuth client secret for app-only API access.')
param redditOAuthSecret string = ''

@description('Reddit API User-Agent sent on every Reddit request.')
param redditUserAgent string = ''

@description('Comma-separated browser origins allowed to call the Function App API. Needed because Azure Functions handles CORS preflight before app code.')
param apiCorsAllowedOrigins string = ''


@secure()
@description('WLH upstream base URL.')
param wlhBaseUrl string = ''

@description('Private blob container for WLH reference data.')
param wlhCategoryBlobContainer string = 'wlh-reference'

@description('Private blob name for WLH category data.')
param wlhCategoryBlobName string = 'categories-marketplace.v1.json.gz'

@description('Bring! upstream base URL.')
param bringBaseUrl string = 'https://api.getbring.com/rest/'
@description('Unofficial Bring! application/client API key.')
param bringClientApiKey string = ''
@description('Bring! client country.')
param bringCountry string = 'AT'
@secure()
@description('Bring! technical account email.')
param bringEmail string = ''
@secure()
@description('Bring! technical account password.')
param bringPassword string = ''
@description('Optional default Bring! list UUID.')
param bringDefaultListUuid string = ''
@description('Enable durable Bring! authentication-session caching.')
param bringSessionCacheEnabled string = 'true'
@description('Private blob container for Bring! session caching.')
param bringSessionCacheContainer string = 'bring-private'
@description('Private blob name for Bring! session caching.')
param bringSessionCacheBlob string = 'session-v1.json'

@secure()
@description('Optional OpenAI API key used only when Repairable Error Contract LLM-assisted diagnostics are enabled.')
param openAiCredential string = ''

@description('Enable optional Repairable Error Contract LLM-assisted diagnostics. Keep false unless OPENAI_API_KEY is configured.')
param repairableErrorsLlmEnabled string = 'false'

@description('OpenAI model used for optional Repairable Error Contract LLM-assisted diagnostics.')
param repairableErrorsLlmModel string = ''

var nameSuffix = uniqueString(resourceGroup().id, workloadName, environmentName)
var normalizedWorkload = replace(workloadName, '-', '')
var storageAccountName = take('st${normalizedWorkload}${environmentName}${nameSuffix}', 24)
var functionAppName = 'func-${workloadName}-${environmentName}-${nameSuffix}'
var hostingPlanName = 'plan-${workloadName}-${environmentName}-${nameSuffix}'
var appInsightsName = 'appi-${workloadName}-${environmentName}-${nameSuffix}'
var tags = {
  workload: workloadName
  environment: environmentName
  costProfile: 'serverless-consumption'
  region: location
}
var apiCorsAllowedOriginList = empty(apiCorsAllowedOrigins) ? [] : split(apiCorsAllowedOrigins, ',')

resource storageAccount 'Microsoft.Storage/storageAccounts@2023-05-01' = {
  name: storageAccountName
  location: location
  sku: {
    name: 'Standard_LRS'
  }
  kind: 'StorageV2'
  tags: tags
  properties: {
    allowBlobPublicAccess: false
    minimumTlsVersion: 'TLS1_2'
    supportsHttpsTrafficOnly: true
  }
}

resource appInsights 'Microsoft.Insights/components@2020-02-02' = {
  name: appInsightsName
  location: location
  kind: 'web'
  tags: tags
  properties: {
    Application_Type: 'web'
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
    siteConfig: {
      linuxFxVersion: 'NODE|22'
      minTlsVersion: '1.2'
      ftpsState: 'Disabled'
      cors: {
        allowedOrigins: apiCorsAllowedOriginList
        supportCredentials: false
      }
      appSettings: [
        {
          name: 'APPLICATIONINSIGHTS_CONNECTION_STRING'
          value: appInsights.properties.ConnectionString
        }
        {
          name: 'AzureWebJobsStorage__blobServiceUri'
          value: 'https://${storageAccount.name}.blob.${environment().suffixes.storage}'
        }
        {
          name: 'AzureWebJobsStorage__queueServiceUri'
          value: 'https://${storageAccount.name}.queue.${environment().suffixes.storage}'
        }
        {
          name: 'AzureWebJobsStorage__tableServiceUri'
          value: 'https://${storageAccount.name}.table.${environment().suffixes.storage}'
        }
        {
          name: 'AzureWebJobsStorage__credential'
          value: 'managedidentity'
        }
        {
          name: 'FUNCTIONS_EXTENSION_VERSION'
          value: '~4'
        }
        {
          name: 'FUNCTIONS_WORKER_RUNTIME'
          value: 'node'
        }

        {
          name: 'AUTH_ENABLED'
          value: authEnabled
        }
        {
          name: 'OIDC_ISSUER'
          value: oidcIssuer
        }
        {
          name: 'OIDC_AUDIENCE'
          value: oidcAudience
        }
        {
          name: 'OIDC_JWKS_URI'
          value: oidcJwksUri
        }
        {
          name: 'OIDC_REQUIRED_SCOPES'
          value: oidcRequiredScopes
        }
        {
          name: 'OIDC_ALLOWED_OBJECT_IDS'
          value: oidcAllowedObjectIds
        }
        {
          name: 'OIDC_ALLOWED_SUBJECTS'
          value: oidcAllowedSubjects
        }
        {
          name: 'OIDC_ALLOWED_APP_OBJECT_IDS'
          value: oidcAllowedAppObjectIds
        }
        {
          name: 'OIDC_ALLOWED_CLIENT_IDS'
          value: oidcAllowedClientIds
        }
        {
          name: 'OIDC_ALLOWED_DELEGATED_CLIENT_IDS'
          value: oidcAllowedDelegatedClientIds
        }
        {
          name: 'OIDC_ALLOWED_TENANTS'
          value: oidcAllowedTenants
        }
        {
          name: 'AUTH_DEBUG'
          value: authDebug
        }

        {
          name: 'API_CORS_ALLOWED_ORIGINS'
          value: apiCorsAllowedOrigins
        }

        {
          name: 'REDDIT_CLIENT_ID'
          value: redditClientId
        }
        {
          name: 'REDDIT_CLIENT_SECRET'
          value: redditOAuthSecret
        }
        {
          name: 'REDDIT_USER_AGENT'
          value: redditUserAgent
        }

        {
          name: 'WLH_BASE_URL'
          value: wlhBaseUrl
        }
        {
          name: 'WLH_STORAGE_ACCOUNT_NAME'
          value: storageAccount.name
        }
        {
          name: 'WLH_CATEGORY_BLOB_CONTAINER'
          value: wlhCategoryBlobContainer
        }
        {
          name: 'WLH_CATEGORY_BLOB_NAME'
          value: wlhCategoryBlobName
        }
        { name: 'BRING_BASE_URL', value: bringBaseUrl }
        { name: 'BRING_CLIENT_API_KEY', value: bringClientApiKey }
        { name: 'BRING_COUNTRY', value: bringCountry }
        { name: 'BRING_EMAIL', value: bringEmail }
        { name: 'BRING_PASSWORD', value: bringPassword }
        { name: 'BRING_DEFAULT_LIST_UUID', value: bringDefaultListUuid }
        { name: 'BRING_SESSION_CACHE_ENABLED', value: bringSessionCacheEnabled }
        { name: 'BRING_SESSION_CACHE_CONTAINER', value: bringSessionCacheContainer }
        { name: 'BRING_SESSION_CACHE_BLOB', value: bringSessionCacheBlob }
        { name: 'BRING_STORAGE_ACCOUNT_NAME', value: storageAccount.name }

        {
          name: 'OPENAI_API_KEY'
          value: openAiCredential
        }
        {
          name: 'REPAIRABLE_ERRORS_LLM_ENABLED'
          value: repairableErrorsLlmEnabled
        }
        {
          name: 'REPAIRABLE_ERRORS_LLM_MODEL'
          value: repairableErrorsLlmModel
        }
      ]
    }
  }
}

resource functionHostStorageBlobOwnerRoleAssignment 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(storageAccount.id, functionApp.id, 'Storage Blob Data Owner')
  scope: storageAccount
  properties: {
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', 'b7e6dc6d-f1e8-4753-8033-0f276bb0955b')
    principalId: functionApp.identity.principalId
    principalType: 'ServicePrincipal'
  }
}

resource functionHostStorageTableContributorRoleAssignment 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(storageAccount.id, functionApp.id, 'Storage Table Data Contributor')
  scope: storageAccount
  properties: {
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', '0a9a7e1f-b9d0-4cc4-a60d-0319b160aaa3')
    principalId: functionApp.identity.principalId
    principalType: 'ServicePrincipal'
  }
}

output functionAppResourceName string = functionApp.name
output storageAccountResourceName string = storageAccount.name
output applicationInsightsResourceName string = appInsights.name
