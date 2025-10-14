require('dotenv').config();
const { BlobServiceClient, StorageSharedKeyCredential } = require('@azure/storage-blob');

const accountName = process.env.AZURE_STORAGE_ACCOUNT;
const accountKey = process.env.AZURE_STORAGE_KEY;
const containerName = process.env.AZURE_STORAGE_CONTAINER;

if (!accountName || !accountKey) {
  console.warn('Azure Storage credentials not found. Blob storage will not be available.');
  module.exports = {
    blobServiceClient: null,
    containerName: null
  };
} else {
  const sharedKeyCredential = new StorageSharedKeyCredential(accountName, accountKey);
  const blobServiceClient = new BlobServiceClient(
    `https://${accountName}.blob.core.windows.net`,
    sharedKeyCredential
  );

  module.exports = {
    blobServiceClient,
    containerName
  };
}