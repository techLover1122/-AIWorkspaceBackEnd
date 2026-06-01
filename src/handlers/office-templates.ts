import AdmZip from "adm-zip";

/**
 * Minimum-valid empty DOCX / XLSX generators.
 *
 * Used by handleEditorConfig when a fileId is opened for the first time
 * — ONLYOFFICE needs valid OOXML bytes at the document.url, so a 404 on
 * first open produces a "DownloadFailed" error in the editor. Rather
 * than checking binary templates into the repo or bringing in a heavy
 * generator lib (docx / exceljs), we build the four-or-five OOXML stub
 * parts inline and zip them up with the already-installed adm-zip.
 *
 * The XML below is the absolute minimum each editor accepts on open:
 *   DOCX → [Content_Types], _rels/.rels, word/document.xml
 *   XLSX → [Content_Types], _rels/.rels, xl/workbook.xml +
 *          xl/_rels/workbook.xml.rels, xl/worksheets/sheet1.xml
 *
 * Both files come out around 1 KB. They are byte-stable: two calls
 * produce identical buffers (adm-zip writes deterministic ZIPs when
 * adding string entries in a fixed order).
 */

/* ─────────────────────────── DOCX ─────────────────────────── */

const DOCX_CONTENT_TYPES = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
</Types>
`;

const DOCX_PACKAGE_RELS = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
</Relationships>
`;

const DOCX_DOCUMENT = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:body>
    <w:p/>
    <w:sectPr/>
  </w:body>
</w:document>
`;

export function buildEmptyDocx(): Buffer {
  const zip = new AdmZip();
  // Order matters for byte-stability — keep these calls together.
  zip.addFile("[Content_Types].xml", Buffer.from(DOCX_CONTENT_TYPES, "utf8"));
  zip.addFile("_rels/.rels", Buffer.from(DOCX_PACKAGE_RELS, "utf8"));
  zip.addFile("word/document.xml", Buffer.from(DOCX_DOCUMENT, "utf8"));
  return zip.toBuffer();
}

/* ─────────────────────────── XLSX ─────────────────────────── */

const XLSX_CONTENT_TYPES = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
  <Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>
</Types>
`;

const XLSX_PACKAGE_RELS = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>
</Relationships>
`;

const XLSX_WORKBOOK = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
  <sheets>
    <sheet name="Sheet1" sheetId="1" r:id="rId1"/>
  </sheets>
</workbook>
`;

const XLSX_WORKBOOK_RELS = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>
</Relationships>
`;

const XLSX_SHEET1 = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
  <sheetData/>
</worksheet>
`;

export function buildEmptyXlsx(): Buffer {
  const zip = new AdmZip();
  zip.addFile("[Content_Types].xml", Buffer.from(XLSX_CONTENT_TYPES, "utf8"));
  zip.addFile("_rels/.rels", Buffer.from(XLSX_PACKAGE_RELS, "utf8"));
  zip.addFile("xl/workbook.xml", Buffer.from(XLSX_WORKBOOK, "utf8"));
  zip.addFile(
    "xl/_rels/workbook.xml.rels",
    Buffer.from(XLSX_WORKBOOK_RELS, "utf8")
  );
  zip.addFile(
    "xl/worksheets/sheet1.xml",
    Buffer.from(XLSX_SHEET1, "utf8")
  );
  return zip.toBuffer();
}

/** Pick the right empty-file generator for a file type. */
export function buildEmptyOffice(type: "docx" | "xlsx"): Buffer {
  return type === "xlsx" ? buildEmptyXlsx() : buildEmptyDocx();
}
