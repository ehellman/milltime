export type Alignment = "left" | "right";

export interface ColumnOptions {
  align?: Alignment[];
}

/** Plain-text table with a header row and columns separated by two spaces. Columns are left-aligned unless `align` says otherwise. */
export function formatTable(headers: string[], rows: string[][], options: ColumnOptions = {}): string {
  return formatColumns([headers, ...rows], options);
}

/** Aligned columns without a header. */
export function formatColumns(rows: string[][], options: ColumnOptions = {}): string {
  const widths = rows[0]?.map((_, column) => Math.max(...rows.map((row) => row[column].length))) ?? [];
  const formatRow = (row: string[]) =>
    row
      .map((cell, column) =>
        options.align?.[column] === "right" ? cell.padStart(widths[column]) : cell.padEnd(widths[column]),
      )
      .join("  ")
      .trimEnd();
  return rows.map(formatRow).join("\n");
}
