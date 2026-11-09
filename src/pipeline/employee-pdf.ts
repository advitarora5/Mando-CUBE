import { Worker } from "node:worker_threads";

export function employeePdfText(bytes: Uint8Array): Promise<string> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL("./employee-pdf-worker.mjs", import.meta.url), {
      workerData: bytes, resourceLimits: { maxOldGenerationSizeMb: 384 },
    });
    const timeout = setTimeout(() => { void worker.terminate(); reject(new Error("PDF extraction timed out.")); }, 10000);
    worker.once("message", (result: { text?: string; error?: string }) => {
      clearTimeout(timeout);
      void worker.terminate();
      if (typeof result.text === "string") resolve(result.text);
      else reject(new Error(result.error ?? "PDF extraction failed."));
    });
    worker.once("error", error => { clearTimeout(timeout); reject(error); });
    worker.once("exit", () => { clearTimeout(timeout); reject(new Error("PDF extraction worker stopped.")); });
  });
}
