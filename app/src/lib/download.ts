export function formatCsvRow(row: (string | number)[]) {
  return row.map(value => {
    let text = String(value)
    // Spreadsheet formula prefixes, including tab/CR/LF and full-width forms, after any leading spaces (L18).
    if (/^[\t\r\n]|^[  　]*[=+\-@＝＋－＠]/.test(text)) text = `'${text}`
    return `"${text.replaceAll('"', '""')}"`
  }).join(',')
}
export function downloadCsvChunks(filename: string, chunks: BlobPart[]) {
  const url = URL.createObjectURL(new Blob(['\uFEFF', ...chunks], { type: 'text/csv;charset=utf-8' }))
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = filename
  anchor.click()
  URL.revokeObjectURL(url)
}
export function downloadCsv(filename: string, rows: (string | number)[][]) {
  downloadCsvChunks(filename, [rows.map(formatCsvRow).join('\r\n')])
}
