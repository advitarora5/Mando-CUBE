import { parentPort, workerData } from 'node:worker_threads';
import { PDFParse } from 'pdf-parse';
const parser = new PDFParse({ data: new Uint8Array(workerData), isEvalSupported: false });
try {
  const result = await parser.getText({ first: 1, last: 300 });
  parentPort.postMessage({ text: result.text.slice(0, 1500000) });
} catch {
  parentPort.postMessage({ error: 'PDF text extraction failed.' });
} finally {
  await parser.destroy();
}
