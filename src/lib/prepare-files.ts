import imageCompression from 'browser-image-compression';

const MB = 1024 * 1024;
const PDF_AS_IS_LIMIT = 4 * MB;
const TOTAL_LIMIT = 4.3 * MB;
const MAX_WIDTH = 2000;

export class PrepareError extends Error {}

const TOO_BIG = 'הקבצים גדולים מדי (מעל 4.3MB בסך הכול). נסו להעלות פחות עמודים או לצלם בתמונה קטנה יותר.';

const baseName = (name: string) => name.replace(/\.[^.]+$/, '');

async function compressImage(file: File): Promise<File> {
  try {
    return await imageCompression(file, {
      maxWidthOrHeight: MAX_WIDTH,
      fileType: 'image/jpeg',
      initialQuality: 0.85,
      useWebWorker: true,
    });
  } catch {
    throw new PrepareError(`לא הצלחנו לעבד את התמונה "${file.name}". נסו קובץ JPG או PNG.`);
  }
}

async function renderPdfToJpegs(file: File, targetWidth: number, quality: number): Promise<File[]> {
  const pdfjs = await import('pdfjs-dist');
  pdfjs.GlobalWorkerOptions.workerSrc = new URL(
    'pdfjs-dist/build/pdf.worker.min.mjs',
    import.meta.url,
  ).toString();
  const task = pdfjs.getDocument({ data: new Uint8Array(await file.arrayBuffer()) });
  const pdf = await task.promise;
  const pages: File[] = [];
  try {
    for (let i = 1; i <= pdf.numPages; i++) {
      const page = await pdf.getPage(i);
      const base = page.getViewport({ scale: 1 });
      const viewport = page.getViewport({ scale: targetWidth / base.width });
      const canvas = document.createElement('canvas');
      canvas.width = Math.ceil(viewport.width);
      canvas.height = Math.ceil(viewport.height);
      await page.render({ canvas, viewport }).promise;
      const blob = await new Promise<Blob | null>((res) => canvas.toBlob(res, 'image/jpeg', quality));
      canvas.width = canvas.height = 0;
      if (!blob) throw new PrepareError('לא הצלחנו להמיר את קובץ ה-PDF.');
      pages.push(new File([blob], `${baseName(file.name)}-${i}.jpg`, { type: 'image/jpeg' }));
    }
  } finally {
    await task.destroy();
  }
  return pages;
}

async function preparePdf(file: File): Promise<File[]> {
  if (file.size <= PDF_AS_IS_LIMIT) return [file];
  try {
    // Retry with a smaller render if the pages do not fit; prepareFiles enforces the final total limit.
    let pages: File[] = [];
    for (const [width, quality] of [
      [MAX_WIDTH, 0.85],
      [1500, 0.75],
    ] as const) {
      pages = await renderPdfToJpegs(file, width, quality);
      if (pages.reduce((s, p) => s + p.size, 0) <= TOTAL_LIMIT) break;
    }
    return pages;
  } catch (e) {
    if (e instanceof PrepareError) throw e;
    throw new PrepareError(`לא הצלחנו לעבד את קובץ ה-PDF "${file.name}".`);
  }
}

/** Client-side only. Returns the files to upload; throws PrepareError (Hebrew message) when they cannot fit. */
export async function prepareFiles(files: File[]): Promise<File[]> {
  const out: File[] = [];
  for (const file of files) {
    if (file.type === 'application/pdf') out.push(...(await preparePdf(file)));
    else if (file.type.startsWith('image/')) out.push(await compressImage(file));
    else throw new PrepareError(`סוג הקובץ "${file.name}" אינו נתמך. ניתן להעלות PDF או תמונה.`);
  }
  if (out.reduce((s, f) => s + f.size, 0) > TOTAL_LIMIT) throw new PrepareError(TOO_BIG);
  return out;
}
