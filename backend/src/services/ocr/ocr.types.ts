/**
 * OCR / extraction provider abstraction — PRD §4.1, §11.2, §11.7.
 *
 * §11.2 (in-house model vs third-party API) and §11.7 (whether external
 * providers may process government documents at all) are BOTH still open, and
 * §11.7 is marked a blocking decision for production. So no provider is wired
 * in: the pipeline is built against this interface with a stub behind it, and
 * a real provider becomes a new adapter rather than a rewrite.
 */
export interface ExtractedChunk {
  text: string;
  chunkIndex: number;
  pageNumber?: number;
  section?: string;
}

export interface ExtractedFieldResult {
  fieldName: string;
  value: string;
  /** 0..1. Values at or below OCR_REVIEW_THRESHOLD are flagged for review. */
  confidenceScore: number;
  sourceLocation?: { pageNumber?: number; section?: string; chunkIndex?: number };
}

export interface ExtractionInput {
  buffer: Buffer;
  mimeType: string;
  originalFilename: string;
}

export interface ExtractionResult {
  chunks: ExtractedChunk[];
  fields: ExtractedFieldResult[];
  /** Overall document-level confidence, 0..1. */
  ocrConfidence: number;
}

export interface OcrProvider {
  readonly name: string;
  extract(input: ExtractionInput): Promise<ExtractionResult>;
}
