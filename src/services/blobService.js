const { blobServiceClient, containerName } = require('../config/azureClient');

class BlobService {
  constructor(containerName, blobServiceClient) {
    this.containerName = containerName;
    this.blobServiceClient = blobServiceClient;
    
    if (this.blobServiceClient && this.containerName) {
      this.containerClient = this.blobServiceClient.getContainerClient(this.containerName);
    } else {
      this.containerClient = null;
      console.warn('BlobService initialized without Azure credentials');
    }
  }

  async ensureContainer() {
    if (!this.containerClient) {
      throw new Error('Blob storage not configured');
    }
    await this.containerClient.createIfNotExists();
  }

  async uploadBuffer(blobName, buffer, contentType) {
    if (!this.containerClient) {
      throw new Error('Blob storage not configured');
    }
    
    await this.ensureContainer();
    const blockBlobClient = this.containerClient.getBlockBlobClient(blobName);
    await blockBlobClient.uploadData(buffer, {
      blobHTTPHeaders: { blobContentType: contentType }
    });
    return blockBlobClient.url;
  }

  async downloadToStream(blobName, res, contentType, fileName) {
    if (!this.containerClient) {
      throw new Error('Blob storage not configured');
    }
    
    await this.ensureContainer();
    const blockBlobClient = this.containerClient.getBlockBlobClient(blobName);

    if (!(await blockBlobClient.exists())) {
      throw new Error('Blob not found');
    }

    res.setHeader('Content-Type', contentType || 'application/octet-stream');
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="${fileName || blobName}"`
    );

    const downloadResponse = await blockBlobClient.download(0);
    downloadResponse.readableStreamBody.pipe(res);
  }

  async deleteBlob(blobName) {
    if (!this.containerClient) {
      throw new Error('Blob storage not configured');
    }
    
    await this.ensureContainer();
    const blockBlobClient = this.containerClient.getBlockBlobClient(blobName);
    await blockBlobClient.delete();
    return true;
  }

  async blobExists(blobName) {
    if (!this.containerClient) {
      return false;
    }
    
    try {
      const blockBlobClient = this.containerClient.getBlockBlobClient(blobName);
      return await blockBlobClient.exists();
    } catch (error) {
      console.error('Failed to check blob existence:', error);
      return false;
    }
  }
}

module.exports = new BlobService(containerName, blobServiceClient);