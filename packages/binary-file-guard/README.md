# @m4ss/pi-binary-file-guard

Block `read` from loading binary files and suggest the right CLI tool instead.

We prefer keeping Pi minimal, no heavy binary parsers, and let the agent handle
the rest via bash. When the model tries to read a binary file, the extension suggests
the right CLI tool: `pdftotext` for PDFs, `sqlite3` for databases, LibreOffice headless
conversion + `pdftotext` for Office documents.

## What is blocked

PDFs, archives (ZIP, tar, gzip, bzip2, xz, zstd, LZ4, 7z, RAR, RPM, CPIO),
executables (ELF, PE, Java serialized objects), databases (SQLite), audio,
video, and more. Known formats are matched by magic-byte signatures; files
that match no signature but still look binary (high null-byte or invalid-UTF-8
ratio) are blocked too.

Supported image formats (PNG, JPEG, GIF, WebP) are not blocked; the LLM can view them directly.
Unsupported image formats (AVIF, HEIC, BMP, ICO) are blocked with conversion hints.

## Examples

The error message includes the file type, the path, and a command-line hint:

```
> read("report.pdf")
Cannot read binary file (PDF): "report.pdf". Use pdftotext (poppler-utils) to extract text: `pdftotext <file> -`

> read("data.db")
Cannot read binary file (SQLite database): "data.db". Query with sqlite3: `sqlite3 <file> '.dump'` or `sqlite3 <file> 'SELECT * FROM <table>'`

> read("project.docx")
Cannot read binary file (ZIP / Office document (DOCX, XLSX, PPTX, ODT)): "project.docx". Unzip the file: `unzip -p <file> '*.xml'`. If this is an Office document, convert to PDF first then extract text: `libreoffice --headless --convert-to pdf <file> --outdir /tmp/office && pdftotext /tmp/office/$(basename <file .ext>).pdf -`

> read("data.tar.gz")
Cannot read binary file (Gzip archive): "data.tar.gz". Decompress first: `gzip -dc <file>` or `zcat <file>`
```

## Install

```bash
pi install npm:@m4ss/pi-binary-file-guard
```

## License

MIT
