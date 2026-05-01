import fs from 'node:fs';
const path = '/home/ubuntu/auto-research-manus/server/dta-parser.ts';
let text = fs.readFileSync(path, 'utf8');
const start = text.indexOf('async function parseNewFormatAsync(');
const end = text.indexOf('/* ------------------------------------------------------------------ */\n/*  Public API', start);
if (start < 0 || end < 0) throw new Error('parseNewFormatAsync block not found');
let block = text.slice(start, end);
block = block.replace(
  '  const data: Record<string, any>[] = [];\n  const iterRows = previewMaxRows != null ? Math.min(prelude.nobs, previewMaxRows) : prelude.nobs;\n  const strlRefs: { rowIdx: number; varIdx: number; v: number; o: number }[] = [];',
  '  const data: Record<string, any>[] = [];\n  const retainMaxRows = previewMaxRows != null ? Math.min(prelude.nobs, previewMaxRows) : prelude.nobs;\n  const iterRows = options?.scanAllRows ? prelude.nobs : retainMaxRows;\n  const strlRefs: { rowIdx: number; varIdx: number; v: number; o: number }[] = [];'
);
block = block.replace(
  '          row[prelude.varlist[j]] = null;\n          strlRefs.push({ rowIdx: i, varIdx: j, v, o });',
  '          row[prelude.varlist[j]] = null;\n          if (i < retainMaxRows) strlRefs.push({ rowIdx: i, varIdx: j, v, o });'
);
block = block.replace(
  '    if (!rowOk) break;\n    data.push(row);\n  }\n\n  const remainingBytes = buf.length - offset;',
  '    if (!rowOk) break;\n    await options?.onRow?.(row, i, prelude.nobs);\n    if (data.length < retainMaxRows) {\n      data.push(row);\n    } else if (options?.scanAllRows && retainMaxRows > 0) {\n      const replacementIndex = Math.floor((i * 1103515245 + 12345) % (i + 1));\n      if (replacementIndex < retainMaxRows) data[replacementIndex] = row;\n    }\n  }\n\n  const remainingBytes = buf.length - offset;'
);
block = block.replace(
  '  await options?.onProgress?.({ rowsParsed: data.length, totalRows: prelude.nobs });',
  '  await options?.onProgress?.({ rowsParsed: iterRows, totalRows: prelude.nobs });'
);
text = text.slice(0, start) + block + text.slice(end);
fs.writeFileSync(path, text);
