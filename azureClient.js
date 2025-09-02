require('dotenv').config();
const { BlobServiceClient, StorageSharedKeyCredential } = require('@azure/storage-blob');

const accountName = process.env.AZURE_STORAGE_ACCOUNT;
const accountKey = process.env.AZURE_STORAGE_KEY;
const containerName = process.env.AZURE_STORAGE_CONTAINER;

if (!accountName || !accountKey) {
  throw new Error('AZURE_STORAGE_ACCOUNT and AZURE_STORAGE_KEY must be set in env');
}

const sharedKeyCredential = new StorageSharedKeyCredential(accountName, accountKey);
const blobServiceClient = new BlobServiceClient(
  `https://${accountName}.blob.core.windows.net`,
  sharedKeyCredential
);

module.exports = { blobServiceClient, containerName };
