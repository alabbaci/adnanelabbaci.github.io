// Turns picked files into model-ready inline parts.
//
// The whole request travels as inline base64, and the API caps a request at
// roughly 20 MB, so photos are downscaled hard and video is size-checked
// before it can blow the budget. A field phone on 3G also thanks us for it.
const MAX_EDGE = 1152;
const JPEG_QUALITY = 0.85;
const MAX_VIDEO_BYTES = 14 * 1024 * 1024;
const MAX_TOTAL_BYTES = 18 * 1024 * 1024;

export async function fileToPhoto(file) {
  if (!file.type.startsWith('image/')) throw new Error('Ce fichier n\'est pas une image.');
  const bitmap = await loadBitmap(file);
  const scale = Math.min(1, MAX_EDGE / Math.max(bitmap.width, bitmap.height));
  const w = Math.round(bitmap.width * scale);
  const h = Math.round(bitmap.height * scale);

  const canvas = document.createElement('canvas');
  canvas.width = w; canvas.height = h;
  canvas.getContext('2d').drawImage(bitmap, 0, 0, w, h);
  if (bitmap.close) bitmap.close();

  const dataUrl = canvas.toDataURL('image/jpeg', JPEG_QUALITY);
  return {
    kind: 'image',
    mime: 'image/jpeg',
    base64: dataUrl.split(',')[1],
    preview: dataUrl,
    bytes: Math.round(dataUrl.length * 0.75),
    w, h
  };
}

export async function fileToVideo(file) {
  if (!file.type.startsWith('video/')) throw new Error('Ce fichier n\'est pas une vidéo.');
  if (file.size > MAX_VIDEO_BYTES) {
    throw new Error(`Vidéo trop lourde (${mb(file.size)} Mo). Filmez 10 à 15 secondes maximum, en qualité standard.`);
  }
  const base64 = await fileToBase64(file);
  return {
    kind: 'video',
    mime: file.type,
    base64,
    preview: URL.createObjectURL(file),
    bytes: file.size
  };
}

export function totalBytes(media) {
  return media.reduce((sum, m) => sum + (m.bytes || 0), 0);
}

export function overBudget(media) {
  return totalBytes(media) > MAX_TOTAL_BYTES;
}

export function mb(bytes) {
  return (bytes / (1024 * 1024)).toFixed(1);
}

// A small thumbnail kept in history: the full-size base64 would fill
// localStorage after a handful of diagnoses.
export function thumbnail(photo, edge = 160) {
  return new Promise(resolve => {
    const img = new Image();
    img.onload = () => {
      const scale = Math.min(1, edge / Math.max(img.width, img.height));
      const canvas = document.createElement('canvas');
      canvas.width = Math.round(img.width * scale);
      canvas.height = Math.round(img.height * scale);
      canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
      resolve(canvas.toDataURL('image/jpeg', 0.6));
    };
    img.onerror = () => resolve('');
    img.src = photo.preview;
  });
}

async function loadBitmap(file) {
  if (window.createImageBitmap) {
    try { return await createImageBitmap(file); } catch { /* Safari/HEIC fallback */ }
  }
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => { URL.revokeObjectURL(url); resolve(img); };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('Image illisible.')); };
    img.src = url;
  });
}

function fileToBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(',')[1]);
    reader.onerror = () => reject(new Error('Lecture du fichier impossible.'));
    reader.readAsDataURL(file);
  });
}
