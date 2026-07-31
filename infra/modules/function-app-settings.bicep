targetScope = 'resourceGroup'

@description('Name of the existing Azure Function App whose complete settings are reconciled.')
param functionAppName string

@secure()
@description('Complete managed Function App settings, including preserved release-owned values.')
param appSettings object

resource functionApp 'Microsoft.Web/sites@2023-12-01' existing = {
  name: functionAppName
}

resource appSettingsResource 'Microsoft.Web/sites/config@2023-12-01' = {
  parent: functionApp
  name: 'appsettings'
  properties: appSettings
}
