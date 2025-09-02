const { blobServiceClient, containerName } = require('./azureClient');

class BlobService {
  constructor(containerName, blobServiceClient) {
    this.containerName = containerName;
    this.blobServiceClient = blobServiceClient;
    this.containerClient = this.blobServiceClient.getContainerClient(this.containerName);
  }

  async ensureContainer() {
    await this.containerClient.createIfNotExists();
  }

  // Upload a Buffer (used for multer.memoryStorage)
  async uploadBuffer(blobName, buffer, contentType) {
    await this.ensureContainer();
    const blockBlobClient = this.containerClient.getBlockBlobClient(blobName);
    await blockBlobClient.uploadData(buffer, {
      blobHTTPHeaders: { blobContentType: contentType }
    });
    return blockBlobClient.url;
  }

 async downloadToStream(blobName, res, contentType, fileName) {
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


}

module.exports = new BlobService(containerName, blobServiceClient);
