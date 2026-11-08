import { runParserCode } from '../parsers/sandbox';

self.onmessage = (e: MessageEvent<{ code: string; text: string; filename: string }>) => {
  try {
    self.postMessage({ ok: true, rows: runParserCode(e.data.code, e.data.text, e.data.filename) });
  } catch (err) {
    self.postMessage({ ok: false, error: String(err instanceof Error ? err.message : err) });
  }
};
