/* Images are decoded, resized and re-encoded locally, then encrypted before upload. */
globalThis.SilenzaImages = {
  async prepare(file) {
    if (!['image/jpeg', 'image/png', 'image/webp'].includes(file.type)) throw new Error('Choose a JPEG, PNG or WebP image.');
    if (file.size > 12 * 1024 * 1024) throw new Error('Choose an image smaller than 12 MB.');
    const bitmap = await createImageBitmap(file);
    try {
      if (bitmap.width * bitmap.height > 32000000) throw new Error('Choose an image smaller than 32 megapixels.');
      const scale = Math.min(1, 2048 / Math.max(bitmap.width, bitmap.height));
      const canvas = document.createElement('canvas');
      canvas.width = Math.max(1, Math.round(bitmap.width * scale)); canvas.height = Math.max(1, Math.round(bitmap.height * scale));
      canvas.getContext('2d').drawImage(bitmap, 0, 0, canvas.width, canvas.height);
      const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/webp', 0.85));
      if (!blob || blob.type !== 'image/webp') throw new Error('Your browser could not prepare this image.');
      if (blob.size > 4 * 1024 * 1024) throw new Error('This image is too large after resizing. Choose a smaller one.');
      return { blob, width: canvas.width, height: canvas.height, size: blob.size, type: blob.type };
    } finally { bitmap.close(); }
  }
};
