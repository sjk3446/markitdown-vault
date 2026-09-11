# Formats, engines, and credit use

## Built-in/local conversion

Microsoft MarkItDown documents these source categories: PDF; PowerPoint; Word; Excel including legacy XLS; images with metadata and OCR; WAV/MP3 audio with metadata and speech transcription; HTML; CSV, JSON, XML and other text formats; ZIP archives; YouTube URLs/transcripts; EPUB; Outlook messages; Jupyter notebooks; RSS/Atom; Wikipedia pages; and Bing search result pages. Exact detection is delegated to the installed MarkItDown version so newly supported formats do not require a wrapper update.

Install the `[all]` extra to enable every official optional converter. Third-party formats require an installed MarkItDown plugin and `--plugins`.

Ordinary document conversion runs locally and makes no OpenAI, Gemini, or Claude API request. Remote URLs require `--allow-remote`. Built-in audio transcription uses the Google speech-recognition service and therefore requires `--allow-network-transcription`; this service is separate from the selected Gemini API account.

## LLM enhancement

MarkItDown accepts an OpenAI-compatible client for image descriptions. The official `markitdown-ocr` plugin applies the same client to images embedded in PDF, DOCX, PPTX, and XLSX files.

| Selection | Credential | API credits | Typical use |
|---|---|---:|---|
| `--provider none` | none | none | Default text/table extraction |
| `--provider openai` | `OPENAI_API_KEY` | OpenAI API account | Image descriptions or LLM OCR |
| `--provider gemini` | `GEMINI_API_KEY` or `GOOGLE_API_KEY` | Gemini Developer API project | Image descriptions or LLM OCR through Google's OpenAI-compatible endpoint |
| `--provider claude` | `ANTHROPIC_API_KEY` | Anthropic Console/API account | Image descriptions or LLM OCR through Anthropic's OpenAI SDK compatibility endpoint |

Provider selection affects optional LLM calls made by MarkItDown; it does not move the whole document conversion into GPT, Gemini, or Claude. `--ocr` requires `openai`, `gemini`, or `claude`.

Google AI Pro is a consumer subscription and does not itself guarantee paid Gemini Developer API quota or credits. The API key's Google Cloud/AI Studio project controls quota and billing.

## Docling local engine

- `--engine docling --provider none`: high-accuracy local document conversion with layout, table, formula, reading-order, and OCR analysis.
- Docling consumes no OpenAI, Gemini, Claude, or Azure API credits and does not upload documents to a conversion server.
- Initial installation and first model preparation may download dependencies or model assets. Later conversion runs locally and can require substantially more CPU, memory, and time than the built-in MarkItDown engine.
- Docling and external AI image/OCR enhancement are intentionally mutually exclusive in this app so a local-only selection cannot accidentally use an API.

## Azure engines

- `--engine docintel`: Azure Document Intelligence layout extraction. Requires `MARKITDOWN_DOCINTEL_ENDPOINT` or `--docintel-endpoint`, plus Azure credentials supported by MarkItDown.
- `--engine cu`: Azure Content Understanding for higher-quality multimodal conversion, structured YAML fields, custom analyzers, audio, and video. Requires `MARKITDOWN_CU_ENDPOINT` or `--cu-endpoint`; `--cu-analyzer-id` is optional.

Both Azure engines may incur Azure charges. They are independent of the LLM provider setting.

## Windows OCR note

The PDF OCR plugin normally renders pages with `pdfplumber`/`pypdfium2`. Its secondary PyMuPDF fallback for malformed PDFs can be blocked by Windows Application Control on tightly managed PCs. Check both fields in `status`; ordinary PDFs remain OCR-capable when the primary backend is `ok`.

## Provider models

The wrapper defaults are intentionally overridable because model availability changes:

- OpenAI: `MARKITDOWN_OPENAI_MODEL`, otherwise `gpt-4o-mini`
- Gemini: `MARKITDOWN_GEMINI_MODEL`, otherwise `gemini-2.5-flash`
- Claude: `MARKITDOWN_CLAUDE_MODEL`, otherwise `claude-sonnet-5`

Use `--model` for a one-off choice.
