import { Buffer } from 'node:buffer';
import { deflateRawSync, inflateRawSync } from 'node:zlib';
import { Money } from '@retailos/core';

const MAX_UPLOAD_BYTES = 10 * 1024 * 1024; // 10 MB
const MAX_ZIP_ENTRIES = 256;
const MAX_ENTRY_UNCOMPRESSED_BYTES = 20 * 1024 * 1024;
const MAX_TOTAL_UNCOMPRESSED_BYTES = 40 * 1024 * 1024;
const MAX_IMPORT_ROWS = 2500;

export const OPENING_TEMPLATE_COLUMNS = [
  { key: 'name', header: 'اسم الصنف', width: 28, style: 0 },
  { key: 'category', header: 'النوع / الفئة', width: 18, style: 0 },
  { key: 'modelSku', header: 'كود الموديل', width: 18, style: 2 },
  { key: 'color', header: 'اللون', width: 14, style: 2 },
  { key: 'size', header: 'المقاس', width: 12, style: 2 },
  { key: 'quantity', header: 'الكمية', width: 12, style: 3 },
  { key: 'unitCost', header: 'سعر التكلفة (جنيه)', width: 20, style: 4 },
  { key: 'retailPrice', header: 'سعر البيع (جنيه)', width: 18, style: 4 },
  { key: 'barcode', header: 'الباركود (اختياري)', width: 22, style: 2 },
  { key: 'reorderPoint', header: 'حد إعادة الطلب', width: 16, style: 3 },
  { key: 'brand', header: 'الماركة (اختياري)', width: 16, style: 2 },
];

const OPENING_TEMPLATE_SAMPLE_ROWS = [
  {
    name: 'قميص قطن كلاسيك',
    category: 'قمصان رجالي',
    modelSku: 'SHIRT-CL-101',
    color: 'أبيض',
    size: 'M',
    quantity: 12,
    unitCost: '220.00',
    retailPrice: '390.00',
    barcode: '6223001010011',
    reorderPoint: 3,
    brand: 'Raff Basics',
  },
  {
    name: 'قميص قطن كلاسيك',
    category: 'قمصان رجالي',
    modelSku: 'SHIRT-CL-101',
    color: 'أبيض',
    size: 'L',
    quantity: 15,
    unitCost: '220.00',
    retailPrice: '390.00',
    barcode: '6223001010028',
    reorderPoint: 3,
    brand: 'Raff Basics',
  },
  {
    name: 'قميص قطن كلاسيك',
    category: 'قمصان رجالي',
    modelSku: 'SHIRT-CL-101',
    color: 'كحلي',
    size: 'L',
    quantity: 10,
    unitCost: '220.00',
    retailPrice: '390.00',
    barcode: '6223001010035',
    reorderPoint: 3,
    brand: 'Raff Basics',
  },
  {
    name: 'بنطلون جينز سليم',
    category: 'بنطلونات',
    modelSku: 'JEANS-SL-204',
    color: 'أزرق غامق',
    size: '32',
    quantity: 8,
    unitCost: '310.50',
    retailPrice: '550.00',
    barcode: '6223002040324',
    reorderPoint: 2,
    brand: 'Raff Denim',
  },
  {
    name: 'حزام جلد طبيعي',
    category: 'إكسسوارات',
    modelSku: 'BELT-901',
    color: '',
    size: '',
    quantity: 20,
    unitCost: '95.00',
    retailPrice: '180.00',
    barcode: '',
    reorderPoint: 5,
    brand: '',
  },
];

const COLOR_SKU_TOKENS = {
  أسود: 'BLK',
  اسود: 'BLK',
  أبيض: 'WHT',
  ابيض: 'WHT',
  كحلي: 'NVY',
  رمادي: 'GRY',
  رصاصي: 'GRY',
  بيج: 'BGE',
  أحمر: 'RED',
  احمر: 'RED',
  أزرق: 'BLU',
  ازرق: 'BLU',
  'أزرق غامق': 'DBL',
  'ازرق غامق': 'DBL',
  أخضر: 'GRN',
  اخضر: 'GRN',
  بني: 'BRN',
  زيتي: 'OLV',
  كشمير: 'KSH',
  نبيتي: 'BRG',
  أصفر: 'YLW',
  اصفر: 'YLW',
  لبني: 'SKY',
  سماوي: 'SKY',
  برتقالي: 'ORG',
  موف: 'PRP',
  بينك: 'PNK',
  وردي: 'PNK',
};

const CRC32_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i += 1) {
    let crc = i;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc & 1) !== 0 ? (0xedb88320 ^ (crc >>> 1)) >>> 0 : crc >>> 1;
    }
    table[i] = crc >>> 0;
  }
  return table;
})();

