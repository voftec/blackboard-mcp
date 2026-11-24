import JSZip from "jszip";
import { extractText, getDocumentProxy } from "unpdf";
import { htmlToText } from "./model.js";

export interface ExtractedText {
  kind: "pdf" | "docx" | "pptx" | "xlsx" | "text";
  text: string;
  pages?: number;
}

const TEXT_EXTENSIONS = new Set(["txt", "md", "csv", "json", "xml", "html", "htm", "sql", "py", "js", "ts", "java", "c", "cpp", "h", "vhd", "v"]);

function tidy(text: string): string {
  return text.replace(/\r/g, "").replace(/[ \t]+/g, " ").replace(/\n{3,}/g, "\n\n").trim();
}

function xmlText(xml: string, tag: string): string[] {
  const re = new RegExp(`<${tag}(?:\\s[^>]*)?>([^<]*)</${tag}>`, "g");
  return [...xml.matchAll(re)].map((m) => m[1]);
}

const decode = (s: string) => s.replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'");

async function officeText(buffer: Buffer, ext: string): Promise<ExtractedText> {
  const zip = await JSZip.loadAsync(buffer);
  const read = (name: string) => zip.file(name)?.async("string");
  if (ext === "docx") {
    const xml = (await read("word/document.xml")) ?? "";
    const paragraphs = xml.split(/<\/w:p>/).map((p) => decode(xmlText(p, "w:t").join(""))).filter(Boolean);
    return { kind: "docx", text: tidy(paragraphs.join("\n")) };
  }
  if (ext === "pptx") {
    const slides = Object.keys(zip.files)
      .filter((n) => /^ppt\/slides\/slide\d+\.xml$/.test(n))
      .sort((a, b) => Number(/\d+/.exec(a.slice(11))?.[0]) - Number(/\d+/.exec(b.slice(11))?.[0]));
    const parts = await Promise.all(
      slides.map(async (name, i) => {
        const xml = (await read(name)) ?? "";
        const paragraphs = xml.split(/<\/a:p>/).map((p) => decode(xmlText(p, "a:t").join(""))).filter(Boolean);
        return `--- Slide ${i + 1} ---\n${paragraphs.join("\n")}`;
      })
    );
    return { kind: "pptx", text: tidy(parts.join("\n\n")), pages: slides.length };
  }
  const shared = xmlText((await read("xl/sharedStrings.xml")) ?? "", "t").map(decode);
  return { kind: "xlsx", text: tidy(shared.join("\n")) };
}

/** Extracts readable text from a downloaded file. Supports PDF, DOCX, PPTX, XLSX and plain-text formats. */
export async function fileToText(buffer: Buffer, fileName = "", mimeType = ""): Promise<ExtractedText> {
  const ext = fileName.toLowerCase().split(".").pop() ?? "";
  if (ext === "pdf" || mimeType.includes("pdf") || buffer.subarray(0, 5).toString() === "%PDF-") {
    const pdf = await getDocumentProxy(new Uint8Array(buffer));
    const { text, totalPages } = await extractText(pdf, { mergePages: true });
    return { kind: "pdf", text: tidy(text), pages: totalPages };
  }
  if (["docx", "pptx", "xlsx"].includes(ext) || mimeType.includes("officedocument")) return officeText(buffer, ext || (mimeType.includes("presentation") ? "pptx" : mimeType.includes("sheet") ? "xlsx" : "docx"));
  if (TEXT_EXTENSIONS.has(ext) || mimeType.startsWith("text/")) {
    const raw = buffer.toString("utf8");
    return { kind: "text", text: ext === "html" || ext === "htm" || mimeType.includes("html") ? (htmlToText(raw, Number.MAX_SAFE_INTEGER) ?? "") : tidy(raw) };
  }
  throw new Error(`Cannot extract text from "${fileName || mimeType || "file"}" (only PDF, DOCX, PPTX, XLSX and text files are supported). Use download_file to save it instead.`);
}
