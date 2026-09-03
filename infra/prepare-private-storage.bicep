targetScope = 'resourceGroup'

@description('Azure region for the production private integration storage boundary.')
@allowed([
  'westeurope'
])
param location string = 'westeurope'

@description('This bounded preparation template is production-only.')
@allowed([
  'prod'
])
param environmentName string

@description('Workload name used in resource names and tags.')
param workloadName string = 'api-catalogue'

@description('Object ID of the production GitHub Actions OIDC deployment service principal.')
param deploymentPrincipalObjectId string

@description('Private WLH reference-data container.')
param wlhCategoryBlobContainer string = 'wlh-reference'

@description('Private Reddit resumable thread-snapshot container.')
param redditSnapshotContainer string = 'reddit-snapshots'

@description('Private YouTube transcript snapshot container.')
param youtubeTranscriptContainer string = 'youtube-transcripts'

@description('Private Bring session container.')
param bringSessionCacheContainer string = 'bring-private'

@description('Private Bring mutation replay container.')
param bringMutationContainer string = 'bring-mutations'

@description('Private Bring audit container.')
param bringAuditContainer string = 'bring-audit'

var nameSuffix = uniqueString(resourceGroup().id, workloadName, environmentName)
var normalizedWorkload = replace(workloadName, '-', '')
var privateStorageName = take('st${normalizedWorkload}${environmentName}p${nameSuffix}', 24)

module privateStorage './modules/private-storage.bicep' = {
  name: 'prepare-private-storage-${environmentName}'
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

output privateStorageAccountResourceName string = privateStorage.outputs.storageAccountName
output privateStorageAccountResourceId string = privateStorage.outputs.storageAccountId
output wlhReferenceContainerResourceId string = privateStorage.outputs.wlhReferenceContainerId
