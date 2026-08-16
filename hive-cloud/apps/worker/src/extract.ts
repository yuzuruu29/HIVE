import * as pdfParseModule from "pdf-parse";
const pdfParse = (pdfParseModule as any).default || pdfParseModule;

export async function extractText(buffer: Buffer, mimeType: string): Promise<string | undefined> {
  if (mimeType.startsWith("text/")) {
    const text = buffer.toString("utf8");
    return text.slice(0, 120_000);
  }
  
  if (mimeType === "application/pdf") {
    try {
      const data = await pdfParse(buffer);
      return data.text.slice(0, 120_000);
    } catch (e) {
      console.error("Failed to parse PDF:", e);
      return undefined;
    }
  }

  // If it's an image or something else, we don't have text extraction for now
  return undefined;
}