function crc32(buffer) {
  let crc = 0xffffffff;
  for (let i = 0; i < buffer.length; i += 1) {
    crc = CRC32_TABLE[(crc ^ buffer[i]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function escapeXml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function decodeXmlEntities(text) {
  return String(text ?? '')
    .replace(/&#x([0-9a-fA-F]+);/g, (_m, hex) => String.fromCodePoint(Number.parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_m, dec) => String.fromCodePoint(Number.parseInt(dec, 10)))
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

function columnLettersToIndex(letters) {
  let idx = 0;
  for (let i = 0; i < letters.length; i += 1) {
    idx = idx * 26 + (letters.charCodeAt(i) - 64);
  }
  return idx - 1;
}

function indexToColumnLetters(index) {
  let current = index + 1;
  let result = '';
  while (current > 0) {
    const rem = (current - 1) % 26;
    result = String.fromCharCode(65 + rem) + result;
    current = Math.trunc((current - 1) / 26);
  }
  return result;
}

function dosDateTime(date = new Date()) {
  const year = Math.max(1980, date.getUTCFullYear());
  const dosTime =
    ((date.getUTCHours() & 0x1f) << 11) |
    ((date.getUTCMinutes() & 0x3f) << 5) |
    ((Math.trunc(date.getUTCSeconds() / 2)) & 0x1f);
  const dosDate =
    (((year - 1980) & 0x7f) << 9) |
    (((date.getUTCMonth() + 1) & 0x0f) << 5) |
    (date.getUTCDate() & 0x1f);
  return { dosTime: dosTime & 0xffff, dosDate: dosDate & 0xffff };
}

function buildZipArchive(entries) {
  const { dosTime, dosDate } = dosDateTime();
  const localParts = [];
  const centralParts = [];
  let offset = 0;

  for (const entry of entries) {
    const nameBuf = Buffer.from(entry.name, 'utf8');
    const rawBuf = Buffer.isBuffer(entry.data) ? entry.data : Buffer.from(entry.data, 'utf8');
    const deflated = deflateRawSync(rawBuf, { level: 6 });
    const useDeflate = deflated.length < rawBuf.length;
    const method = useDeflate ? 8 : 0;
    const payload = useDeflate ? deflated : rawBuf;
    const checksum = crc32(rawBuf);

    const localHeader = Buffer.alloc(30);
    localHeader.writeUInt32LE(0x04034b50, 0);
    localHeader.writeUInt16LE(20, 4);
    localHeader.writeUInt16LE(0x0800, 6); // UTF-8 filename flag
    localHeader.writeUInt16LE(method, 8);
    localHeader.writeUInt16LE(dosTime, 10);
    localHeader.writeUInt16LE(dosDate, 12);
    localHeader.writeUInt32LE(checksum, 14);
    localHeader.writeUInt32LE(payload.length >>> 0, 18);
    localHeader.writeUInt32LE(rawBuf.length >>> 0, 22);
    localHeader.writeUInt16LE(nameBuf.length, 26);
    localHeader.writeUInt16LE(0, 28);

    const centralHeader = Buffer.alloc(46);
    centralHeader.writeUInt32LE(0x02014b50, 0);
    centralHeader.writeUInt16LE(20, 4);
    centralHeader.writeUInt16LE(20, 6);
    centralHeader.writeUInt16LE(0x0800, 8);
    centralHeader.writeUInt16LE(method, 10);
    centralHeader.writeUInt16LE(dosTime, 12);
    centralHeader.writeUInt16LE(dosDate, 14);
    centralHeader.writeUInt32LE(checksum, 16);
    centralHeader.writeUInt32LE(payload.length >>> 0, 20);
    centralHeader.writeUInt32LE(rawBuf.length >>> 0, 24);
    centralHeader.writeUInt16LE(nameBuf.length, 28);
    centralHeader.writeUInt16LE(0, 30);
    centralHeader.writeUInt16LE(0, 32);
    centralHeader.writeUInt16LE(0, 34);
    centralHeader.writeUInt16LE(0, 36);
    centralHeader.writeUInt32LE(0, 38);
    centralHeader.writeUInt32LE(offset >>> 0, 42);

    localParts.push(localHeader, nameBuf, payload);
    centralParts.push(centralHeader, nameBuf);
    offset += localHeader.length + nameBuf.length + payload.length;
  }

  const centralSize = centralParts.reduce((acc, part) => acc + part.length, 0);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralSize >>> 0, 12);
  eocd.writeUInt32LE(offset >>> 0, 16);
  eocd.writeUInt16LE(0, 20);

  return Buffer.concat([...localParts, ...centralParts, eocd]);
}

function extractZipEntries(zipBuffer) {
  if (!Buffer.isBuffer(zipBuffer) || zipBuffer.length < 22) {
    throw new Error('الملف المرفوع ليس ملف إكسيل (.xlsx) صالحًا');
  }
  if (zipBuffer.length > MAX_UPLOAD_BYTES) {
    throw new Error('حجم ملف الإكسيل يتجاوز الحد الأقصى المسموح به (10 ميجابايت)');
  }

  let eocdOffset = -1;
  const minScan = Math.max(0, zipBuffer.length - 65557);
  for (let pos = zipBuffer.length - 22; pos >= minScan; pos -= 1) {
    if (zipBuffer.readUInt32LE(pos) === 0x06054b50) {
      eocdOffset = pos;
      break;
    }
  }
  if (eocdOffset < 0) {
    throw new Error('تعذر قراءة فهرس ملف الإكسيل (.xlsx) — تأكد من حفظ الملف بصيغة Excel Workbook (.xlsx)');
  }

  const entryCount = zipBuffer.readUInt16LE(eocdOffset + 10);
  const centralSize = zipBuffer.readUInt32LE(eocdOffset + 12);
  const centralOffset = zipBuffer.readUInt32LE(eocdOffset + 16);

  if (entryCount > MAX_ZIP_ENTRIES) {
    throw new Error('ملف الإكسيل يحتوي على عدد عناصر غير معتاد');
  }
  if (centralOffset + centralSize > zipBuffer.length) {
    throw new Error('ملف الإكسيل تالف أو غير مكتمل');
  }

  const entries = new Map();
  let cursor = centralOffset;
  let totalUncompressed = 0;

  for (let i = 0; i < entryCount; i += 1) {
    if (cursor + 46 > zipBuffer.length || zipBuffer.readUInt32LE(cursor) !== 0x02014b50) {
      throw new Error('فهرس ملف الإكسيل غير متوافق أو تالف');
    }
    const method = zipBuffer.readUInt16LE(cursor + 10);
    const compressedSize = zipBuffer.readUInt32LE(cursor + 20);
    const uncompressedSize = zipBuffer.readUInt32LE(cursor + 24);
    const nameLen = zipBuffer.readUInt16LE(cursor + 28);
    const extraLen = zipBuffer.readUInt16LE(cursor + 30);
    const commentLen = zipBuffer.readUInt16LE(cursor + 32);
    const localOffset = zipBuffer.readUInt32LE(cursor + 42);

    const entryName = zipBuffer.subarray(cursor + 46, cursor + 46 + nameLen).toString('utf8');
    cursor += 46 + nameLen + extraLen + commentLen;

    if (entryName.endsWith('/')) continue;
    if (uncompressedSize > MAX_ENTRY_UNCOMPRESSED_BYTES) {
      throw new Error('أحد أجزاء ملف الإكسيل يتجاوز الحد الآمن للحجم');
    }

    if (localOffset + 30 > zipBuffer.length || zipBuffer.readUInt32LE(localOffset) !== 0x04034b50) {
      throw new Error('بيانات ملف الإكسيل تالفة عند موضع القراءة');
    }
    const localNameLen = zipBuffer.readUInt16LE(localOffset + 26);
    const localExtraLen = zipBuffer.readUInt16LE(localOffset + 28);
    const dataStart = localOffset + 30 + localNameLen + localExtraLen;
    const dataEnd = dataStart + compressedSize;
    if (dataEnd > zipBuffer.length) {
      throw new Error('بيانات ملف الإكسيل مبتورة');
    }

    const compressedSlice = zipBuffer.subarray(dataStart, dataEnd);
    let output;
    if (method === 0) {
      output = Buffer.from(compressedSlice);
    } else if (method === 8) {
      output = inflateRawSync(compressedSlice, { maxOutputLength: MAX_ENTRY_UNCOMPRESSED_BYTES });
    } else {
      throw new Error('طريقة ضغط غير مدعومة داخل ملف الإكسيل');
    }

    totalUncompressed += output.length;
    if (totalUncompressed > MAX_TOTAL_UNCOMPRESSED_BYTES) {
      throw new Error('إجمالي حجم البيانات المفكوكة يتجاوز الحد الآمن');
    }
    entries.set(entryName, output);
  }

  return entries;
}

export function generateOpeningInventoryTemplateXlsx() {
  const sharedStrings = [];
  const sharedIndex = new Map();
  let totalStringRefs = 0;
  const internString = (text) => {
    totalStringRefs += 1;
    const str = String(text ?? '');
    if (sharedIndex.has(str)) return sharedIndex.get(str);
    const idx = sharedStrings.length;
    sharedStrings.push(str);
    sharedIndex.set(str, idx);
    return idx;
  };

  const makeStringCell = (colIdx, rowNum, text, style = 0) => {
    const ref = `${indexToColumnLetters(colIdx)}${rowNum}`;
    const sIdx = internString(text);
    return `<c r="${ref}" t="s" s="${style}"><v>${sIdx}</v></c>`;
  };

  const makeNumberCell = (colIdx, rowNum, numStr, style = 3) => {
    const ref = `${indexToColumnLetters(colIdx)}${rowNum}`;
    return `<c r="${ref}" s="${style}"><v>${escapeXml(numStr)}</v></c>`;
  };

  // Sheet 1: Data sheet
  const sheet1Rows = [];
  const headerCells = OPENING_TEMPLATE_COLUMNS.map((col, idx) => makeStringCell(idx, 1, col.header, 1));
  sheet1Rows.push(`<row r="1" ht="28" customHeight="1">${headerCells.join('')}</row>`);

  OPENING_TEMPLATE_SAMPLE_ROWS.forEach((sample, idx) => {
    const rowNum = idx + 2;
    const cells = [
      makeStringCell(0, rowNum, sample.name, 0),
      makeStringCell(1, rowNum, sample.category, 0),
      makeStringCell(2, rowNum, sample.modelSku, 2),
      makeStringCell(3, rowNum, sample.color, 2),
      makeStringCell(4, rowNum, sample.size, 2),
      makeNumberCell(5, rowNum, String(sample.quantity), 3),
      makeNumberCell(6, rowNum, sample.unitCost, 4),
      makeNumberCell(7, rowNum, sample.retailPrice, 4),
      makeStringCell(8, rowNum, sample.barcode, 2),
      makeNumberCell(9, rowNum, String(sample.reorderPoint), 3),
      makeStringCell(10, rowNum, sample.brand, 2),
    ];
    sheet1Rows.push(`<row r="${rowNum}" ht="22" customHeight="1">${cells.join('')}</row>`);
  });

  const colDefs = OPENING_TEMPLATE_COLUMNS.map(
    (col, idx) => `<col min="${idx + 1}" max="${idx + 1}" width="${col.width}" style="${col.style}" customWidth="1"/>`,
  ).join('');

  const sheet1Xml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
  <sheetViews>
    <sheetView workbookViewId="0" rightToLeft="1">
      <pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/>
      <selection pane="bottomLeft" activeCell="A2" sqref="A2"/>
    </sheetView>
  </sheetViews>
  <sheetFormatPr defaultRowHeight="21"/>
  <cols>${colDefs}</cols>
  <sheetData>${sheet1Rows.join('')}</sheetData>
</worksheet>`;

  // Sheet 2: Clear instructions for the data entry person
  const instructionRowsData = [
    ['دليل تعبئة شيت المخزن الافتتاحي — نظام رَفّ (Raff RetailOS)', 'توضيح'],
    ['اسم الصنف', 'إلزامي — اسم المنتج كما سيظهر في الكاشير والفاتورة (مثال: قميص قطن كلاسيك).'],
    ['النوع / الفئة', 'إلزامي — نوع البضاعة مثل: قمصان رجالي، بنطلونات، أحذية، عبايات. سيتم إنشاء أي فئة جديدة تلقائيًا.'],
    ['كود الموديل', 'إلزامي — كود يجمع كل ألوان ومقاسات نفس الصنف. لو للموديل 3 ألوان و4 مقاسات، اكتب نفس اسم الصنف ونفس كود الموديل في كل صفوفه.'],
    ['اللون', 'اختياري للأصناف البسيطة، وإلزامي لو للمنتج ألوان (اكتب كل لون ومقاس في صف مستقل).'],
    ['المقاس', 'اختياري للأصناف البسيطة، وإلزامي لو للمنتج مقاسات (مثال: S / M / L / XL أو 40 / 41 / 42).'],
    ['الكمية', 'إلزامي — العدد الفعلي الموجود في المحل لهذه التركيبة من اللون والمقاس (رقم صحيح أكبر من صفر).'],
    ['سعر التكلفة (جنيه)', 'إلزامي — تكلفة شراء القطعة الواحدة بالجنيه المصري (رقم أكبر من صفر، مثال: 220 أو 220.50).'],
    ['سعر البيع (جنيه)', 'إلزامي — سعر البيع للعميل بالجنيه المصري (صفر أو أكثر، مثال: 390).'],
    ['الباركود (اختياري)', 'اختياري — إذا كان للقطعة باركود مطبوع أو ملصق جاهز اكتبه هنا، والعمود منسق كنص لمنع تحوله لصيغة علمية.'],
    ['حد إعادة الطلب', 'اختياري — أقل كمية ينبهك النظام عند الوصول إليها (الافتراضي: 0).'],
    ['الماركة (اختياري)', 'اختياري — اسم العلامة التجارية أو المصنع إن وجد.'],
    ['ملاحظة مهمة قبل الرفع', 'يمكنك تعديل أو مسح الصفوف التجريبية الموجودة في ورقة "المخزن الافتتاحي" وإدخال بضاعة محلك الفعلية مباشرة ثم رفع الملف من صفحة المخزن.'],
  ];

  const sheet2Rows = instructionRowsData.map((pair, idx) => {
    const rowNum = idx + 1;
    const styleA = idx === 0 ? 1 : 5;
    const styleB = idx === 0 ? 1 : 0;
    return `<row r="${rowNum}" ht="${idx === 0 ? 28 : 24}" customHeight="1">${makeStringCell(0, rowNum, pair[0], styleA)}${makeStringCell(1, rowNum, pair[1], styleB)}</row>`;
  });

  const sheet2Xml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
  <sheetViews>
    <sheetView workbookViewId="0" rightToLeft="1"/>
  </sheetViews>
  <sheetFormatPr defaultRowHeight="22"/>
  <cols>
    <col min="1" max="1" width="28" customWidth="1"/>
    <col min="2" max="2" width="90" customWidth="1"/>
  </cols>
  <sheetData>${sheet2Rows.join('')}</sheetData>
</worksheet>`;

  const sharedStringsXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" count="${totalStringRefs}" uniqueCount="${sharedStrings.length}">
${sharedStrings.map((text) => `<si><t xml:space="preserve">${escapeXml(text)}</t></si>`).join('')}
</sst>`;

  const stylesXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
  <numFmts count="1">
    <numFmt numFmtId="164" formatCode="#,##0.00"/>
  </numFmts>
  <fonts count="3">
    <font><sz val="11"/><name val="Arial"/></font>
    <font><b/><sz val="11"/><color rgb="FFFFFFFF"/><name val="Arial"/></font>
    <font><b/><sz val="11"/><color rgb="FF0F172A"/><name val="Arial"/></font>
  </fonts>
  <fills count="4">
    <fill><patternFill patternType="none"/></fill>
    <fill><patternFill patternType="gray125"/></fill>
    <fill><patternFill patternType="solid"><fgColor rgb="FF0F766E"/></patternFill></fill>
    <fill><patternFill patternType="solid"><fgColor rgb="FFF1F5F9"/></patternFill></fill>
  </fills>
  <borders count="2">
    <border><left/><right/><top/><bottom/><diagonal/></border>
    <border>
      <left style="thin"><color rgb="FFCBD5E1"/></left>
      <right style="thin"><color rgb="FFCBD5E1"/></right>
      <top style="thin"><color rgb="FFCBD5E1"/></top>
      <bottom style="thin"><color rgb="FFCBD5E1"/></bottom>
      <diagonal/>
    </border>
  </borders>
  <cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>
  <cellXfs count="6">
    <xf numFmtId="0" fontId="0" fillId="0" borderId="1" xfId="0" applyBorder="1" applyAlignment="1"><alignment vertical="center"/></xf>
    <xf numFmtId="0" fontId="1" fillId="2" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment horizontal="center" vertical="center" wrapText="1"/></xf>
    <xf numFmtId="49" fontId="0" fillId="0" borderId="1" xfId="0" applyNumberFormat="1" applyBorder="1" applyAlignment="1"><alignment horizontal="center" vertical="center"/></xf>
    <xf numFmtId="1" fontId="0" fillId="0" borderId="1" xfId="0" applyNumberFormat="1" applyBorder="1" applyAlignment="1"><alignment horizontal="center" vertical="center"/></xf>
    <xf numFmtId="164" fontId="0" fillId="0" borderId="1" xfId="0" applyNumberFormat="1" applyBorder="1" applyAlignment="1"><alignment horizontal="center" vertical="center"/></xf>
    <xf numFmtId="0" fontId="2" fillId="3" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment vertical="center"/></xf>
  </cellXfs>
</styleSheet>`;

  const contentTypesXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
  <Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>
  <Override PartName="/xl/worksheets/sheet2.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>
  <Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>
  <Override PartName="/xl/sharedStrings.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sharedStrings+xml"/>
</Types>`;

  const rootRelsXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>
</Relationships>`;

  const workbookXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
  <sheets>
    <sheet name="المخزن الافتتاحي" sheetId="1" r:id="rId1"/>
    <sheet name="تعليمات_التعبئة" sheetId="2" r:id="rId2"/>
  </sheets>
</workbook>`;

  const workbookRelsXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>
  <Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet2.xml"/>
  <Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>
  <Relationship Id="rId4" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/sharedStrings" Target="sharedStrings.xml"/>
</Relationships>`;

  return buildZipArchive([
    { name: '[Content_Types].xml', data: contentTypesXml },
    { name: '_rels/.rels', data: rootRelsXml },
    { name: 'xl/workbook.xml', data: workbookXml },
    { name: 'xl/_rels/workbook.xml.rels', data: workbookRelsXml },
    { name: 'xl/styles.xml', data: stylesXml },
    { name: 'xl/sharedStrings.xml', data: sharedStringsXml },
    { name: 'xl/worksheets/sheet1.xml', data: sheet1Xml },
    { name: 'xl/worksheets/sheet2.xml', data: sheet2Xml },
  ]);
}

function parseSharedStringsXml(xmlText) {
  const strings = [];
  const siRegex = /<(?:\w+:)?si\b[^>]*>([\s\S]*?)<\/(?:\w+:)?si>/g;
  let match = siRegex.exec(xmlText);
  while (match) {
    const inner = match[1].replace(/<(?:\w+:)?rPh\b[^>]*>[\s\S]*?<\/(?:\w+:)?rPh>/g, '');
    const parts = [];
    const tRegex = /<(?:\w+:)?t\b[^>]*>([\s\S]*?)<\/(?:\w+:)?t>/g;
    let tMatch = tRegex.exec(inner);
    while (tMatch) {
      parts.push(decodeXmlEntities(tMatch[1]));
      tMatch = tRegex.exec(inner);
    }
    strings.push(parts.join(''));
    match = siRegex.exec(xmlText);
  }
  return strings;
}

function parseAttributes(attrText) {
  const attrs = {};
  const attrRegex = /([\w:]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
  let m = attrRegex.exec(attrText);
  while (m) {
    attrs[m[1]] = decodeXmlEntities(m[2] ?? m[3] ?? '');
    m = attrRegex.exec(attrText);
  }
  return attrs;
}

function resolveWorkbookWorksheetPath(entries) {
  const workbookBuf = entries.get('xl/workbook.xml');
  const relsBuf = entries.get('xl/_rels/workbook.xml.rels');
  if (workbookBuf && relsBuf) {
    const workbookXml = workbookBuf.toString('utf8');
    const relsXml = relsBuf.toString('utf8');
    const relTargets = new Map();
    const relRegex = /<(?:\w+:)?Relationship\b([^>]*)\/?>(?:<\/(?:\w+:)?Relationship>)?/g;
    let relMatch = relRegex.exec(relsXml);
    while (relMatch) {
      const attrs = parseAttributes(relMatch[1]);
      if (attrs.Id && attrs.Target) {
        const cleaned = attrs.Target.replace(/\\/g, '/').replace(/^(?:\.\/|\/)+/, '');
        relTargets.set(attrs.Id, cleaned.startsWith('xl/') ? cleaned : `xl/${cleaned}`);
      }
      relMatch = relRegex.exec(relsXml);
    }

    const sheets = [];
    const sheetRegex = /<(?:\w+:)?sheet\b([^>]*)\/?>(?:<\/(?:\w+:)?sheet>)?/g;
    let sheetMatch = sheetRegex.exec(workbookXml);
    while (sheetMatch) {
      const attrs = parseAttributes(sheetMatch[1]);
      const rId = attrs['r:id'] ?? attrs.id;
      const target = rId ? relTargets.get(rId) : undefined;
      if (target && entries.has(target)) {
        sheets.push({ name: attrs.name ?? '', path: target });
      }
      sheetMatch = sheetRegex.exec(workbookXml);
    }

    if (sheets.length > 0) {
      const preferred =
        sheets.find((s) => s.name.includes('المخزن الافتتاحي')) ??
        sheets.find((s) => !s.name.includes('تعليمات')) ??
        sheets[0];
      return preferred.path;
    }
  }

  if (entries.has('xl/worksheets/sheet1.xml')) {
    return 'xl/worksheets/sheet1.xml';
  }
  const fallback = [...entries.keys()].find((key) => key.startsWith('xl/worksheets/') && key.endsWith('.xml'));
  if (!fallback) {
    throw new Error('لم يتم العثور على أي ورقة عمل داخل ملف الإكسيل');
  }
  return fallback;
}

function extractRowsFromWorksheetXml(sheetXml, sharedStrings) {
  const rows = [];
  const rowRegex = /<(?:\w+:)?row\b([^>]*)>([\s\S]*?)<\/(?:\w+:)?row>/g;
  let rowMatch = rowRegex.exec(sheetXml);
  while (rowMatch) {
    const rowAttrs = parseAttributes(rowMatch[1]);
    const rowBody = rowMatch[2];
    const rowNum = rowAttrs.r ? Number.parseInt(rowAttrs.r, 10) : rows.length + 1;
    const cells = [];
    let fallbackCol = 0;

    const cellRegex = /<(?:\w+:)?c\b([^>]*)(?:\/>|>([\s\S]*?)<\/(?:\w+:)?c>)/g;
    let cellMatch = cellRegex.exec(rowBody);
    while (cellMatch) {
      const attrs = parseAttributes(cellMatch[1]);
      const cellBody = cellMatch[2] ?? '';
      const refMatch = attrs.r ? /^([A-Za-z]+)\d+$/.exec(attrs.r) : null;
      const colIdx = refMatch ? columnLettersToIndex(refMatch[1].toUpperCase()) : fallbackCol;
      fallbackCol = colIdx + 1;

      const cellType = attrs.t ?? '';
      let rawVal = '';
      if (cellType === 'inlineStr') {
        const parts = [];
        const tRegex = /<(?:\w+:)?t\b[^>]*>([\s\S]*?)<\/(?:\w+:)?t>/g;
        let tMatch = tRegex.exec(cellBody);
        while (tMatch) {
          parts.push(decodeXmlEntities(tMatch[1]));
          tMatch = tRegex.exec(cellBody);
        }
        rawVal = parts.join('');
      } else {
        const vMatch = /<(?:\w+:)?v\b[^>]*>([\s\S]*?)<\/(?:\w+:)?v>/.exec(cellBody);
        if (vMatch) {
          const vText = decodeXmlEntities(vMatch[1]);
          if (cellType === 's') {
            const idx = Number.parseInt(vText, 10);
            rawVal = Number.isInteger(idx) && idx >= 0 && idx < sharedStrings.length ? sharedStrings[idx] : '';
          } else if (cellType === 'b') {
            rawVal = vText === '1' ? 'TRUE' : 'FALSE';
          } else {
            rawVal = vText;
          }
        }
      }

      while (cells.length <= colIdx) cells.push('');
      cells[colIdx] = String(rawVal ?? '');
      cellMatch = cellRegex.exec(rowBody);
    }

    rows.push({ rowNumber: Number.isInteger(rowNum) ? rowNum : rows.length + 1, cells });
    rowMatch = rowRegex.exec(sheetXml);
  }
  return rows;
}

function parseCsvRows(text) {
  const cleanText = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  const firstLineEnd = cleanText.indexOf('\n');
  const firstLine = firstLineEnd === -1 ? cleanText : cleanText.slice(0, firstLineEnd);
  const commaCount = (firstLine.match(/,/g) ?? []).length;
  const semiCount = (firstLine.match(/;/g) ?? []).length;
  const delimiter = semiCount > commaCount ? ';' : ',';

  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;

  for (let i = 0; i < cleanText.length; i += 1) {
    const ch = cleanText[i];
    if (inQuotes) {
      if (ch === '"') {
        if (cleanText[i + 1] === '"') {
          field += '"';
          i += 1;
        } else {
          inQuotes = false;
        }
      } else {
        field += ch;
      }
      continue;
    }

    if (ch === '"') {
      inQuotes = true;
    } else if (ch === delimiter) {
      row.push(field);
      field = '';
    } else if (ch === '\r') {
      if (cleanText[i + 1] === '\n') i += 1;
      row.push(field);
      rows.push({ rowNumber: rows.length + 1, cells: row });
      row = [];
      field = '';
    } else if (ch === '\n') {
      row.push(field);
      rows.push({ rowNumber: rows.length + 1, cells: row });
      row = [];
      field = '';
    } else {
      field += ch;
    }
  }

  if (field.length > 0 || row.length > 0) {
    row.push(field);
    rows.push({ rowNumber: rows.length + 1, cells: row });
  }
  return rows;
}

function normalizeDigits(value) {
  const arabic = '٠١٢٣٤٥٦٧٨٩';
  const persian = '۰۱۲۳۴۵۶۷۸۹';
  let out = '';
  for (const ch of String(value ?? '')) {
    const aIdx = arabic.indexOf(ch);
    if (aIdx !== -1) {
      out += String(aIdx);
      continue;
    }
    const pIdx = persian.indexOf(ch);
    if (pIdx !== -1) {
      out += String(pIdx);
      continue;
    }
    if (ch === '٫') {
      out += '.';
      continue;
    }
    out += ch;
  }
  return out;
}

function normalizeHeaderName(value) {
  return normalizeDigits(String(value ?? ''))
    .trim()
    .toLowerCase()
    .replace(/[\u064b-\u065f\u0670]/g, '')
    .replace(/[أإآ]/g, 'ا')
    .replace(/ى/g, 'ي')
    .replace(/ة/g, 'ه')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

const HEADER_ALIASES = {
  name: ['اسم الصنف', 'الصنف', 'اسم المنتج', 'المنتج', 'name', 'product name', 'item name'],
  category: ['النوع الفئه', 'النوع', 'الفئه', 'القسم', 'التصنيف', 'category', 'type'],
  modelSku: ['كود الموديل', 'الكود', 'كود الصنف', 'كود المنتج', 'sku', 'model sku', 'model code', 'code'],
  color: ['اللون', 'لون', 'color', 'colour'],
  size: ['المقاس', 'الحجم', 'مقاس', 'size'],
  quantity: ['الكميه', 'العدد', 'الرصيد', 'الرصيد الافتتاحي', 'كميه', 'qty', 'quantity'],
  unitCost: ['سعر التكلفه جنيه', 'سعر التكلفه', 'التكلفه', 'تكلفه الوحده', 'سعر الشراء', 'unit cost', 'cost price', 'cost'],
  retailPrice: ['سعر البيع جنيه', 'سعر البيع', 'سعر الجمهور', 'السعر', 'retail price', 'selling price', 'price'],
  barcode: ['الباركود اختياري', 'الباركود', 'باركود', 'barcode', 'ean'],
  reorderPoint: ['حد اعاده الطلب', 'حد التنبيه', 'الحد الادني', 'reorder point', 'reorder'],
  brand: ['الماركه اختياري', 'الماركه', 'العلامه التجاريه', 'brand'],
};

function matchColumnMapping(headerCells) {
  const columnMap = {};
  const normalizedAliasMap = new Map();
  for (const [field, aliases] of Object.entries(HEADER_ALIASES)) {
    for (const alias of aliases) {
      normalizedAliasMap.set(normalizeHeaderName(alias), field);
    }
  }

  for (let idx = 0; idx < headerCells.length; idx += 1) {
    const normalized = normalizeHeaderName(headerCells[idx]);
    if (!normalized) continue;
    const field = normalizedAliasMap.get(normalized);
    if (field && columnMap[field] === undefined) {
      columnMap[field] = idx;
    }
  }
  return columnMap;
}

function parsePositiveIntegerCell(rawValue, fieldLabel, allowZero = false) {
  const cleaned = normalizeDigits(rawValue).trim().replace(/,/g, '');
  if (!cleaned) {
    if (allowZero) return { ok: true, value: '0' };
    return { ok: false, error: `${fieldLabel} مطلوب` };
  }
  const intMatch = /^(\d+)(?:\.0+)?$/.exec(cleaned);
  if (!intMatch) {
    return { ok: false, error: `${fieldLabel} يجب أن يكون رقمًا صحيحًا بدون كسور (${rawValue})` };
  }
  const normalized = intMatch[1].replace(/^0+(?=\d)/, '');
  const bi = BigInt(normalized);
  if (!allowZero && bi <= 0n) {
    return { ok: false, error: `${fieldLabel} يجب أن يكون أكبر من صفر` };
  }
  if (bi > 999_999_999n) {
    return { ok: false, error: `${fieldLabel} كبير جدًا` };
  }
  return { ok: true, value: bi.toString() };
}

function parseMoneyCell(rawValue, fieldLabel, currency, allowZero = false) {
  const cleaned = normalizeDigits(rawValue)
    .trim()
    .replace(/ج\.?م\.?|جنيه|egp/gi, '')
    .replace(/,/g, '')
    .trim();
  if (!cleaned) {
    if (allowZero) return { ok: true, money: Money.zero(currency) };
    return { ok: false, error: `${fieldLabel} مطلوب` };
  }
  if (!/^\d+(\.\d+)?$/.test(cleaned)) {
    return { ok: false, error: `${fieldLabel} غير صالح (${rawValue})` };
  }
  const parsed = Money.fromDecimal(cleaned, currency);
  if (!allowZero && parsed.amount <= 0n) {
    return { ok: false, error: `${fieldLabel} يجب أن يكون أكبر من صفر` };
  }
  return { ok: true, money: parsed };
}

function buildSkuToken(rawValue, fallbackPrefix) {
  const trimmed = String(rawValue ?? '').trim();
  if (!trimmed) return '';
  if (COLOR_SKU_TOKENS[trimmed]) return COLOR_SKU_TOKENS[trimmed];
  const ascii = trimmed
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  if (ascii.length >= 1) return ascii.slice(0, 12);
  let hash = 0;
  for (let i = 0; i < trimmed.length; i += 1) {
    hash = (hash * 31 + trimmed.charCodeAt(i)) >>> 0;
  }
  return `${fallbackPrefix}${(hash % 900) + 100}`;
}

function buildVariantSku(modelSku, color, size, usedSkus) {
  const base = modelSku.trim().toUpperCase().slice(0, 40);
  const parts = [base];
  if (color) parts.push(buildSkuToken(color, 'C'));
  if (size) parts.push(buildSkuToken(size, 'S'));
  const candidateBase = parts.join('-').slice(0, 58);
  let candidate = candidateBase;
  let seq = 2;
  while (usedSkus.has(candidate)) {
    candidate = `${candidateBase.slice(0, 54)}-${seq}`;
    seq += 1;
  }
  usedSkus.add(candidate);
  return candidate;
}

export function parseOpeningInventorySpreadsheet(buffer, filename = 'sheet.xlsx', currency = 'EGP') {
  if (!Buffer.isBuffer(buffer) || buffer.length === 0) {
    throw new Error('الملف المرفوع فارغ');
  }
  if (buffer.length > MAX_UPLOAD_BYTES) {
    throw new Error('حجم الملف يتجاوز الحد الأقصى المسموح به (10 ميجابايت)');
  }

  const lowerName = String(filename ?? '').trim().toLowerCase();
  let rawRows;
  if (lowerName.endsWith('.csv') || (!lowerName.endsWith('.xlsx') && buffer.readUInt16LE(0) !== 0x4b50)) {
    rawRows = parseCsvRows(buffer.toString('utf8'));
  } else {
    const entries = extractZipEntries(buffer);
    const sharedStringsBuf = entries.get('xl/sharedStrings.xml');
    const sharedStrings = sharedStringsBuf ? parseSharedStringsXml(sharedStringsBuf.toString('utf8')) : [];
    const sheetPath = resolveWorkbookWorksheetPath(entries);
    const sheetXml = entries.get(sheetPath).toString('utf8');
    rawRows = extractRowsFromWorksheetXml(sheetXml, sharedStrings);
  }

  const nonEmptyRows = rawRows.filter((row) => row.cells.some((c) => String(c ?? '').trim() !== ''));
  if (nonEmptyRows.length < 2) {
    throw new Error('الشيت لا يحتوي على صفوف بيانات بعد صف العناوين');
  }

  const headerRow = nonEmptyRows[0];
  const colMap = matchColumnMapping(headerRow.cells);
  const requiredFields = [
    ['name', 'اسم الصنف'],
    ['category', 'النوع / الفئة'],
    ['modelSku', 'كود الموديل'],
    ['quantity', 'الكمية'],
    ['unitCost', 'سعر التكلفة (جنيه)'],
    ['retailPrice', 'سعر البيع (جنيه)'],
  ];
  const missingHeaders = requiredFields.filter(([field]) => colMap[field] === undefined).map(([, label]) => label);
  if (missingHeaders.length > 0) {
    throw new Error(`عناوين الأعمدة التالية مفقودة في الصف الأول: ${missingHeaders.join('، ')}`);
  }

  const dataRows = nonEmptyRows.slice(1);
  if (dataRows.length > MAX_IMPORT_ROWS) {
    throw new Error(`الحد الأقصى لعدد الصفوف في الاستيراد الواحد هو ${MAX_IMPORT_ROWS} صف`);
  }

  const errors = [];
  const parsedRows = [];
  const seenBarcodes = new Map();
  const cellAt = (cells, field) => {
    const idx = colMap[field];
    return idx === undefined ? '' : String(cells[idx] ?? '').trim();
  };

  for (const row of dataRows) {
    const rNum = row.rowNumber;
    const name = cellAt(row.cells, 'name');
    const category = cellAt(row.cells, 'category');
    const modelSkuRaw = cellAt(row.cells, 'modelSku');
    const color = cellAt(row.cells, 'color');
    const size = cellAt(row.cells, 'size');
    const qtyRes = parsePositiveIntegerCell(cellAt(row.cells, 'quantity'), 'الكمية', false);
    const costRes = parseMoneyCell(cellAt(row.cells, 'unitCost'), 'سعر التكلفة', currency, false);
    const retailRes = parseMoneyCell(cellAt(row.cells, 'retailPrice'), 'سعر البيع', currency, true);
    const barcode = cellAt(row.cells, 'barcode');
    const reorderRes = parsePositiveIntegerCell(cellAt(row.cells, 'reorderPoint'), 'حد إعادة الطلب', true);
    const brand = cellAt(row.cells, 'brand');

    const rowErrors = [];
    if (name.length < 2 || name.length > 120) rowErrors.push('اسم الصنف يجب أن يكون بين حرفين و120 حرفًا');
    if (category.length < 2 || category.length > 100) rowErrors.push('النوع / الفئة يجب أن يكون بين حرفين و100 حرف');
    if (!modelSkuRaw || modelSkuRaw.length > 48) rowErrors.push('كود الموديل مطلوب (بحد أقصى 48 حرفًا)');
    if (color.length > 64) rowErrors.push('اللون طويل جدًا (الحد الأقصى 64 حرفًا)');
    if (size.length > 64) rowErrors.push('المقاس طويل جدًا (الحد الأقصى 64 حرفًا)');
    if (!qtyRes.ok) rowErrors.push(qtyRes.error);
    if (!costRes.ok) rowErrors.push(costRes.error);
    if (!retailRes.ok) rowErrors.push(retailRes.error);
    if (!reorderRes.ok) rowErrors.push(reorderRes.error);
    if (barcode) {
      if (/[eE][+-]?\d+/.test(barcode)) {
        rowErrors.push('الباركود بصيغة علمية غير صالحة (مثل E+12) — انسخه كنص أو استخدم القالب الرسمي');
      } else if (barcode.length > 64) {
        rowErrors.push('الباركود طويل جدًا (الحد الأقصى 64 حرفًا)');
      } else {
        const prevRow = seenBarcodes.get(barcode);
        if (prevRow !== undefined) {
          rowErrors.push(`الباركود (${barcode}) مكرر مع الصف ${prevRow}`);
        } else {
          seenBarcodes.set(barcode, rNum);
        }
      }
    }

    if (rowErrors.length > 0) {
      errors.push(`صف ${rNum}: ${rowErrors.join('؛ ')}`);
      continue;
    }

    parsedRows.push({
      rowNumber: rNum,
      name,
      category,
      modelSku: modelSkuRaw.toUpperCase(),
      color,
      size,
      quantity: qtyRes.value,
      unitCostMinor: costRes.money.amount.toString(),
      retailPriceMinor: retailRes.money.amount.toString(),
      barcode: barcode || null,
      reorderPoint: reorderRes.value,
      brand: brand || null,
    });
  }

  // Group rows into products by modelSku
  const productGroupsMap = new Map();
  const usedVariantSkus = new Set();

  for (const row of parsedRows) {
    let group = productGroupsMap.get(row.modelSku);
    if (!group) {
      group = {
        firstRow: row.rowNumber,
        modelSku: row.modelSku,
        name: row.name,
        category: row.category,
        brand: row.brand,
        hasColor: Boolean(row.color),
        hasSize: Boolean(row.size),
        rows: [],
        seenCombos: new Set(),
      };
      productGroupsMap.set(row.modelSku, group);
    } else {
      if (group.name !== row.name) {
        errors.push(`صف ${row.rowNumber}: اسم الصنف (${row.name}) يختلف عن الصف ${group.firstRow} لنفس كود الموديل (${row.modelSku})`);
      }
      if (group.category !== row.category) {
        errors.push(`صف ${row.rowNumber}: الفئة (${row.category}) تختلف عن الصف ${group.firstRow} لنفس كود الموديل (${row.modelSku})`);
      }
      if (Boolean(row.color) !== group.hasColor || Boolean(row.size) !== group.hasSize) {
        errors.push(`صف ${row.rowNumber}: استخدام اللون والمقاس يجب أن يكون متسقًا في جميع صفوف الموديل (${row.modelSku})`);
      }
    }

    const comboKey = `${row.color}\u0000${row.size}`;
    if (group.seenCombos.has(comboKey)) {
      errors.push(`صف ${row.rowNumber}: التركيبة (${row.color || 'بدون لون'} / ${row.size || 'بدون مقاس'}) مكررة لنفس الموديل (${row.modelSku})`);
    } else {
      group.seenCombos.add(comboKey);
    }

    group.rows.push(row);
  }

  const products = [];
  let totalUnitsBig = 0n;
  let totalCostBig = 0n;

  for (const group of productGroupsMap.values()) {
    if (!group.hasColor && !group.hasSize && group.rows.length > 1) {
      errors.push(`صف ${group.rows[1].rowNumber}: كود الموديل (${group.modelSku}) مكرر بدون تحديد لون أو مقاس مختلف`);
    }

    const options = [];
    if (group.hasColor) {
      const colors = [...new Set(group.rows.map((r) => r.color))];
      options.push({ key: 'color', name: 'اللون', values: colors });
    }
    if (group.hasSize) {
      const sizes = [...new Set(group.rows.map((r) => r.size))];
      options.push({ key: 'size', name: 'المقاس', values: sizes });
    }

    const variants = group.rows.map((r) => {
      const qty = BigInt(r.quantity);
      const unitCost = BigInt(r.unitCostMinor);
      totalUnitsBig += qty;
      totalCostBig += qty * unitCost;
      const attributes = {};
      if (group.hasColor) attributes.color = r.color;
      if (group.hasSize) attributes.size = r.size;

      return {
        rowNumber: r.rowNumber,
        sku: buildVariantSku(group.modelSku, r.color, r.size, usedVariantSkus),
        color: r.color || null,
        size: r.size || null,
        attributes,
        quantity: r.quantity,
        unitCostMinor: r.unitCostMinor,
        retailPriceMinor: r.retailPriceMinor,
        lineCostMinor: (qty * unitCost).toString(),
        barcode: r.barcode,
        reorderPoint: r.reorderPoint,
      };
    });

    products.push({
      modelSku: group.modelSku,
      name: group.name,
      category: group.category,
      brand: group.brand,
      options,
      variants,
    });
  }

  return {
    rows: parsedRows,
    products,
    errors,
    summary: {
      rowCount: parsedRows.length,
      productCount: products.length,
      variantCount: parsedRows.length,
      categoryNames: [...new Set(parsedRows.map((r) => r.category))],
      totalUnits: totalUnitsBig.toString(),
      totalCostMinor: totalCostBig.toString(),
      totalCostFormatted: Money.fromMinor(totalCostBig, currency).toDecimalString(),
      currency,
    },
  };
}
