/** Keep every declared input while bounding native command lines on Windows. */
export function fileArgumentBatches(files, maxChars) {
  const batches = []
  let current = []
  let chars = 0
  for (const file of files) {
    const required = file.length + 3
    if (current.length > 0 && chars + required > maxChars) {
      batches.push(current)
      current = []
      chars = 0
    }
    current.push(file)
    chars += required
  }
  if (current.length > 0) {
    batches.push(current)
  }
  return batches
}
