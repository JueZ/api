targetScope = 'resourceGroup'

@description('Azure region for all v0 resources. Keep westeurope for the production resource group.')
@allowed([
  'westeurope'
])
param location string = 'westeurope'

@description('Short environment name used in resource names and tags.')
param environmentName string = 'prod'

@description('Workload name used in resource names and tags.')
param workloadName string = 'api-catalogue'

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
      appSettings: [
        {
          name: 'APPLICATIONINSIGHTS_CONNECTION_STRING'
          value: appInsights.properties.ConnectionString
        }
        {
          name: 'AzureWebJobsStorage'
          value: 'DefaultEndpointsProtocol=https;AccountName=${storageAccount.name};EndpointSuffix=${environment().suffixes.storage};AccountKey=${storageAccount.listKeys().keys[0].value}'
        }
        {
          name: 'FUNCTIONS_EXTENSION_VERSION'
          value: '~4'
        }
        {
          name: 'FUNCTIONS_WORKER_RUNTIME'
          value: 'node'
        }
      ]
    }
  }
}

resource functionPackageReaderRoleAssignment 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(storageAccount.id, functionApp.id, 'Storage Blob Data Reader')
  scope: storageAccount
  properties: {
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', '2a2b9908-6ea1-4ae2-8e65-a410df84e7d1')
    principalId: functionApp.identity.principalId
    principalType: 'ServicePrincipal'
  }
}

output functionAppResourceName string = functionApp.name
output storageAccountResourceName string = storageAccount.name
output applicationInsightsResourceName string = appInsights.name
