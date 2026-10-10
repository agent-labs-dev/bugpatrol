import type { SampleFile } from '@bugpatrol/core';
import { PNG } from 'pngjs';

export type FilePayload = { name: string; mimeType: string; buffer: Buffer };

/** A 320x240 gradient: large enough for apps that reject tiny images, and identical on every run. */
function image(): Buffer {
  const png = new PNG({ width: 320, height: 240 });
  for (let y = 0; y < png.height; y++) {
    for (let x = 0; x < png.width; x++) {
      const i = (png.width * y + x) << 2;
      png.data[i] = Math.round((x / png.width) * 255);
      png.data[i + 1] = Math.round((y / png.height) * 255);
      png.data[i + 2] = 160;
      png.data[i + 3] = 255;
    }
  }
  return PNG.sync.write(png);
}

/** A one-page PDF with a line of text, with a correct cross-reference table. */
function pdf(): Buffer {
  const content = 'BT /F1 18 Tf 72 720 Td (Bugpatrol sample document) Tj ET';
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
    `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];
  let body = '%PDF-1.4\n';
  const offsets = objects.map((object, index) => {
    const offset = body.length;
    body += `${index + 1} 0 obj\n${object}\nendobj\n`;
    return offset;
  });
  const xref = body.length;
  body += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  body += offsets.map((offset) => `${String(offset).padStart(10, '0')} 00000 n \n`).join('');
  body += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(body, 'latin1');
}

export function sampleFile(file: SampleFile): FilePayload {
  switch (file) {
    case 'image':
      return { name: 'bugpatrol-sample.png', mimeType: 'image/png', buffer: image() };
    case 'pdf':
      return { name: 'bugpatrol-sample.pdf', mimeType: 'application/pdf', buffer: pdf() };
    case 'text':
      return { name: 'bugpatrol-sample.txt', mimeType: 'text/plain', buffer: Buffer.from('Bugpatrol sample file\n') };
  }
}
