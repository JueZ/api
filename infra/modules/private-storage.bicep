targetScope = 'resourceGroup'

@description('Azure region for the private integration storage boundary.')
param location string

@description('Explicit deployment environment.')
@allowed([
  'test'
  'prod'
])
param environmentName string

@description('Workload name used in resource names and tags.')
param workloadName string

@description('Deterministic private storage account name supplied by the environment root template.')
param storageAccountName string

@description('Object ID of the environment-specific GitHub Actions OIDC deployment service principal.')
param deploymentPrincipalObjectId string

@description('Private WLH reference-data container.')
param wlhCategoryBlobContainer string

@description('Private Reddit resumable thread-snapshot container.')
param redditSnapshotContainer string

@description('Private Bring session container.')
param bringSessionCacheContainer string

@description('Private Bring mutation replay container.')
param bringMutationContainer string

@description('Private Bring audit container.')
param bringAuditContainer string

var tags = {
  workload: workloadName
  environment: environmentName
  costProfile: 'serverless-consumption'
  dataBoundary: environmentName
  managedBy: 'bicep'
  purpose: 'private-integration-state'
}
var storageBlobDataContributorRole = subscriptionResourceId(
  'Microsoft.Authorization/roleDefinitions',
  'ba92f5b4-2d11-453d-a403-e96b0029c9fe'
)

resource privateStorage 'Microsoft.Storage/storageAccounts@2023-05-01' = {
  name: storageAccountName
  location: location
  sku: {
    name: 'Standard_LRS'
  }
  kind: 'StorageV2'
  tags: tags
  properties: {
    accessTier: 'Hot'
    allowBlobPublicAccess: false
    allowCrossTenantReplication: false
    allowSharedKeyAccess: false
    defaultToOAuthAuthentication: true
    minimumTlsVersion: 'TLS1_2'
    networkAcls: {
      bypass: 'AzureServices'
      defaultAction: 'Allow'
    }
    publicNetworkAccess: 'Enabled'
    supportsHttpsTrafficOnly: true
  }
}

resource privateBlobService 'Microsoft.Storage/storageAccounts/blobServices@2023-05-01' = {
  parent: privateStorage
  name: 'default'
  properties: {
    isVersioningEnabled: true
    deleteRetentionPolicy: {
      enabled: true
      days: 30
    }
    containerDeleteRetentionPolicy: {
      enabled: true
      days: 30
    }
  }
}

resource wlhReferenceContainer 'Microsoft.Storage/storageAccounts/blobServices/containers@2023-05-01' = {
  parent: privateBlobService
  name: wlhCategoryBlobContainer
  properties: {
    publicAccess: 'None'
  }
}

resource redditThreadSnapshotContainer 'Microsoft.Storage/storageAccounts/blobServices/containers@2023-05-01' = {
  parent: privateBlobService
  name: redditSnapshotContainer
  properties: {
    publicAccess: 'None'
  }
}

resource bringSessionContainer 'Microsoft.Storage/storageAccounts/blobServices/containers@2023-05-01' = {
  parent: privateBlobService
  name: bringSessionCacheContainer
  properties: {
    publicAccess: 'None'
  }
}

resource bringMutationStoreContainer 'Microsoft.Storage/storageAccounts/blobServices/containers@2023-05-01' = {
  parent: privateBlobService
  name: bringMutationContainer
  properties: {
    publicAccess: 'None'
  }
}

resource bringAuditStoreContainer 'Microsoft.Storage/storageAccounts/blobServices/containers@2023-05-01' = {
  parent: privateBlobService
  name: bringAuditContainer
  properties: {
    publicAccess: 'None'
  }
}

resource privateLifecycle 'Microsoft.Storage/storageAccounts/managementPolicies@2023-05-01' = {
  parent: privateStorage
  name: 'default'
  properties: {
    policy: {
      rules: [
        {
          name: 'expire-reddit-thread-snapshots'
          enabled: true
          type: 'Lifecycle'
          definition: {
            actions: {
              baseBlob: {
                delete: {
                  daysAfterModificationGreaterThan: 2
                }
              }
              version: {
                delete: {
                  daysAfterCreationGreaterThan: 2
                }
              }
            }
            filters: {
              blobTypes: [
                'blockBlob'
              ]
              prefixMatch: [
                '${redditSnapshotContainer}/snapshots/'
              ]
            }
          }
        }
        {
          name: 'expire-bring-replay-records'
          enabled: true
          type: 'Lifecycle'
          definition: {
            actions: {
              baseBlob: {
                delete: {
                  daysAfterModificationGreaterThan: 35
                }
              }
              version: {
                delete: {
                  daysAfterCreationGreaterThan: 35
                }
              }
            }
            filters: {
              blobTypes: [
                'blockBlob'
              ]
              prefixMatch: [
                '${bringMutationContainer}/operations/'
              ]
            }
          }
        }
        {
          name: 'retain-bring-audit-for-one-year'
          enabled: true
          type: 'Lifecycle'
          definition: {
            actions: {
              baseBlob: {
                delete: {
                  daysAfterModificationGreaterThan: 365
                }
              }
            }
            filters: {
              blobTypes: [
                'blockBlob'
              ]
              prefixMatch: [
                '${bringAuditContainer}/events/'
              ]
            }
          }
        }
        {
          name: 'expire-private-blob-versions'
          enabled: true
          type: 'Lifecycle'
          definition: {
            actions: {
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
            }
          }
        }
      ]
    }
  }
}

resource deploymentWlhWriterRole 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(wlhReferenceContainer.id, deploymentPrincipalObjectId, 'deployment-wlh-writer')
  scope: wlhReferenceContainer
  properties: {
    roleDefinitionId: storageBlobDataContributorRole
    principalId: deploymentPrincipalObjectId
    principalType: 'ServicePrincipal'
  }
}

output storageAccountName string = privateStorage.name
output storageAccountId string = privateStorage.id
output wlhReferenceContainerId string = wlhReferenceContainer.id
output redditThreadSnapshotContainerId string = redditThreadSnapshotContainer.id
